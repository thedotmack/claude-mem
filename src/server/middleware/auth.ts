// SPDX-License-Identifier: Apache-2.0

import type { Database } from 'bun:sqlite';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { verifyServerApiKey } from '../auth/api-key-service.js';

export interface AuthContext {
  userId: string | null;
  organizationId: string | null;
  teamId: string | null;
  projectId: string | null;
  scopes: string[];
  apiKeyId: string | null;
  mode: 'api-key' | 'local-dev';
}

declare module 'express-serve-static-core' {
  interface Request {
    authContext?: AuthContext;
  }
}

export interface RequireAuthOptions {
  requiredScopes?: string[];
  authMode?: string;
}

export function requireServerAuth(
  getDatabase: () => Database,
  options: RequireAuthOptions = {},
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const authMode = options.authMode ?? process.env.CLAUDE_MEM_AUTH_MODE ?? 'api-key';
    const authorization = req.header('authorization') ?? '';
    const rawKey = parseBearerToken(authorization);

    if (!rawKey && authMode === 'local-dev' && isLocalhost(req)) {
      req.authContext = {
        userId: null,
        organizationId: null,
        teamId: null,
        projectId: null,
        scopes: ['*'],
        apiKeyId: null,
        mode: 'local-dev',
      };
      next();
      return;
    }

    if (!rawKey) {
      res.status(401).json({ error: 'Unauthorized', message: 'Missing bearer API key' });
      return;
    }

    const verified = verifyServerApiKey(getDatabase(), rawKey, options.requiredScopes ?? []);
    if (!verified) {
      res.status(403).json({ error: 'Forbidden', message: 'Invalid API key or insufficient scope' });
      return;
    }

    req.authContext = {
      userId: null,
      organizationId: null,
      teamId: verified.teamId,
      projectId: verified.projectId,
      scopes: verified.scopes,
      apiKeyId: verified.record.id,
      mode: 'api-key',
    };
    next();
  };
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
