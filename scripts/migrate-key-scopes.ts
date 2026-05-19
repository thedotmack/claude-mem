#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
//
// scripts/migrate-key-scopes.ts
//
// Phase 2 / back-fill api_keys.scopes for already-bootstrapped
// server-beta deployments.
//
// Context: pre-fix bootstrap shipped scopes that did NOT intersect the
// gates on /v1/memories ('memories:read' and 'memories:write'). Every
// authenticated call to memory endpoints returned 403. Newly-issued
// keys are fixed in code, but rows already persisted in
// `api_keys.scopes` need a one-off UPDATE.
//
// USAGE (dry-run is the DEFAULT — no rows touched without --apply):
//
//   bun scripts/migrate-key-scopes.ts                          # dry-run
//   bun scripts/migrate-key-scopes.ts --apply                  # mutate
//   bun scripts/migrate-key-scopes.ts --team-id <uuid> --apply # tenant-scoped
//   bun scripts/migrate-key-scopes.ts --json                   # JSON output
//
// Environment:
//   CLAUDE_MEM_SERVER_DATABASE_URL  — required (Postgres conn string)
//
// Behaviour:
//   1. SELECT every active (non-revoked) key whose scopes array is missing
//      EITHER 'memories:read' OR 'memories:write'.
//   2. Print a diff per row (old scopes → new scopes).
//   3. With --apply, UPDATE api_keys.scopes = scopes ∪ {memories:read,
//      memories:write}, leaving any pre-existing scopes intact (additive).
//   4. Emit an audit_log row per UPDATE with action='api_key.scopes.migrate'.
//
// Defence in depth: the script never DROPS or REPLACES existing scopes —
// only adds the two memory scopes. If an operator added admin scopes
// manually, those survive.

import { createPostgresPool } from '../src/storage/postgres/pool.js';
import { parsePostgresConfig } from '../src/storage/postgres/config.js';
import type { PostgresPool } from '../src/storage/postgres/pool.js';

interface CliFlags {
  apply: boolean;
  json: boolean;
  teamId?: string;
}

function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = { apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') flags.apply = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--team-id') flags.teamId = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  return flags;
}

function printHelp(): void {
  console.log(`migrate-key-scopes.ts — back-fill api_keys.scopes for 

USAGE:
  bun scripts/migrate-key-scopes.ts [OPTIONS]

OPTIONS:
  --apply              Execute UPDATEs (default: dry-run, prints diff only)
  --team-id <uuid>     Restrict to a single team
  --json               Emit JSON instead of human-readable text
  -h, --help           Show this message

ENVIRONMENT:
  CLAUDE_MEM_SERVER_DATABASE_URL  Required Postgres connection string

EXIT CODES:
  0  success (dry-run or apply)
  1  database error or no DB URL configured
  2  bad CLI args
`);
}

const REQUIRED_SCOPES = ['memories:read', 'memories:write'] as const;

interface ApiKeyRow {
  id: string;
  team_id: string | null;
  project_id: string | null;
  actor_id: string;
  scopes: unknown;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  return [];
}

function computeMissing(existing: string[]): string[] {
  return REQUIRED_SCOPES.filter((s) => !existing.includes(s));
}

async function listAffected(
  pool: PostgresPool,
  teamId: string | undefined,
): Promise<ApiKeyRow[]> {
  const params: unknown[] = [];
  let where = 'revoked_at IS NULL';
  if (teamId) {
    params.push(teamId);
    where += ` AND team_id = $${params.length}`;
  }
  // Filter at the DB layer using JSONB containment — fast path skips
  // any key that already carries BOTH required scopes.
  params.push(JSON.stringify(REQUIRED_SCOPES));
  where += ` AND NOT (scopes @> $${params.length}::jsonb)`;
  const sql = `SELECT id, team_id, project_id, actor_id, scopes
               FROM api_keys
               WHERE ${where}
               ORDER BY created_at ASC`;
  const result = await pool.query<ApiKeyRow>(sql, params);
  return result.rows;
}

async function applyUpdate(
  pool: PostgresPool,
  row: ApiKeyRow,
  next: string[],
): Promise<void> {
  await pool.query(
    `UPDATE api_keys SET scopes = $1::jsonb, updated_at = now() WHERE id = $2`,
    [JSON.stringify(next), row.id],
  );
  // Audit-log the migration so operators can correlate the source of
  // newly-granted scopes during a later forensic review.
  await pool.query(
    `INSERT INTO audit_log (id, team_id, project_id, actor_id, api_key_id,
                             action, resource_type, resource_id, details, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4,
             'api_key.scopes.migrate', 'api_key', $4,
             $5::jsonb, now())`,
    [
      row.team_id,
      row.project_id,
      'system:migrate-key-scopes',
      row.id,
      JSON.stringify({
        source: 'scripts/migrate-key-scopes.ts',
        previous: asStringArray(row.scopes),
        next,
      }),
    ],
  );
}

interface Report {
  dryRun: boolean;
  teamFilter: string | null;
  affectedCount: number;
  appliedCount: number;
  diffs: Array<{
    apiKeyId: string;
    teamId: string | null;
    previousScopes: string[];
    missing: string[];
    nextScopes: string[];
    applied: boolean;
  }>;
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));

  const config = parsePostgresConfig({ requireDatabaseUrl: true });
  if (!config) {
    console.error(
      'CLAUDE_MEM_SERVER_DATABASE_URL is not set. Migrate cannot run without a target.',
    );
    return 1;
  }
  const pool = createPostgresPool(config);

  const report: Report = {
    dryRun: !flags.apply,
    teamFilter: flags.teamId ?? null,
    affectedCount: 0,
    appliedCount: 0,
    diffs: [],
  };

  try {
    const rows = await listAffected(pool, flags.teamId);
    report.affectedCount = rows.length;

    for (const row of rows) {
      const previous = asStringArray(row.scopes);
      const missing = computeMissing(previous);
      const next = Array.from(new Set([...previous, ...missing]));

      if (flags.apply) {
        await applyUpdate(pool, row, next);
        report.appliedCount += 1;
      }

      report.diffs.push({
        apiKeyId: row.id,
        teamId: row.team_id,
        previousScopes: previous,
        missing,
        nextScopes: next,
        applied: flags.apply,
      });
    }
  } finally {
    await pool.end().catch(() => undefined);
  }

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const verb = flags.apply ? 'APPLIED' : 'DRY-RUN';
    console.log(`[migrate-key-scopes] ${verb} — affected: ${report.affectedCount}`);
    for (const d of report.diffs) {
      const tenant = d.teamId ? `team=${d.teamId.slice(0, 8)}` : 'team=<none>';
      const missingStr = d.missing.length === 0 ? 'none' : d.missing.join(',');
      console.log(
        `  api_key=${d.apiKeyId.slice(0, 8)} ${tenant} missing=[${missingStr}]`,
      );
    }
    if (!flags.apply && report.affectedCount > 0) {
      console.log(`\nRe-run with --apply to UPDATE ${report.affectedCount} row(s).`);
    }
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[migrate-key-scopes] FATAL', err instanceof Error ? err.message : err);
    process.exit(1);
  });
