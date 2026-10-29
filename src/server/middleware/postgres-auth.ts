// SPDX-License-Identifier: Apache-2.0

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import type { PostgresApiKey } from '../../storage/postgres/auth.js';
import { PostgresAuthRepository } from '../../storage/postgres/auth.js';
import type { AuthContext } from './auth.js';
import {
  apiKeyPrefix,
  hashApiKeyLegacySha256,
  hashApiKeyAsync,
  isSaltedHash,
  ScryptQueueFullError,
  verifyRawKeyAgainstStoredHashAsync,
} from '../auth/api-key-hash.js';
import {
  hasForwardedClientHeaders,
  hasLoopbackHostHeader,
  isLocalhost,
  parseBearerToken,
} from './request-auth-helpers.js';
import { logger } from '../../utils/logger.js';

// Postgres-backed auth middleware for the server-beta runtime.
//
// Mirrors src/server/middleware/auth.ts but reads API keys from the Postgres
// `api_keys` table instead of bun:sqlite. Phase 4 routes use this so the
// runtime depends only on the Postgres pool and Postgres-backed repositories.
//
// teamId / projectId on req.authContext come straight from the Postgres
// api_keys row. Routes use those to scope every read and write.
//
// #2541 — key verification is a dual verifier: new keys are stored as salted
// scrypt hashes (`scrypt$N$salt$derived`, non-deterministic per raw key), so
// candidates are narrowed by the raw key's non-secret prefix and each is
// verified in constant time. Legacy rows still hold unsalted SHA-256 digests,
// which are looked up deterministically and transparently re-hashed to the
// salted scheme on their first successful verify.

export interface PostgresRequireAuthOptions {
  requiredScopes?: string[];
  authMode?: string;
  allowLocalDevBypass?: boolean;
  // Local-dev fallback team for unauthenticated loopback requests. This is
  // only used when authMode === 'local-dev' AND allowLocalDevBypass is true
  // AND the request is on loopback. It must NEVER be used to scope a real
  // production request.
  localDevTeamId?: string | null;
}

export function requirePostgresServerAuth(
  pool: PostgresPool,
  options: PostgresRequireAuthOptions = {},
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await authenticatePostgresRequest(pool, options, req, res, next);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('HTTP', 'postgres auth middleware failed', { path: req.path }, err);
      next(error);
    }
  };
}

async function authenticatePostgresRequest(
  pool: PostgresPool,
  options: PostgresRequireAuthOptions,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authMode = options.authMode ?? process.env.CLAUDE_MEM_AUTH_MODE ?? 'api-key';
  const authorization = req.header('authorization') ?? '';
  const xApiKey = req.header('x-api-key')?.trim() ?? '';
  // Bearer is canonical; raw X-Api-Key is a fallback so clients using
  // @better-auth/api-key defaults (e.g. the worker bundle shipped from the
  // Windows-canary line) authenticate without a per-client custom config.
  const rawKey = parseBearerToken(authorization) || xApiKey || null;

  const allowLocalDevBypass = options.allowLocalDevBypass
    ?? process.env.CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS === '1';
  if (
    !rawKey
    && authMode === 'local-dev'
    && allowLocalDevBypass
    && isLocalhost(req)
    && hasLoopbackHostHeader(req)
    && !hasForwardedClientHeaders(req)
  ) {
    const ctx: AuthContext = {
      userId: null,
      organizationId: null,
      teamId: options.localDevTeamId ?? null,
      projectId: null,
      scopes: ['local-dev'],
      apiKeyId: null,
      mode: 'local-dev',
    };
    req.authContext = ctx;
    next();
    return;
  }

  if (!rawKey) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing API key (Authorization: Bearer <key> or X-Api-Key: <key>)',
    });
    return;
  }

  let verified: VerifiedPostgresApiKey | null;
  try {
    verified = await verifyPostgresApiKey(pool, rawKey, options.requiredScopes ?? []);
  } catch (error) {
    if (error instanceof ScryptQueueFullError) {
      logger.warn('HTTP', 'API key verification queue full; refusing request', { path: req.path });
      res.setHeader('Retry-After', '1');
      res.status(503).json({ error: 'Service Unavailable', message: error.message });
      return;
    }
    throw error;
  }
  if (!verified) {
    res.status(403).json({ error: 'Forbidden', message: 'Invalid API key or insufficient scope' });
    return;
  }

  const ctx: AuthContext = {
    userId: null,
    organizationId: null,
    teamId: verified.teamId,
    projectId: verified.projectId,
    scopes: verified.scopes,
    apiKeyId: verified.apiKeyId,
    mode: 'api-key',
  };
  req.authContext = ctx;
  next();
}

