// SPDX-License-Identifier: Apache-2.0
//
// Local API key bootstrap for the server-beta runtime.
//
// When the operator selects `runtime: "server-beta"` during install (or via
// the `claude-mem server keys rotate` command), we provision a local hook
// API key against the local Postgres so hooks can authenticate to /v1/*.
//
// Bootstrapping flow:
//   1. Connect to Postgres (CLAUDE_MEM_SERVER_DATABASE_URL).
//   2. Find or create a "local-hook" team and project so the api_key has
//      proper tenant scope.
//   3. Generate a `cmem_<random>` key, hash via hashApiKeyForStorage()
//      (argon2id), insert into `api_keys` with scopes that match the gates
//      declared on /v1/memories. See routes/v1/ServerV1PostgresRoutes.ts
//      which gates reads on 'memories:read' and writes on 'memories:write'.
//
//      Bug 3 fix: previously this list shipped events:write / sessions:write /
//      observations:read / jobs:read — none of which intersect the memory
//      gates, so every hook call to POST /v1/memories returned 403 until an
//      operator ran a manual SQL UPDATE on the api_keys.scopes array.
//   4. Persist the plaintext key to ~/.claude-mem/settings.json under
//      `CLAUDE_MEM_SERVER_BETA_API_KEY`, then chmod that file to 0600 so
//      only the owner can read it.
//
// The plaintext key is NEVER written into the generated bundle and never
// logged.

import { createHash, randomBytes } from 'crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createPostgresPool, type PostgresPool } from '../../storage/postgres/pool.js';
import { parsePostgresConfig } from '../../storage/postgres/config.js';
import { PostgresAuthRepository } from '../../storage/postgres/auth.js';
import { newId } from '../../storage/postgres/utils.js';
import { hashApiKeyForStorage } from '../../server/middleware/postgres-auth.js';

const LOCAL_HOOK_TEAM_NAME = 'local-hook-team';
const LOCAL_HOOK_PROJECT_NAME = 'local-hook-project';
const LOCAL_HOOK_ACTOR_ID = 'system:local-hook-bootstrap';

// fix: default scopes are the union of what /v1/memories actually
// requires. The complementary unit test at tests/server-beta/
// hook-scopes-vs-routes.test.ts greps the routes for `requiredScopes` and
// asserts this set is a superset.
export const HOOK_API_KEY_SCOPES: readonly string[] = Object.freeze([
  'memories:read',
  'memories:write',
]);

export interface BootstrapResult {
  rawKey: string;
  apiKeyId: string;
  teamId: string;
  projectId: string;
}

export interface BootstrapDependencies {
  pool?: PostgresPool;
  // For tests: skip pool.end() because the caller owns lifecycle.
  closePool?: boolean;
}

export async function bootstrapServerBetaApiKey(
  deps: BootstrapDependencies = {},
): Promise<BootstrapResult> {
  const closePool = deps.closePool ?? deps.pool === undefined;
  const pool = deps.pool ?? buildPoolFromEnv();

  try {
    const teamId = await findOrCreateTeam(pool);
    const projectId = await findOrCreateProject(pool, teamId);

    const rawKey = createRawApiKey();
    // fix: NEW keys hash via argon2id (per-key salt, expensive verify).
    // Existing SHA-256 rows continue to verify through the legacy path in
    // src/server/middleware/postgres-auth.ts until rotated.
    const keyHash = await hashApiKeyForStorage(rawKey);

    const repo = new PostgresAuthRepository(pool);
    const created = await repo.createApiKey({
      keyHash,
      teamId,
      projectId,
      actorId: LOCAL_HOOK_ACTOR_ID,
      scopes: [...HOOK_API_KEY_SCOPES],
    });
    await repo.createAuditLog({
      teamId,
      projectId,
      actorId: LOCAL_HOOK_ACTOR_ID,
      apiKeyId: created.id,
      action: 'api_key.create',
      resourceType: 'api_key',
      resourceId: created.id,
      details: { source: 'server-beta-bootstrap' },
    });

    return {
      rawKey,
      apiKeyId: created.id,
      teamId,
      projectId,
    };
  } finally {
    if (closePool) {
      await pool.end().catch(() => undefined);
    }
  }
}

export interface RotateOptions {
  previousApiKeyId?: string | null;
  pool?: PostgresPool;
}

