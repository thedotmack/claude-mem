// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import type { PostgresApiKey } from '../../storage/postgres/auth.js';
import type { AuthContext } from './auth.js';

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
        res.status(401).json({ error: 'Unauthorized', message: 'Missing bearer API key' });
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

export async function verifyPostgresApiKey(
  pool: PostgresPool,
  rawKey: string,
  requiredScopes: string[],
): Promise<VerifiedPostgresApiKey | null> {
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const result = await pool.query(
    `
      SELECT id, team_id, project_id, scopes, revoked_at, expires_at
      FROM api_keys
      WHERE key_hash = $1
    `,
    [keyHash],
  );
  const row = result.rows[0] as Pick<
    PostgresApiKey,
    'id' | 'teamId' | 'projectId'
  > & {
    id: string;
    team_id: string | null;
    project_id: string | null;
    scopes: unknown;
    revoked_at: Date | null;
    expires_at: Date | null;
  } | undefined;
  if (!row) {
    return null;
  }
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