interface VerifiedPostgresApiKey {
  apiKeyId: string;
  teamId: string | null;
  projectId: string | null;
  scopes: string[];
}

// Verified-key cache: sha256(rawKey) -> the row id and the stored salted hash
// this raw key was proven to derive to. A hit re-reads that row by id (one
// indexed query, the same per-request cost as the old SHA-256 lookup) and is
// honored only while the row still holds that exact hash, so revocation,
// expiry, scope edits and re-hashing take effect on the very next request
// with no TTL window. Valid keys therefore pay scrypt once per process, not
// once per request. Scoped per pool so two databases never share entries.
interface CachedKeyProof {
  apiKeyId: string;
  keyHash: string;
}
// Abuse/memory protection: entries are only added after a successful verify,
// so the count tracks distinct valid keys in use. 10,000 covers far more live
// keys than a self-hosted team server mints; past it the oldest entry is
// evicted, which costs that key one more scrypt derivation, never a refusal.
const VERIFIED_KEY_CACHE_MAX_ENTRIES = 10_000;
const verifiedKeyCacheByPool = new WeakMap<PostgresPool, Map<string, CachedKeyProof>>();
const inFlightVerificationsByPool = new WeakMap<PostgresPool, Map<string, Promise<PostgresApiKey | null>>>();

function poolScopedMap<T>(store: WeakMap<PostgresPool, Map<string, T>>, pool: PostgresPool): Map<string, T> {
  let map = store.get(pool);
  if (!map) {
    map = new Map();
    store.set(pool, map);
  }
  return map;
}

function rememberVerifiedKey(pool: PostgresPool, rawKeyDigest: string, proof: CachedKeyProof): void {
  const cache = poolScopedMap(verifiedKeyCacheByPool, pool);
  cache.delete(rawKeyDigest);
  if (cache.size >= VERIFIED_KEY_CACHE_MAX_ENTRIES) {
    const oldestDigest = cache.keys().next().value;
    if (oldestDigest !== undefined) cache.delete(oldestDigest);
    logger.debug('HTTP', 'verified API key cache full; evicted the oldest entry', {
      maxEntries: VERIFIED_KEY_CACHE_MAX_ENTRIES,
    });
  }
  cache.set(rawKeyDigest, proof);
}

export async function verifyPostgresApiKey(
  pool: PostgresPool,
  rawKey: string,
  requiredScopes: string[],
): Promise<VerifiedPostgresApiKey | null> {
  const repo = new PostgresAuthRepository(pool);
  const matched = await resolveApiKeyRow(pool, repo, rawKey);

  if (!matched) {
    return null;
  }
  if (matched.revokedAtEpoch !== null) {
    return null;
  }
  if (matched.expiresAtEpoch !== null && matched.expiresAtEpoch <= Date.now()) {
    return null;
  }
  const scopes = normalizeScopes(matched.scopes);
  if (!hasRequiredScopes(scopes, requiredScopes)) {
    return null;
  }
  return {
    apiKeyId: matched.id,
    teamId: matched.teamId,
    projectId: matched.projectId,
    scopes,
  };
}

/**
 * The api_keys row this raw key belongs to, or null. Cached proofs are checked
 * against a fresh read of the row; otherwise concurrent requests for the same
 * raw key share one derivation (single flight) instead of each running scrypt.
 */