export async function rotateServerBetaApiKey(options: RotateOptions = {}): Promise<BootstrapResult> {
  const closePool = options.pool === undefined;
  const pool = options.pool ?? buildPoolFromEnv();
  try {
    if (options.previousApiKeyId) {
      await pool.query(
        `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
        [options.previousApiKeyId],
      );
    }
    return await bootstrapServerBetaApiKey({ pool, closePool: false });
  } finally {
    if (closePool) {
      await pool.end().catch(() => undefined);
    }
  }
}

export function persistServerBetaSettings(
  settingsPath: string,
  values: { apiKey: string; projectId: string; serverBaseUrl?: string },
): void {
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  // Settings file format: prefer the flat shape (modern). The migration in
  // SettingsDefaultsManager.loadFromFile already collapses nested → flat.
  const flat = (existing.env && typeof existing.env === 'object'
    ? existing.env
    : existing) as Record<string, unknown>;

  flat.CLAUDE_MEM_SERVER_BETA_API_KEY = values.apiKey;
  flat.CLAUDE_MEM_SERVER_BETA_PROJECT_ID = values.projectId;
  if (values.serverBaseUrl) {
    flat.CLAUDE_MEM_SERVER_BETA_URL = values.serverBaseUrl;
  }

  writeFileSync(settingsPath, JSON.stringify(flat, null, 2), 'utf-8');
  // Hooks read this file on every invocation; restrict permissions so other
  // local users cannot read the API key.
  try {
    chmodSync(settingsPath, 0o600);
  } catch {
    // Non-POSIX filesystems may reject chmod; settings file remains readable.
  }
}

export function createRawApiKey(): string {
  return `cmem_${randomBytes(32).toString('base64url')}`;
}

// hashApiKey — legacy SHA-256 helper retained for tools that need to derive
// a lookup hash against PRE-BUG-19 keys (e.g. `claude-mem server api-key`
// existence checks issued by the CLI against legacy installs). NEW keys
// MUST go through hashApiKeyForStorage (argon2id). See .
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

// hashApiKeyForStorage — argon2id hash used by every new key creation path.
// Imported above from the canonical implementation in postgres-auth.ts;
// re-exported here for external callers that consume the bootstrap surface.
export { hashApiKeyForStorage };

// findOrCreateTeam — race-free upsert against the local-hook team row.
//
// Pre-Phase-2 this was a SELECT-then-INSERT (TOCTOU), which could create
// duplicate teams under concurrent first-run races and would then violate
// the v2 UNIQUE(name) constraint on subsequent boots. We now rely on the
// v2 UNIQUE index `idx_teams_name_unique` and use INSERT ... ON CONFLICT
// DO UPDATE so that the RETURNING clause always yields the persisted row.
// DO UPDATE with a no-op `name = EXCLUDED.name` is required because
// DO NOTHING + RETURNING does NOT return rows for conflicting inserts.
async function findOrCreateTeam(pool: PostgresPool): Promise<string> {
  const id = newId();
  const row = await pool.query<{ id: string }>(
    `
      INSERT INTO teams (id, name, metadata)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (name) DO UPDATE
        SET name = EXCLUDED.name
      RETURNING id
    `,
    [id, LOCAL_HOOK_TEAM_NAME, JSON.stringify({ source: 'local-hook-bootstrap' })],
  );
  if (!row.rows[0]) {
    // Should be unreachable: ON CONFLICT DO UPDATE always returns a row.
    // Fallback select for hardening.
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM teams WHERE name = $1 LIMIT 1`,
      [LOCAL_HOOK_TEAM_NAME],
    );
    if (!existing.rows[0]) {
      throw new Error('findOrCreateTeam: upsert returned no row');
    }
    return existing.rows[0].id;
  }
  return row.rows[0].id;
}

// findOrCreateProject — race-free upsert scoped to the team.
// Relies on the v2 UNIQUE(team_id, name) index `idx_projects_team_id_name_unique`.
async function findOrCreateProject(pool: PostgresPool, teamId: string): Promise<string> {
  const id = newId();
  const row = await pool.query<{ id: string }>(
    `
      INSERT INTO projects (id, team_id, name, metadata)
      VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (team_id, name) DO UPDATE
        SET name = EXCLUDED.name
      RETURNING id
    `,
    [id, teamId, LOCAL_HOOK_PROJECT_NAME, JSON.stringify({ source: 'local-hook-bootstrap' })],
  );
  if (!row.rows[0]) {
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM projects WHERE team_id = $1 AND name = $2 LIMIT 1`,
      [teamId, LOCAL_HOOK_PROJECT_NAME],
    );
    if (!existing.rows[0]) {
      throw new Error('findOrCreateProject: upsert returned no row');
    }
    return existing.rows[0].id;
  }
  return row.rows[0].id;
}

function buildPoolFromEnv(): PostgresPool {
  const config = parsePostgresConfig({ requireDatabaseUrl: true });
  if (!config) {
    throw new Error(
      'Cannot bootstrap server-beta API key: CLAUDE_MEM_SERVER_DATABASE_URL is not set.',
    );
  }
  return createPostgresPool(config);
}
