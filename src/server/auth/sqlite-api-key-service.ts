// SPDX-License-Identifier: Apache-2.0
//
// SQLite-backed API key service for the local server/worker runtime. This is
// the bun:sqlite auth backend (see src/server/middleware/auth.ts). The
// Postgres-backed server-beta runtime uses a separate path
// (src/server/middleware/postgres-auth.ts).

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { Database } from 'bun:sqlite';
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

// #2541 — Salted, slow, timing-safe KDF for API-key storage.
//
// API keys were stored as unsalted single-round SHA-256, which is offline-
// crackable if the DB leaks. We replace this with node's built-in
// `crypto.scryptSync` rather than argon2 — argon2 is a native dependency that
// would break the esbuild bundle, and is not currently a project dependency.
// scryptSync satisfies #2541's requirements:
//   - SALTED:      per-key 16-byte random salt defeats rainbow tables.
//   - SLOW:        scrypt is memory-hard (N=16384) so brute force is costly.
//   - TIMING-SAFE: comparison uses constant-time crypto.timingSafeEqual.
//
// Stored format for new keys: `scrypt$<N>$<saltHex>$<derivedHex>`.
const SCRYPT_SALTED_PREFIX = 'scrypt';
const SCRYPT_COST = 16384; // N — must be a power of 2.
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

// New salted hash, used for every newly-created key.
export function hashServerApiKey(rawKey: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = scryptSync(rawKey, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST });
  return `${SCRYPT_SALTED_PREFIX}$${SCRYPT_COST}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

// Legacy unsalted SHA-256 — retained ONLY so existing keys keep verifying and
// for the worker-service legacy lookup path. Never used to write a new key.
export function hashServerApiKeyLegacySha256(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

function isSaltedHash(storedHash: string): boolean {
  return storedHash.startsWith(`${SCRYPT_SALTED_PREFIX}$`);
}

function safeEqualHex(a: string, b: string): boolean {
  // timingSafeEqual throws on length mismatch; pre-check length (lengths are
  // not secret) then compare in constant time for equal-length inputs.
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

// Timing-safe verification that detects the stored format. New keys use the
// salted scrypt scheme; legacy keys use unsalted SHA-256. Both paths compare
// in constant time.
export function verifyRawKeyAgainstStoredHash(rawKey: string, storedHash: string): boolean {
  if (isSaltedHash(storedHash)) {
    const parts = storedHash.split('$');
    if (parts.length !== 4) {
      return false;
    }
    const [, costStr, saltHex, expectedHex] = parts;
    const cost = Number.parseInt(costStr, 10);
    if (!Number.isInteger(cost) || cost <= 0) {
      return false;
    }
    let derivedHex: string;
    try {
      const salt = Buffer.from(saltHex, 'hex');
      derivedHex = scryptSync(rawKey, salt, SCRYPT_KEYLEN, { N: cost }).toString('hex');
    } catch {
      return false;
    }
    return safeEqualHex(derivedHex, expectedHex);
  }
  // Legacy unsalted SHA-256 path.
  return safeEqualHex(hashServerApiKeyLegacySha256(rawKey), storedHash);
}

// #2541 — re-hash a legacy SHA-256 key to the salted scheme. Requires the
// plaintext key, so this runs during verify (when the raw key is presented),
// transparently migrating legacy keys to the strong scheme on first use.
export function upgradeLegacyKeyHashIfNeeded(
  db: Database,
  record: ApiKey,
  rawKey: string,
): void {
  if (isSaltedHash(record.keyHash)) {
    return;
  }
  ensureServerStorageSchema(db);
  new AuthRepository(db).updateApiKeyHash(record.id, hashServerApiKey(rawKey));
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
    keyHash: hashServerApiKey(rawKey),
    prefix: rawKey.slice(0, 10),
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
  const candidates = repo.listActiveApiKeysByPrefix(rawKey.slice(0, 10));
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
