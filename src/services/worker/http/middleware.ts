
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import path from 'path';
import { isIP } from 'net';
import { getPackageRoot } from '../../../shared/paths.js';
import { readdirSync, type Dirent } from 'fs';
import {
  decideLocalApiAccess,
  extractLocalApiToken,
} from '../../../shared/local-api-token.js';
import {
  isLocalhost,
  parseHostWithoutPort,
} from '../../../server/middleware/request-auth-helpers.js';
import { logger } from '../../../utils/logger.js';
import {
  isLocalhostOrigin,
  isOwnPageOrigin,
  isSameHostOrigin,
  type WorkerOriginPolicy,
} from './origin-policy.js';
import { redactForLog } from '../../../utils/redaction.js';
import { scanMediaFields } from '../../../shared/media-ingress.js';
import { WORKER_JSON_BODY_LIMIT_BYTES } from '../../../shared/worker-http-limits.js';

/**
 * Every worker response refuses framing. The viewer can delete observations
 * and save settings, and its requests are same-origin, so a hostile page that
 * frames it could harvest real clicks through an overlay.
 *
 * It is set on every response, not per page: a per-page check on `req.path`
 * misses the URLs the static mounts decode and normalize to the same file
 * (`/viewer%2Ehtml`, `/%76iewer.html`, `//viewer.html`, and `/Viewer.html` on
 * a case-insensitive disk).
 */
export function refuseFraming(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

export function createMiddleware(): RequestHandler[] {
  // First, so it covers both static UI mounts and every route after them.
  const middlewares: RequestHandler[] = [refuseFraming];

  const parseJson = express.json({ limit: WORKER_JSON_BODY_LIMIT_BYTES });
  middlewares.push((req: Request, res: Response, next: NextFunction) => {
    // Spool ingestion authenticates before applying its own body limit.
    if (req.method === 'POST' && /^\/api\/spool\/ingest\/?$/i.test(req.path)) return next();
    parseJson(req, res, next);
  });

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

export {
  buildWorkerOriginPolicy,
  isLocalhostOrigin,
  isOwnPageOrigin,
  parseAllowedOriginsSetting,
  type WorkerOriginPolicy,
} from './origin-policy.js';

/**
 * Refuses a DELETE sent by a browser page other than the worker's own (see
 * isOwnPageOrigin). Deletes are tombstoned for cloud sync, so a page that CORS
 * lets read the API (any http://localhost:* page) must not be able to remove
 * memories on every device. Reads stay open to those pages, and clients that
 * send no Origin (hooks, the CLI, curl) keep the loopback-trust model. Worker
 * runtime only, mounted right after the Host check.
 */
export function createForeignPageDeleteGuard(policy: WorkerOriginPolicy): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (req.method !== 'DELETE' || origin === undefined || isOwnPageOrigin(origin, req.headers.host, policy)) {
      next();
      return;
    }
    logger.warn('SECURITY', 'Refused a DELETE from a page other than the viewer', { origin, method: req.method, path: req.path });
    res.status(403).json({
      error: 'Forbidden',
      message: 'Deletes are accepted only from the claude-mem viewer itself (or an origin in CLAUDE_MEM_ALLOWED_ORIGINS), not from other pages.',
    });
  };
}

// Names that only ever refer to this machine (or, from inside a container, to
// the machine hosting it). A browser sends one of these as Host only when it is
// really talking to that name. A DNS-rebinding page always sends its own domain.
const ALWAYS_TRUSTED_HOSTNAMES = ['localhost', 'host.docker.internal'];

export function trustedWorkerHostnames(policy: WorkerOriginPolicy): Set<string> {
  const names = new Set(ALWAYS_TRUSTED_HOSTNAMES);
  const workerHost = policy.workerHost.trim().toLowerCase();
  if (workerHost) names.add(workerHost);
  for (const origin of policy.allowedOrigins) {
    try {
      names.add(new URL(origin).hostname.toLowerCase());
    } catch {
      // Not a parseable origin: there is no host name to trust.
    }
  }
  return names;
}

/**
 * The DNS-rebinding check. A page on evil.example whose DNS record is repointed
 * at 127.0.0.1 can send same-origin requests to the worker, but the browser
 * still sends `Host: evil.example`, never an IP address. So a Host that is a DNS
 * name the operator did not name is refused. IP addresses, `localhost` and
 * `*.localhost` always pass, so hooks, curl, the local viewer and LAN access by
 * IP keep working. The socket peer is deliberately not checked.
 */
export function isTrustedWorkerHost(rawHost: string | undefined, trustedHostnames: Set<string>): boolean {
  // Only HTTP/1.0 clients omit Host; browsers never do.
  if (!rawHost) return true;
  const host = parseHostWithoutPort(rawHost);
  if (isIP(host) !== 0) return true;
  if (host.endsWith('.localhost')) return true;
  return trustedHostnames.has(host);
}

export function createWorkerHostGuard(policy: WorkerOriginPolicy): RequestHandler {
  const trustedHostnames = trustedWorkerHostnames(policy);
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawHost = req.headers.host;
    if (isTrustedWorkerHost(rawHost, trustedHostnames)) {
      next();
      return;
    }
    const host = parseHostWithoutPort(rawHost ?? '');
    logger.warn('SECURITY', 'Refused a request whose Host is not a trusted name (DNS rebinding check)', {
      host,
      method: req.method,
      path: req.path,
    });
    res.status(403).json({
      error: 'Forbidden',
      message: `Host "${host}" is not trusted. To reach the worker by this name, add its origin (for example http://${rawHost}) to CLAUDE_MEM_ALLOWED_ORIGINS and restart the worker.`,
    });
  };
}

