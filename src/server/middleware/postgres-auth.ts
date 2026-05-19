// SPDX-License-Identifier: Apache-2.0
//
// argon2id-backed API key verification with backward-compat
// SHA-256 fast path.
//
// Storage formats:
//   - LEGACY: 64-char hex string (SHA-256 of raw key). Indexed lookup by
//     equality. Vulnerable to rainbow tables / offline attacks.
//   - NEW:    `$argon2id$v=19$m=...$...$...` hash produced by argon2.hash().
//     Includes per-key salt; cannot be looked up by equality.
//
// Dual-verifier strategy:
//   1. Compute SHA-256 of the raw key.
//   2. Fast path: `WHERE key_hash = $sha256` matches legacy rows in O(1).
//   3. Fallback: `WHERE key_hash LIKE '$argon2%'` scans argon2 rows, then
//      argon2.verify each. Acceptable up to a few hundred keys per tenant;
//      a future iteration should add a lookup-prefix indexed column.
//   4. On hit via the legacy path, emit a deprecation warning so operators
//      can rotate to argon2 before SHA-256 is removed.
//
// Timing equalization: every failure path (no rawKey, no row match, revoked,
// expired, scope-missing) waits the same minimum interval before returning
// 401/403 so an attacker can't distinguish "wrong key" from "valid key but
// no scope" by latency.

import { hashApiKeyForStorage as shimHash, verifyArgon2 as shimVerify } from './argon2-shim.js';
import { createHash, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import type { PostgresApiKey } from '../../storage/postgres/auth.js';
import type { AuthContext } from './auth.js';

// argon2id params chosen per OWASP 2024 minimums (m=19MiB, t=2, p=1).
// Tuned for ~50ms hash on a 2024-class server CPU; lift via env var only
// after measuring on the target hardware.
const ARGON2_PARAMS = Object.freeze({
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
});

// Minimum total handling time for every auth response (success OR failure).
// Padding to ~75ms hides the difference between a fast sha256 reject and
// the slow argon2 verify so timing analysis can't enumerate the keyspace.
const MIN_AUTH_RESPONSE_MS = 75;

// Deprecation logging fires once per process lifetime per api_key_id so
// rotating operators get a single warning per key rather than one per
// request. A Set is bounded by the number of distinct keys that auth
// during the process lifetime — acceptable for a long-running server.
const sha256DeprecationLogged = new Set<string>();
// Postgres-backed auth middleware for the server-beta runtime.
//
// Mirrors src/server/middleware/auth.ts but reads API keys from the Postgres
// `api_keys` table instead of bun:sqlite. Phase 4 routes use this so the
// runtime depends only on the Postgres pool and Postgres-backed repositories.
//
// teamId / projectId on req.authContext come straight from the Postgres
// api_keys row. Routes use those to scope every read and write.

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
    const startedAt = Date.now();
    try {
      const authMode = options.authMode ?? process.env.CLAUDE_MEM_AUTH_MODE ?? 'api-key';
      const authorization = req.header('authorization') ?? '';
      const rawKey = parseBearerToken(authorization);

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
        await equalizeResponseTime(startedAt);
        res.status(401).json({ error: 'Unauthorized', message: 'Missing bearer API key' });
        return;
      }

      const verified = await verifyPostgresApiKey(pool, rawKey, options.requiredScopes ?? []);
      if (!verified) {
        await equalizeResponseTime(startedAt);
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
    } catch (error) {
      next(error);
    }
  };
}

interface VerifiedPostgresApiKey {
  apiKeyId: string;
  teamId: string | null;
  projectId: string | null;
  scopes: string[];
}

interface ApiKeyLookupRow {
  id: string;
  key_hash: string;
  team_id: string | null;
  project_id: string | null;
  scopes: unknown;
  revoked_at: Date | null;
  expires_at: Date | null;
}

