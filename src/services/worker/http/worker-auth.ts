import type { Database } from 'bun:sqlite';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { verifyServerApiKey } from '../../../server/auth/sqlite-api-key-service.js';
import { parseBearerToken, parseHostWithoutPort } from '../../../server/middleware/request-auth-helpers.js';
import { logger } from '../../../utils/logger.js';

// Worker API auth (CLAUDE_MEM_WORKER_AUTH). Modes:
//   'origin' (default) — a token is required only where the attack surface
//     actually opens: requests carrying a non-localhost Origin (a browser app
//     allowlisted via CLAUDE_MEM_WORKER_ALLOWED_ORIGINS), and originless
//     requests whose Host header is a DNS name other than localhost (the
//     DNS-rebinding shape — a same-origin fetch after rebinding carries the
//     attacker's hostname in Host). Hooks, curl, and the bundled viewer all
//     reach the worker via loopback/IP hosts with no Origin and are unchanged.
//   'all' — every covered request needs a token (hosted deployments).
//   'off' — no token checks (trusted-network opt-out).
export type WorkerAuthMode = 'origin' | 'all' | 'off';

export function parseWorkerAuthMode(value: string): WorkerAuthMode {
  const mode = value.trim().toLowerCase();
  if (mode === 'all' || mode === 'off') {
    return mode;
  }
  if (mode !== 'origin' && mode !== '') {
    logger.warn('SECURITY', `Unknown CLAUDE_MEM_WORKER_AUTH value, falling back to 'origin'`, { value });
  }
  return 'origin';
}

export interface WorkerAuthOptions {
  mode: WorkerAuthMode;
  getDatabase: () => Database;
  // Paths (relative to the mount point) that stay tokenless in every mode,
  // e.g. health probes.
  exemptPaths?: string[];
}

function isLocalhostOrigin(origin: string): boolean {
  return origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
}

// DNS rebinding requires an attacker-controlled DNS name in the Host header —
// a browser fetch to the attacker's rebound domain always carries that domain,
// never an IP literal. So originless requests are trusted when Host is
// localhost or any IP literal (hooks use 127.0.0.1, LAN setups use the bind
// IP, 0.0.0.0 resolves to loopback); only non-localhost DNS names need a token.
export function isTrustedOriginlessHost(rawHost: string): boolean {
  const host = parseHostWithoutPort(rawHost);
  if (host === 'localhost') {
    return true;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return true;
  }
  // parseHostWithoutPort strips [] from bracketed IPv6 literals; a bare
  // colon-containing host can only be an IPv6 address, never a DNS name.
  return host.includes(':');
}

export function createWorkerAuthMiddleware(options: WorkerAuthOptions): RequestHandler {
  const exemptPaths = new Set(options.exemptPaths ?? []);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (options.mode === 'off' || req.method === 'OPTIONS' || exemptPaths.has(req.path)) {
      next();
      return;
    }

    const origin = req.headers.origin;
    const needsToken = options.mode === 'all'
      || (origin ? !isLocalhostOrigin(origin) : !isTrustedOriginlessHost(req.header('host') ?? ''));
    if (!needsToken) {
      next();
      return;
    }

    const rawKey = parseBearerToken(req.header('authorization') ?? '') || req.header('x-api-key')?.trim() || null;
    if (!rawKey) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing API key (Authorization: Bearer <key> or X-Api-Key: <key>). Create one with: npx claude-mem worker api-key create',
      });
      return;
    }

    let verified;
    try {
      verified = verifyServerApiKey(options.getDatabase(), rawKey, []);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('SECURITY', 'Worker API key verification failed (database unavailable?)', { path: req.path }, err);
      res.status(503).json({ error: 'Service Unavailable', message: 'Auth backend not ready, please retry' });
      return;
    }
    if (!verified) {
      logger.warn('SECURITY', 'Worker API request with invalid API key', { path: req.path, method: req.method });
      res.status(403).json({ error: 'Forbidden', message: 'Invalid or revoked API key' });
      return;
    }

    next();
  };
}