export function createCorsMiddleware(policy?: WorkerOriginPolicy): RequestHandler {
  const allowedOrigins = new Set(policy?.allowedOrigins ?? []);
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin) {
      const allowed = isLocalhostOrigin(origin)
        || allowedOrigins.has(origin.toLowerCase())
        || (policy !== undefined && isSameHostOrigin(origin, req.headers.host));
      if (!allowed) {
        // Write the response here rather than forwarding an error. The worker
        // installs its terminal error handler only once background
        // initialization has registered the last route; until then a forwarded
        // error lands in Express's default handler, which returns a 500 HTML
        // page containing a stack trace with absolute filesystem paths. Same
        // rule as the local API token guard below.
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

// The query parameter exists because EventSource and <img> cannot set request
// headers. A repeated `?token=` arrives as an array and is not a valid request.
function readQueryToken(req: Request): string | null {
  const raw = req.query?.token;
  if (Array.isArray(raw) || typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface LocalApiTokenOptions {
  /** Called per request. Empty string ⇒ this guard should never have been mounted. */
  getToken: () => string;
  /**
   * Exact request paths of the data-free UI files a browser loads before its scripts can
   * send the token (uiStaticPaths). GET and HEAD only. Absent ⇒ none.
   */
  openStaticPaths?: ReadonlySet<string>;
}

// The HTML shells ViewerRoutes serves from static bytes: My Work, the viewer and the
// inert restart page. No data, the same on every install.
const UI_SHELL_PATHS: readonly string[] = ['/', '/viewer', '/restart'];

/**
 * The request paths of every file under the UI directories that express.static serves
 * (`<packageRoot>/ui` in ViewerRoutes, `<packageRoot>/plugin/ui` in createMiddleware), plus
 * the HTML shells. Listed once, as exact paths, so the guard never matches a prefix. These are
 * the built bundles, styles, fonts and icons: identical on every install and holding no data.
 */
export function uiStaticPaths(packageRoot: string = getPackageRoot()): Set<string> {
  const paths = new Set<string>(UI_SHELL_PATHS);
  const walk = (directory: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // That layout is not this install's.
    }
    for (const entry of entries) {
      const requestPath = `${prefix}/${encodeURIComponent(entry.name)}`;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), requestPath);
      else if (entry.isFile()) paths.add(requestPath);
    }
  };
  walk(path.join(packageRoot, 'ui'), '');
  walk(path.join(packageRoot, 'plugin', 'ui'), '');
  return paths;
}

/**
 * Local API token mode (#5141): refuse any request that does not carry the local API
 * token, except the exact routes in OPEN_ROUTES (shared/local-api-token.ts) and, for GET
 * and HEAD, the data-free UI files in `openStaticPaths`. Loopback gets no pass: refusing
 * another local process is the whole point. The
 * policy is `decideLocalApiAccess`; this adds where a browser page can put the token.
 *
 * A header is the credential for every request. A page's images and event streams cannot
 * send one, so a read may also carry the token as `?token=`. A write must send the header. There is no cookie: cookies are shared
 * across every port on localhost, so one would hand the token to any other local server
 * the browser visits. A repeated or structured `token` is refused rather than picked from.
 */
export function createLocalApiTokenGuard(options: LocalApiTokenOptions): RequestHandler {
  const openStaticPaths = options.openStaticPaths ?? new Set<string>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const expectedToken = options.getToken();
    // A CORS preflight cannot carry the token, and the CORS middleware mounted after this
    // answers every OPTIONS itself (204, or 403 for a refused origin), so no route ever runs
    // for one. Refusing it here would stop an allowed origin from sending the real request.
    if (req.method === 'OPTIONS' && expectedToken) {
      next();
      return;
    }
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (isRead && expectedToken && openStaticPaths.has(req.path)) {
      next();
      return;
    }
    const rawQuery = req.query?.token;
    const malformedQuery = rawQuery !== undefined && typeof rawQuery !== 'string';
    const fromHeader = extractLocalApiToken(req.headers);
    const fromQuery = isRead ? readQueryToken(req) : null;
    const decision = decideLocalApiAccess({
      method: req.method,
      path: req.path,
      presentedToken: malformedQuery ? null : (fromHeader ?? fromQuery),
      expectedToken,
    });
    if (decision.allow) {
      next();
      return;
    }
    // Never log the token or the query string. `req.path` excludes the query string.
    logger.warn('SECURITY', 'Worker request refused: local API token missing or invalid', {
      method: req.method,
      path: req.path,
    });
    // Always write the response: the worker has no terminal error handler
    // until background initialization finishes.
    res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid local API token' });
  };
}

export function summarizeRequestBody(method: string, path: string, body: any): string {
  if (!body || Object.keys(body).length === 0) return '';

  if (path.includes('/init')) {
    return '';
  }

  if (path.includes('/observations')) {
    const toolName = body.tool_name || '?';
    const toolInput = scanMediaFields(body.tool_input, undefined, 'disabled').toolInput;
    const toolSummary = redactForLog(logger.formatTool(toolName, toolInput));
    return `tool=${toolSummary}`;
  }

  if (path.includes('/summarize')) {
    return 'requesting summary';
  }

  return '';
}
