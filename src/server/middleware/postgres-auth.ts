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

  const verified = await verifyPostgresApiKey(pool, rawKey, options.requiredScopes ?? []);
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

export async function verifyPostgresApiKey(
  pool: PostgresPool,
  rawKey: string,
  requiredScopes: string[],
): Promise<VerifiedPostgresApiKey | null> {
  const repo = new PostgresAuthRepository(pool);
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

  let matched = await matchSalted(await repo.listApiKeysByPrefix(prefix));

  if (!matched) {
    // Legacy unsalted SHA-256 rows: deterministic lookup, constant-time
    // compare, then a transparent upgrade to the salted scheme now that the
    // plaintext is in hand (same path the SQLite backend takes, #2541).
    const legacy = await repo.getApiKeyByHash(hashApiKeyLegacySha256(rawKey));
    if (legacy && await verifyRawKeyAgainstStoredHashAsync(rawKey, legacy.keyHash)) {
      matched = legacy;
    } else if (!legacy) {
      // A concurrent request may have presented this same legacy key first and
      // re-hashed the row between our prefix lookup and the legacy lookup, at
      // which point both lookups miss and a valid key would be refused. One
      // recheck closes that window; already-attempted rows are skipped so a
      // wrong key never derives the same candidate twice.
      matched = await matchSalted(await repo.listApiKeysByPrefix(prefix));
    }
  }

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
  // Only after every check passes: upgrade a legacy row on first use.
  if (!isSaltedHash(matched.keyHash)) {
    await repo.updateApiKeyHash(matched.id, await hashApiKeyAsync(rawKey), prefix);
  }
  return {
    apiKeyId: matched.id,
    teamId: matched.teamId,
    projectId: matched.projectId,
    scopes,
  };
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
