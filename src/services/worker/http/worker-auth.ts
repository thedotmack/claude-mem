import { randomBytes } from 'crypto';
import type { Database } from 'bun:sqlite';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { verifyServerApiKey } from '../../../server/auth/sqlite-api-key-service.js';
import {
  hasForwardedClientHeaders,
  isLocalhost,
  parseBearerToken,
  parseHostWithoutPort,
} from '../../../server/middleware/request-auth-helpers.js';
import { logger } from '../../../utils/logger.js';

// Worker API auth (CLAUDE_MEM_WORKER_AUTH). Modes:
//   'origin' (default) — a token is required only where the attack surface
//     actually opens: requests carrying a non-localhost Origin (a browser app
//     allowlisted via CLAUDE_MEM_WORKER_ALLOWED_ORIGINS), and originless
//     requests that are not provably local. "Provably local" needs BOTH the
//     socket peer to be loopback (a Host header is caller-controlled and says
//     nothing about where the connection came from — on a 0.0.0.0 bind a LAN
//     client can send any Host it likes) AND a Host that is localhost or an
//     IP literal (a same-origin fetch after DNS rebinding arrives FROM
//     loopback but carries the attacker's domain in Host). Hooks, curl, and
//     the bundled viewer all reach the worker over loopback and are unchanged.
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
  // When set, a valid single-use ticket in ?ticket= authenticates a request
  // to the /stream mount — the browser-safe path for native EventSource,
  // which cannot attach Authorization or X-Api-Key headers.
  streamTickets?: StreamTicketStore;
}

export const STREAM_TICKET_TTL_MS = 60_000;

// Short-lived, single-use tickets for the SSE stream. Minted by an
// authenticated request to POST /api/stream-ticket, consumed once by
// GET /stream?ticket=... — never a long-lived key in a query string, and a
// leaked URL is dead after one use or 60 seconds, whichever comes first.
export class StreamTicketStore {
  private readonly tickets = new Map<string, number>();

  issue(ttlMs: number = STREAM_TICKET_TTL_MS): string {
    const now = Date.now();
    for (const [ticket, expiresAt] of this.tickets) {
      if (expiresAt <= now) {
        this.tickets.delete(ticket);
      }
    }
    const ticket = `smt_${randomBytes(24).toString('base64url')}`;
    this.tickets.set(ticket, now + ttlMs);
    return ticket;
  }

  consume(ticket: string): boolean {
    const expiresAt = this.tickets.get(ticket);
    if (expiresAt === undefined) {
      return false;
    }
    this.tickets.delete(ticket);
    return expiresAt > Date.now();
  }
}

function isLocalhostOrigin(origin: string): boolean {
  return origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
}

// Host-shape half of the originless trust decision (the other half is the
// socket peer — see needsToken below). DNS rebinding requires an
// attacker-controlled DNS name in the Host header — a browser fetch to the
// attacker's rebound domain always carries that domain, never an IP literal —
// so localhost and IP-literal Hosts pass this check and non-localhost DNS
// names fail it. This alone proves nothing about locality: it must be
// combined with a loopback socket peer.
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

    // Forwarded-client headers mean a proxy sits between us and the real
    // client — the loopback socket peer is then the proxy, not the client,
    // so it proves nothing (same anti-proxy guard as the requireServerAuth
    // local-dev bypass).
    const origin = req.headers.origin;
    const needsToken = options.mode === 'all'
      || (origin
        ? !isLocalhostOrigin(origin)
        : !(isLocalhost(req)
          && isTrustedOriginlessHost(req.header('host') ?? '')
          && !hasForwardedClientHeaders(req)));
    if (!needsToken) {
      next();
      return;
    }

    // Native EventSource cannot set headers, so /stream accepts a single-use
    // ticket minted by an authenticated POST /api/stream-ticket.
    if (options.streamTickets && req.baseUrl === '/stream') {
      const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
      if (ticket && options.streamTickets.consume(ticket)) {
        next();
        return;
      }
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