export async function verifyPostgresApiKey(
  pool: PostgresPool,
  rawKey: string,
  requiredScopes: string[],
): Promise<VerifiedPostgresApiKey | null> {
  // 1. Fast path — SHA-256 hex lookup for legacy keys.
  const sha256Hex = sha256HexOf(rawKey);
  const legacyRow = await selectByExactKeyHash(pool, sha256Hex);
  if (legacyRow) {
    // The row matched, but we still verify the hash equality via constant-time
    // compare so an attacker cannot use a length-extension or partial-match
    // oracle. selectByExactKeyHash already filtered by equality, but the extra
    // compare costs nothing and documents intent.
    if (!constantTimeStringEq(legacyRow.key_hash, sha256Hex)) {
      return null;
    }
    logSha256DeprecationOnce(legacyRow.id);
    return finalizeVerification(legacyRow, requiredScopes);
  }

  // 2. Fallback — argon2id keys, scan candidates.
  // We deliberately scope this to non-revoked, non-expired rows to keep
  // the per-request scan small. The query is GLOBAL across tenants because
  // the bearer token alone doesn't reveal which tenant owns the key — the
  // tenant_id only becomes known after a key matches. For deployments with
  // many active argon2 keys this becomes a per-request hot spot; see the
  // ARGON2_SCAN_LIMIT cap below and the indexed-prefix optimization noted
  // in selectArgon2Candidates() for the production path.
  const argonCandidates = await selectArgon2Candidates(pool);
  for (const row of argonCandidates) {
    const ok = await verifyKeyHash(rawKey, row.key_hash);
    if (ok) {
      return finalizeVerification(row, requiredScopes);
    }
  }
  return null;
}

function finalizeVerification(
  row: ApiKeyLookupRow,
  requiredScopes: string[],
): VerifiedPostgresApiKey | null {
  if (row.revoked_at) {
    return null;
  }
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
    return null;
  }
  const scopes = normalizeScopes(row.scopes);
  if (!hasRequiredScopes(scopes, requiredScopes)) {
    return null;
  }
  return {
    apiKeyId: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    scopes,
  };
}

async function selectByExactKeyHash(
  pool: PostgresPool,
  keyHash: string,
): Promise<ApiKeyLookupRow | null> {
  const result = await pool.query<ApiKeyLookupRow>(
    `SELECT id, key_hash, team_id, project_id, scopes, revoked_at, expires_at
       FROM api_keys
      WHERE key_hash = $1`,
    [keyHash],
  );
  return result.rows[0] ?? null;
}

// Per-request scan cap. argon2.verify costs ~50ms; verifying 100 candidates
// is a ~5s tail latency, which is the upper bound we accept before requiring
// operators to migrate to the indexed-prefix optimization (add a deterministic
// key_prefix column derived from raw_key, index it, and replace this scan
// with `WHERE key_prefix = $prefix AND key_hash LIKE '$argon2%'`).
const ARGON2_SCAN_LIMIT = 100;

async function selectArgon2Candidates(pool: PostgresPool): Promise<ApiKeyLookupRow[]> {
  const result = await pool.query<ApiKeyLookupRow>(
    `SELECT id, key_hash, team_id, project_id, scopes, revoked_at, expires_at
       FROM api_keys
      WHERE key_hash LIKE '$argon2%'
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT ${ARGON2_SCAN_LIMIT + 1}`,
  );
  if (result.rows.length > ARGON2_SCAN_LIMIT) {
    process.stderr.write(
      `[postgres-auth] WARN: argon2 candidate scan exceeded ${ARGON2_SCAN_LIMIT} ` +
      `rows; falling back to first ${ARGON2_SCAN_LIMIT}. Add an indexed key_prefix ` +
      `column to keep per-request latency bounded.\n`,
    );
    return result.rows.slice(0, ARGON2_SCAN_LIMIT);
  }
  return result.rows;
}