async function resolveApiKeyRow(
  pool: PostgresPool,
  repo: PostgresAuthRepository,
  rawKey: string,
): Promise<PostgresApiKey | null> {
  const rawKeyDigest = hashApiKeyLegacySha256(rawKey);
  const cache = poolScopedMap(verifiedKeyCacheByPool, pool);
  const cached = cache.get(rawKeyDigest);
  if (cached) {
    const row = await repo.getApiKeyById(cached.apiKeyId);
    if (row && row.keyHash === cached.keyHash) {
      return row;
    }
    cache.delete(rawKeyDigest);
  }

  const inFlight = poolScopedMap(inFlightVerificationsByPool, pool);
  const pending = inFlight.get(rawKeyDigest);
  if (pending) {
    return pending;
  }
  const verification = deriveAndMatchApiKeyRow(repo, rawKey).then(row => {
    if (row && isSaltedHash(row.keyHash)) {
      rememberVerifiedKey(pool, rawKeyDigest, { apiKeyId: row.id, keyHash: row.keyHash });
    }
    return row;
  });
  inFlight.set(rawKeyDigest, verification);
  try {
    return await verification;
  } finally {
    inFlight.delete(rawKeyDigest);
  }
}

async function deriveAndMatchApiKeyRow(repo: PostgresAuthRepository, rawKey: string): Promise<PostgresApiKey | null> {
  const prefix = apiKeyPrefix(rawKey);

  // Salted scrypt hashes are not deterministic per raw key, so narrow by the
  // (non-secret) prefix and verify each candidate in constant time. The query
  // returns only active rows and is LIMITed, so a caller who knows a prefix
  // can force at most that many async derivations per request — never one for
  // a revoked or expired row, and never an unbounded scan.
  const attempted = new Set<string>();
  const matchSalted = async (rows: PostgresApiKey[]): Promise<PostgresApiKey | null> => {
    for (const candidate of rows) {
      if (attempted.has(candidate.id)) continue;
      attempted.add(candidate.id);
      if (isSaltedHash(candidate.keyHash) && await verifyRawKeyAgainstStoredHashAsync(rawKey, candidate.keyHash)) {
        return candidate;
      }
    }
    return null;
  };

  const salted = await matchSalted(await repo.listApiKeysByPrefix(prefix));
  if (salted) {
    return salted;
  }

  // Legacy unsalted SHA-256 rows: deterministic lookup, constant-time
  // compare, then a transparent upgrade to the salted scheme now that the
  // plaintext is in hand (same path the SQLite backend takes, #2541).
  const legacy = await repo.getApiKeyByHash(hashApiKeyLegacySha256(rawKey));
  if (!legacy) {
    // A concurrent request may have presented this same legacy key first and
    // re-hashed the row between our prefix lookup and the legacy lookup, at
    // which point both lookups miss and a valid key would be refused. One
    // recheck closes that window; already-attempted rows are skipped so a
    // wrong key never derives the same candidate twice.
    return matchSalted(await repo.listApiKeysByPrefix(prefix));
  }
  if (!await verifyRawKeyAgainstStoredHashAsync(rawKey, legacy.keyHash)) {
    return null;
  }
  const legacyIsUsable = legacy.revokedAtEpoch === null
    && (legacy.expiresAtEpoch === null || legacy.expiresAtEpoch > Date.now());
  if (!legacyIsUsable) {
    return legacy; // the caller refuses it; a dead key is never re-hashed
  }
  const upgradedHash = await hashApiKeyAsync(rawKey);
  await repo.updateApiKeyHash(legacy.id, upgradedHash, prefix);
  return { ...legacy, keyHash: upgradedHash, keyPrefix: prefix };
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function hasRequiredScopes(grantedScopes: string[], requiredScopes: string[]): boolean {
  if (requiredScopes.length === 0 || grantedScopes.includes('*')) {
    return true;
  }
  return requiredScopes.every(scope => grantedScopes.includes(scope));
}
