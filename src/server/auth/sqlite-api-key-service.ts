// SPDX-License-Identifier: Apache-2.0
//
// SQLite-backed API key service for the local server/worker runtime. This is
// the bun:sqlite auth backend (see src/server/middleware/auth.ts). The
// Postgres-backed server-beta runtime uses a separate path
// (src/server/middleware/postgres-auth.ts).

import { randomBytes } from 'node:crypto';
import { Database } from 'bun:sqlite';
import {
  apiKeyPrefix,
  hashApiKey,
  hashApiKeyLegacySha256,
  isSaltedHash,
  verifyRawKeyAgainstStoredHash,
} from '../auth/api-key-hash.js';
import { AuthRepository, ensureServerStorageSchema } from '../../storage/sqlite/index.js';
import type { ApiKey } from '../../core/schemas/auth.js';

export interface CreatedServerApiKey {
  rawKey: string;
  record: ApiKey;
}

export interface VerifiedServerApiKey {
  record: ApiKey;
  teamId: string | null;
  projectId: string | null;
  scopes: string[];
}

export interface CreateServerApiKeyInput {
  name: string;
  teamId?: string | null;
  projectId?: string | null;
  scopes?: string[];
  expiresAtEpoch?: number | null;
  metadata?: Record<string, unknown>;
}

// #2428 — Default scopes for a newly-created local (SQLite-backed) API key.
//
// The local route middleware (src/server/routes/v1/ServerV1Routes.ts) gates
// reads on `memories:read` and writes on `memories:write`. A key created with
// no explicit scopes previously got `[]`, which is authorized for NOTHING — so
// a "default" key silently failed every route it was meant to serve. We
// default to the full read+write memory scope so a default key actually works
// against the routes the local runtime mounts, while NOT granting the `*`
// admin wildcard (that stays an explicit opt-in for privileged operations).
export const DEFAULT_LOCAL_API_KEY_SCOPES: readonly string[] = Object.freeze([
  'memories:read',
  'memories:write',
]);

// #2541 — the KDF itself now lives in the shared api-key-hash module (used by
// both the SQLite and Postgres backends). Re-exported under the historical
// names so existing callers and tests keep their API.
export {
  hashApiKey as hashServerApiKey,
  hashApiKeyLegacySha256 as hashServerApiKeyLegacySha256,
  verifyRawKeyAgainstStoredHash,
};

// #2541 — re-hash a legacy SHA-256 key to the salted scheme. Requires the
// plaintext key, so this runs during verify (when the raw key is presented),
// transparently migrating legacy keys to the strong scheme on first use.
// The sqlite prefix column is populated at create time, so only the hash moves.
export function upgradeLegacyKeyHashIfNeeded(
  db: Database,
  record: ApiKey,
  rawKey: string,
): void {
  if (isSaltedHash(record.keyHash)) {
    return;
  }
  ensureServerStorageSchema(db);
  new AuthRepository(db).updateApiKeyHash(record.id, hashApiKey(rawKey));
}

// #2560 seed — scope-migration helper. Re-issues the scope set on a key so an
// operator can bring legacy keys (which may have stale/empty scopes) up to a
// working default or a new scope set. Returns the updated record, or null if
// the key does not exist. Full CLI wiring is a later step.
export function migrateServerApiKeyScopes(
  db: Database,
  id: string,
  scopes: string[] = [...DEFAULT_LOCAL_API_KEY_SCOPES],
): ApiKey | null {
  ensureServerStorageSchema(db);
  return new AuthRepository(db).updateApiKeyScopes(id, scopes);
}

export function createRawServerApiKey(): string {
  return `cmem_${randomBytes(32).toString('base64url')}`;
}

export function createServerApiKey(db: Database, input: CreateServerApiKeyInput): CreatedServerApiKey {
  ensureServerStorageSchema(db);
  const rawKey = createRawServerApiKey();
  const repo = new AuthRepository(db);
  const record = repo.createApiKey({
    name: input.name,
    teamId: input.teamId ?? null,
    projectId: input.projectId ?? null,
    keyHash: hashApiKey(rawKey),
    prefix: apiKeyPrefix(rawKey),
    scopes: input.scopes ?? [...DEFAULT_LOCAL_API_KEY_SCOPES],
    expiresAtEpoch: input.expiresAtEpoch ?? null,
    metadata: input.metadata ?? {},
  });

  repo.createAuditLog({
    teamId: record.teamId,
    projectId: record.projectId,
    actorType: 'system',
    action: 'api_key.create',
    targetType: 'api_key',
    targetId: record.id,
  });

  return { rawKey, record };
}

export function verifyServerApiKey(
  db: Database,
  rawKey: string,
  requiredScopes: string[] = [],
): VerifiedServerApiKey | null {
  ensureServerStorageSchema(db);
  const repo = new AuthRepository(db);

  // Salted hashes are not deterministic per raw key, so we can no longer look
  // up by hash directly. Narrow candidates by the (non-secret) key prefix,
  // then verify the presented key against each candidate hash in constant
  // time. Local key counts are small and the prefix is highly selective.
  const candidates = repo.listActiveApiKeysByPrefix(apiKeyPrefix(rawKey));
  let record: ApiKey | null = null;
  for (const candidate of candidates) {
    if (verifyRawKeyAgainstStoredHash(rawKey, candidate.keyHash)) {
      record = candidate;
      break;
    }
  }
  if (!record) {
    return null;
  }
  if (record.expiresAtEpoch !== null && record.expiresAtEpoch <= Date.now()) {
    return null;
  }
  if (!hasRequiredScopes(record.scopes, requiredScopes)) {
    return null;
  }

  // Transparently upgrade a legacy-hashed key now that we hold the plaintext.
  upgradeLegacyKeyHashIfNeeded(db, record, rawKey);

  repo.markApiKeyUsed(record.id);
  return {
    record,
    teamId: record.teamId,
    projectId: record.projectId,
    scopes: record.scopes,
  };
}

export function listServerApiKeys(db: Database): ApiKey[] {
  ensureServerStorageSchema(db);
  return new AuthRepository(db).listApiKeys();
}

export function revokeServerApiKey(db: Database, id: string): ApiKey | null {
  ensureServerStorageSchema(db);
  const repo = new AuthRepository(db);
  const record = repo.revokeApiKey(id);
  if (record) {
    repo.createAuditLog({
      teamId: record.teamId,
      projectId: record.projectId,
      actorType: 'system',
      action: 'api_key.revoke',
      targetType: 'api_key',
      targetId: record.id,
    });
  }
  return record;
}

function hasRequiredScopes(grantedScopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0 || grantedScopes.includes('*')) {
    return true;
  }
  return requiredScopes.every(scope => grantedScopes.includes(scope));
}
