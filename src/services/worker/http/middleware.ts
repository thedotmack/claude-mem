
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import path from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { getPackageRoot } from '../../../shared/paths.js';
import {
  hasForwardedClientHeaders,
  isLocalhost,
  parseBearerToken,
} from '../../../server/middleware/request-auth-helpers.js';
import { logger } from '../../../utils/logger.js';

export function createMiddleware(): RequestHandler[] {
  const middlewares: RequestHandler[] = [];

  middlewares.push(express.json({ limit: '5mb' }));

  middlewares.push((req: Request, res: Response, next: NextFunction) => {
    const staticExtensions = ['.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf', '.eot'];
    const isStaticAsset = staticExtensions.some(ext => req.path.endsWith(ext));
    const isPollingEndpoint = req.path === '/api/logs'; 
    if (req.path.startsWith('/health') || req.path === '/' || isStaticAsset || isPollingEndpoint) {
      return next();
    }

    const start = Date.now();
    const requestId = `${req.method}-${Date.now()}`;

    const bodySummary = summarizeRequestBody(req.method, req.path, req.body);
    logger.debug('HTTP', `→ ${req.method} ${req.path}`, { requestId }, bodySummary);

    const originalSend = res.send.bind(res);
    res.send = function(body: any) {
      const duration = Date.now() - start;
      logger.debug('HTTP', `← ${res.statusCode} ${req.path}`, { requestId, duration: `${duration}ms` });
      return originalSend(body);
    };

    next();
  });

  const packageRoot = getPackageRoot();
  const uiDir = path.join(packageRoot, 'plugin', 'ui');
  middlewares.push(express.static(uiDir));

  return middlewares;
}

export function createCorsMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin) {
      if (!origin.startsWith('http://localhost:') && !origin.startsWith('http://127.0.0.1:')) {
        // Write the response here rather than forwarding an error. The worker never
        // calls finalizeRoutes(), so it has no terminal error handler: a
        // forwarded error lands in Express's default handler, which returns a
        // 500 HTML page containing a stack trace with absolute filesystem
        // paths. Same rule as the remote read-only guard below.
        res.status(403).json({ error: 'Forbidden', message: 'CORS not allowed' });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
      res.status(204).end();
      return;
    }
    next();
  };
}

export function requireLocalhost(req: Request, res: Response, next: NextFunction): void {
  const clientIp = req.ip || req.connection.remoteAddress || '';
  const isLocalhost =
    clientIp === '127.0.0.1' ||
    clientIp === '::1' ||
    clientIp === '::ffff:127.0.0.1' ||
    clientIp === 'localhost';

  if (!isLocalhost) {
    logger.warn('SECURITY', 'Admin endpoint access denied - not localhost', {
      endpoint: req.path,
      clientIp,
      method: req.method
    });
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin endpoints are only accessible from localhost'
    });
    return;
  }

  next();
}

// ---------------------------------------------------------------------------
// Observation TV remote read-only broadcast guard.
//
// The worker's HTTP surface has no request authentication; its only defence is
// the loopback bind. When the operator opens the bind (CLAUDE_MEM_WORKER_HOST)
// so a phone or a spare monitor can watch Observation TV, this guard is the
// whole security boundary: loopback requests are untouched, and every
// non-loopback request is default-denied except an exact-match allowlist of
// four read-only paths behind a shared secret.
//
// Allowlist only, never the inverse: the route count grows every release, and
// a list of "dangerous" routes is only a list of the ones someone remembered.
// ---------------------------------------------------------------------------

export interface RemoteReadOnlyOptions {
  /** Called per request. Empty string ⇒ this guard should never have been mounted. */
  getToken: () => string;
}

// Exact match only. No prefixes, no regular expressions: `/api/observations`
// admits `/api/observations` and nothing else, so `/api/observations/by-file`
// and `POST /api/observations/batch` are both denied. That is intended.
const REMOTE_READABLE_PATHS: ReadonlySet<string> = new Set([
  '/tv',
  '/tv.html',
  '/stream',
  '/api/observations',
]);

// One line that kills every mutation, including routes that do not exist yet
// and including `ALL /api/auth/*splat`.
const REMOTE_READABLE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * Mint an Observation TV shared secret. Same idiom as `createRawServerApiKey()`
 * but deliberately WITHOUT the `cmem_` prefix — that prefix means "a DB-backed
 * scoped API key" in this codebase, and this is not one.
 */
export function generateTvToken(): string {
  return randomBytes(32).toString('base64url');
}

function safeEqualSecret(presented: string, expected: string): boolean {
  // SHA-256 both sides to a fixed 32 bytes so lengths never leak and
  // timingSafeEqual never throws on a length mismatch, then compare in
  // constant time. Never use `===` here.
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(a, b);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('SECURITY', 'timing-safe secret comparison failed', {}, err);
    return false;
  }
}

export type RemoteAccessDecision =
  | { allow: true }
  | { allow: false; status: 403 | 404 | 401; reason: 'method' | 'path' | 'token' };

/**
 * The whole policy, as a pure function so it can be unit-tested without a
 * second network interface. The middleware below is a thin adapter over it.
 * An empty `expectedToken` denies everything — the guard should not be
 * mounted at all in that case, but it must fail closed if it is.
 */
