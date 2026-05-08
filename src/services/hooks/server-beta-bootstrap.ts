// SPDX-License-Identifier: Apache-2.0
//
// Phase 7 — Local API key bootstrap for the server-beta runtime.
//
// When the operator selects `runtime: "server-beta"` during install (or via
// the `claude-mem server keys rotate` command), we provision a local hook
// API key against the local Postgres so hooks can authenticate to /v1/*.
//
// Bootstrapping flow:
//   1. Connect to Postgres (CLAUDE_MEM_SERVER_DATABASE_URL).
//   2. Find or create a "local-hook" team and project so the api_key has
//      proper tenant scope.
//   3. Generate a `cmem_<random>` key, hash with SHA-256, insert into
//      `api_keys` with the scopes hooks need: events:write, sessions:write,
//      observations:read, jobs:read.
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
import { PostgresProjectsRepository } from '../../storage/postgres/projects.js';
import { PostgresTeamsRepository } from '../../storage/postgres/teams.js';

const LOCAL_HOOK_TEAM_NAME = 'local-hook-team';
const LOCAL_HOOK_PROJECT_NAME = 'local-hook-project';
const LOCAL_HOOK_ACTOR_ID = 'system:local-hook-bootstrap';

export const HOOK_API_KEY_SCOPES: readonly string[] = Object.freeze([
  'events:write',
  'sessions:write',
  'observations:read',
  'jobs:read',
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
    const keyHash = hashApiKey(rawKey);

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

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

async function findOrCreateTeam(pool: PostgresPool): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM teams WHERE name = $1 LIMIT 1`,
    [LOCAL_HOOK_TEAM_NAME],
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }
  const repo = new PostgresTeamsRepository(pool);
  const team = await repo.create({ name: LOCAL_HOOK_TEAM_NAME, metadata: { source: 'local-hook-bootstrap' } });
  return team.id;
}

async function findOrCreateProject(pool: PostgresPool, teamId: string): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM projects WHERE team_id = $1 AND name = $2 LIMIT 1`,
    [teamId, LOCAL_HOOK_PROJECT_NAME],
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }
  const repo = new PostgresProjectsRepository(pool);
  const project = await repo.create({
    teamId,
    name: LOCAL_HOOK_PROJECT_NAME,
    metadata: { source: 'local-hook-bootstrap' },
  });
  return project.id;
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