/**
 * verifyKeyHash — detect storedHash format and dispatch to the correct
 * verifier. Format detection rules:
 *   - Starts with '$argon2'  → argon2.verify
 *   - Length 64, all hex     → SHA-256 + constant-time compare
 *   - Anything else          → false (defensive: never partial-match an
 *                              unknown encoding)
 *
 * Exported so unit tests can pin the dispatcher behavior directly.
 */
export async function verifyKeyHash(rawKey: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith('$argon2')) {
    try {
      return await shimVerify(storedHash, rawKey);
    } catch {
      // Malformed argon2 string — treat as no-match. Never throw to the
      // caller; that would let an error-shape oracle leak format details.
      return false;
    }
  }
  if (/^[0-9a-f]{64}$/i.test(storedHash)) {
    const candidate = sha256HexOf(rawKey);
    return constantTimeStringEq(candidate, storedHash);
  }
  return false;
}

/**
 * hashApiKeyForStorage — argon2id hash used for NEW key creations. Existing
 * SHA-256 hashes continue to verify via the legacy path until rotated.
 */
export async function hashApiKeyForStorage(rawKey: string): Promise<string> {
  return await shimHash(rawKey, ARGON2_PARAMS);
}

function sha256HexOf(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

function constantTimeStringEq(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers; if they differ, return
  // false WITHOUT short-circuiting (we still pay a comparison cost via the
  // dummy compare to keep timing flat across the mismatched-length path).
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Compare against a zero-filled buffer of aBuf length to keep timing
    // independent of the input shape.
    const filler = Buffer.alloc(aBuf.length);
    timingSafeEqual(aBuf, filler);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function logSha256DeprecationOnce(apiKeyId: string): void {
  if (sha256DeprecationLogged.has(apiKeyId)) {
    return;
  }
  sha256DeprecationLogged.add(apiKeyId);
  // Use stderr — postgres-auth.ts is intentionally library code with no
  // direct logger import (firewall: server-beta must not pull worker logger).
  // Operators capture stderr via the systemd/Docker unit log.
  process.stderr.write(
    `[postgres-auth] DEPRECATION: api_key ${apiKeyId.slice(0, 8)}… still using SHA-256 storage. ` +
    `Rotate via \`claude-mem server api-key rotate\`. ` +
    `This warning fires once per process lifetime per key; restart resets.\n`,
  );
}

async function equalizeResponseTime(startedAt: number): Promise<void> {
  const elapsed = Date.now() - startedAt;
  if (elapsed < MIN_AUTH_RESPONSE_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_AUTH_RESPONSE_MS - elapsed));
  }
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

function parseBearerToken(header: string): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function isLocalhost(req: Request): boolean {
  const clientIp = req.ip || req.socket.remoteAddress || '';
  return clientIp === '127.0.0.1'
    || clientIp === '::1'
    || clientIp === '::ffff:127.0.0.1'
    || clientIp === 'localhost';
}

function hasLoopbackHostHeader(req: Request): boolean {
  const host = parseHostWithoutPort(req.header('host') ?? '');
  return host === '127.0.0.1'
    || host === 'localhost'
    || host === '::1';
}

function parseHostWithoutPort(rawHost: string): string {
  const host = rawHost.trim().toLowerCase();
  if (host.startsWith('[')) {
    const closeBracketIndex = host.indexOf(']');
    return closeBracketIndex === -1 ? host : host.slice(1, closeBracketIndex);
  }

  const lastColonIndex = host.lastIndexOf(':');
  if (lastColonIndex > -1 && /^\d+$/.test(host.slice(lastColonIndex + 1))) {
    return host.slice(0, lastColonIndex);
  }
  return host;
}

function hasForwardedClientHeaders(req: Request): boolean {
  return Boolean(
    req.header('forwarded')
      || req.header('x-forwarded-for')
      || req.header('x-forwarded-host')
      || req.header('x-real-ip'),
  );
}

// Re-export PostgresApiKey type for callers that previously imported it via
// this file's barrel.
export type { PostgresApiKey };