export function decideRemoteAccess(input: {
  method: string;
  path: string;
  presentedToken: string | null;
  expectedToken: string;
}): RemoteAccessDecision {
  // 2. Method gate — before the path check, so a mutation of an allowlisted
  //    path is 403 rather than leaking that the path exists.
  if (!REMOTE_READABLE_METHODS.has(input.method.toUpperCase())) {
    return { allow: false, status: 403, reason: 'method' };
  }

  // 3. Path allowlist. 404 rather than 403 so a scanner is not told which
  //    NON-allowlisted routes exist — a probe of `/api/settings` looks the same
  //    as a probe of a path that was never mounted. It is not blanket
  //    anonymity: an unauthenticated caller still gets 401 (not 404) on the four
  //    allowlisted paths, so those are enumerable, and the 403 body on a
  //    mutation names Observation TV.
  if (!REMOTE_READABLE_PATHS.has(input.path)) {
    return { allow: false, status: 404, reason: 'path' };
  }

  // 5. Constant-time compare. A missing token, or an unconfigured expected
  //    token, denies.
  if (!input.expectedToken || !input.presentedToken) {
    return { allow: false, status: 401, reason: 'token' };
  }
  if (!safeEqualSecret(input.presentedToken, input.expectedToken)) {
    return { allow: false, status: 401, reason: 'token' };
  }

  return { allow: true };
}

// Rate-limit the denial warn so a LAN scanner cannot fill the log file: the
// first 10 denials from a client inside a rolling one-minute window are warned,
// the rest are demoted to debug. The window is what makes this a limiter rather
// than a permanent gag — without it a single port scan would silence warn-level
// alerting for that IP for the life of the worker. On overflow only entries
// whose window has already expired are evicted, never the whole map: clearing
// it wholesale would let an attacker with many source addresses restore
// warn-level logging at will. Deliberately not an abstraction.
const REMOTE_DENIAL_WARN_LIMIT = 10;
const REMOTE_DENIAL_IP_LIMIT = 512;
const REMOTE_DENIAL_WINDOW_MS = 60_000;
const remoteDenialCounts = new Map<string, { count: number; windowStart: number }>();

function logRemoteDenial(fields: { path: string; method: string; clientIp: string; reason: string }): void {
  const now = Date.now();
  let entry = remoteDenialCounts.get(fields.clientIp);
  if (entry && now - entry.windowStart > REMOTE_DENIAL_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  if (!entry) {
    if (remoteDenialCounts.size >= REMOTE_DENIAL_IP_LIMIT) {
      let oldestIp: string | null = null;
      let oldestStart = Infinity;
      for (const [ip, seen] of remoteDenialCounts) {
        if (now - seen.windowStart > REMOTE_DENIAL_WINDOW_MS) {
          remoteDenialCounts.delete(ip);
        } else if (seen.windowStart < oldestStart) {
          oldestStart = seen.windowStart;
          oldestIp = ip;
        }
      }
      // Nothing had expired — drop only the single oldest live counter so the
      // map stays bounded without handing every other IP a fresh warn budget.
      if (oldestIp !== null && remoteDenialCounts.size >= REMOTE_DENIAL_IP_LIMIT) {
        remoteDenialCounts.delete(oldestIp);
      }
    }
    entry = { count: 0, windowStart: now };
    remoteDenialCounts.set(fields.clientIp, entry);
  }
  entry.count += 1;
  if (entry.count <= REMOTE_DENIAL_WARN_LIMIT) {
    logger.warn('SECURITY', 'Remote request denied', fields);
  } else {
    logger.debug('SECURITY', 'Remote request denied', fields);
  }
}

// The query parameter exists solely because EventSource cannot set request
// headers. A repeated `?token=` arrives as an array and is not a valid request.
function readQueryToken(req: Request): string | null {
  const raw = req.query?.token;
  if (Array.isArray(raw) || typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createRemoteReadOnlyGuard(options: RemoteReadOnlyOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Loopback ⇒ untouched, always. A forwarded-client header means the
    //    request reached us through a proxy, so the socket peer is not the
    //    real client and the loopback claim is refused.
    if (isLocalhost(req) && !hasForwardedClientHeaders(req)) {
      next();
      return;
    }

    const clientIp = req.ip || req.socket.remoteAddress || '';

    // 4. Token extraction, in the house precedence: Bearer, then X-Api-Key,
    //    then the query parameter.
    const presentedToken =
      parseBearerToken(req.header('authorization') ?? '')
      || req.header('x-api-key')?.trim()
      || readQueryToken(req)
      || null;

    const decision = decideRemoteAccess({
      method: req.method,
      path: req.path,
      presentedToken,
      expectedToken: options.getToken(),
    });

    if (!decision.allow) {
      // Never log the secret or the raw query string. `req.path` excludes the
      // query string in Express, which is what makes that safe.
      logRemoteDenial({
        path: req.path,
        method: req.method,
        clientIp,
        reason: decision.reason,
      });
      // Always write the response. The worker never calls finalizeRoutes(), so
      // it has no terminal error handler — forwarding an error to Express
      // would land in its default handler and return an HTML stack page.
      if (decision.status === 404) {
        res.status(404).json({ error: 'Not found' });
      } else if (decision.status === 403) {
        res.status(403).json({
          error: 'Forbidden',
          message: 'Observation TV remote access is read-only'
        });
      } else {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing or invalid Observation TV token'
        });
      }
      return;
    }

    // 6. Pass.
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

export function summarizeRequestBody(method: string, path: string, body: any): string {
  if (!body || Object.keys(body).length === 0) return '';

  if (path.includes('/init')) {
    return '';
  }

  if (path.includes('/observations')) {
    const toolName = body.tool_name || '?';
    const toolInput = body.tool_input;
    const toolSummary = logger.formatTool(toolName, toolInput);
    return `tool=${toolSummary}`;
  }

  if (path.includes('/summarize')) {
    return 'requesting summary';
  }

  return '';
}
