/**
 * The cloud viewer's front door. The real claude-mem worker runs beside this
 * gate on loopback, pulling its owner's synced memory like any other device,
 * and serves the same My Work page (and the legacy viewer at /viewer) it
 * serves on a laptop. Its work-view routes answer only loopback requests that
 * carry no proxy headers (WorkViewRoutes workViewLoopbackOnly), so they stay
 * unreachable from outside except through here:
 *
 *   - cmem.ai signs its signed-in owner a one-use link (/auth?t=…), traded
 *     here once for an HttpOnly session cookie. Only VIEWER_OWNER_USER_ID gets in.
 *   - Reads pass, except the routes that expose settings, logs, backups or
 *     setup on the machine. Writes pass only for the My Work actions that save
 *     work state (review, rules, focus, suggestions, agent finished, usage);
 *     the worker syncs those rows back to the owner's other devices.
 *   - A write must come from this origin. The request then goes to the worker
 *     as if made on that machine: loopback Host and Origin, proxy headers
 *     and cookies removed.
 */
import { signToken, verifyToken } from './token.js';

export const SESSION_COOKIE = 'cmem_viewer_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;

/** Read routes that would show the cloud machine's own configuration. */
const BLOCKED_READ_PREFIXES = ['/api/settings', '/api/logs', '/api/admin', '/api/backup', '/api/setup', '/restart'];

/** The My Work actions that save work state. Everything else that writes stays on the owner's own computer. */
const ALLOWED_WRITES = new Set([
  '/api/work-view/review',
  '/api/work-view/rules',
  '/api/work-view/focus',
  '/api/work-view/focus/router',
  '/api/work-view/focus/seed',
  '/api/work-view/agents/mark-finished',
  '/api/work-view/suggestions',
  '/api/work-view/usage',
]);

/** Never passed to the worker: hop-by-hop, the browser's own identity, and anything a proxy adds. */
const DROPPED_REQUEST_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'host', 'cookie', 'origin', 'referer', 'forwarded', 'via', 'x-real-ip', 'true-client-ip', 'cf-connecting-ip',
]);
const DROPPED_REQUEST_PREFIXES = ['x-forwarded-', 'fly-'];

const DROPPED_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-encoding', 'content-length', 'set-cookie',
]);

export interface GateOptions {
  ownerUserId: string;
  secret: string;
  /** Where the worker listens, e.g. http://127.0.0.1:37777. */
  upstreamOrigin: string;
  /** This host's public origin, e.g. https://viewer.cmem.ai. Writes must come from it. */
  publicOrigin: string;
  /** Where an owner without a session goes to sign in: cmem.ai's /work mints the link. */
  signInUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function page(status: number, title: string, body: string, extraHeaders: Record<string, string> = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.55 ui-sans-serif,system-ui,sans-serif}main{width:min(30rem,calc(100vw - 32px));text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}a{display:inline-block;padding:.75rem 1.25rem;min-height:44px;box-sizing:border-box}</style>
</head><body><main><h1>${title}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders } });
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

const wantsHtml = (request: Request) => request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html');

/**
 * The path as the worker's router may read it: Express matches routes without
 * regard to case and decodes escapes, so the policy is checked on the lowercased,
 * decoded path. Null for a path that can't be checked (bad escapes, empty or dot
 * segments), which is refused rather than forwarded.
 */
export function policyPath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('//') || decoded.includes('\\')) return null;
  if (decoded.split('/').some(segment => segment === '.' || segment === '..')) return null;
  return decoded.toLowerCase();
}

/** Whether the policy lets this method and path through to the worker. */
export function isAllowed(method: string, pathname: string): boolean {
  const path = policyPath(pathname);
  if (path === null) return false;
  if (method === 'GET' || method === 'HEAD') {
    return !BLOCKED_READ_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
  }
  return method === 'POST' && ALLOWED_WRITES.has(path);
}

export function createGate(options: GateOptions): (request: Request) => Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowSeconds = () => Math.floor((options.now?.() ?? Date.now()) / 1000);
  const upstream = new URL(options.upstreamOrigin);
  const publicOrigin = new URL(options.publicOrigin).origin;
  const secure = publicOrigin.startsWith('https:');
  // Links already traded for a session, until they expire: a link opens one session.
  const usedLinks = new Map<string, number>();

  const sessionOwner = (request: Request): boolean => {
    const token = readCookie(request, SESSION_COOKIE);
    const claims = token ? verifyToken(options.secret, token, 'session', nowSeconds()) : null;
    return claims?.sub === options.ownerUserId;
  };

  return async function gate(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      // The gate answers this itself: a worker busy applying a large pull can
      // take seconds per request, and a check that waits on it gets the only
      // machine pulled from the load balancer. The worker's state rides along
      // for people, never as the status code; index.ts restarts a dead worker.
      let worker: 'ready' | 'busy' | 'down' = 'down';
      try {
        const health = await fetchImpl(new URL('/api/health', upstream), { signal: AbortSignal.timeout(1000) });
        worker = health.ok ? 'ready' : 'busy';
      } catch (error) {
        worker = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'busy' : 'down';
      }
      return json(200, { ok: true, worker });
    }

    if (url.pathname === '/auth') {
      const link = url.searchParams.get('t') ?? '';
      const claims = verifyToken(options.secret, link, 'link', nowSeconds());
      for (const [used, exp] of usedLinks) if (exp < nowSeconds()) usedLinks.delete(used);
      if (claims?.sub !== options.ownerUserId || usedLinks.has(link)) {
        return page(403, 'This link has expired', `<p>Open your viewer again from cmem.ai.</p><a href="${options.signInUrl}">Go to cmem.ai</a>`);
      }
      usedLinks.set(link, claims.exp);
      const session = signToken(options.secret, { sub: claims.sub, aud: 'session', exp: nowSeconds() + SESSION_SECONDS });
      const cookie = `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`;
      return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': cookie, 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/logout' && request.method === 'POST') {
      const cookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
      return new Response(null, { status: 303, headers: { Location: options.signInUrl, 'Set-Cookie': cookie } });
    }

    if (!sessionOwner(request)) {
      if (wantsHtml(request)) return Response.redirect(options.signInUrl, 302);
      return json(401, { error: 'Sign in at cmem.ai to open your viewer.' });
    }

    if (!isAllowed(request.method, url.pathname)) {
      return json(403, { error: 'This works only on your own computer.' });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // The worker's own origin check only knows loopback, so the gate checks the browser's here.
      if (request.headers.get('origin') !== publicOrigin || request.headers.get('sec-fetch-site') === 'cross-site') {
        return json(403, { error: 'Changes must come from your viewer page.' });
      }
    }

    const headers = new Headers();
    request.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (DROPPED_REQUEST_HEADERS.has(lower) || DROPPED_REQUEST_PREFIXES.some(prefix => lower.startsWith(prefix))) return;
      headers.set(name, value);
    });
    headers.set('host', upstream.host);
    if (request.method !== 'GET' && request.method !== 'HEAD') headers.set('origin', upstream.origin);

    let response: Response;
    try {
      // Path and query only: the request can never pick the host.
      const target = new URL(upstream.href);
      target.pathname = url.pathname;
      target.search = url.search;
      response = await fetchImpl(target, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
        redirect: 'manual',
        signal: request.signal,
      });
    } catch {
      if (wantsHtml(request)) return page(503, 'Your viewer is starting', '<p>It will be ready in a moment. Reload to try again.</p>');
      return json(503, { error: 'Your viewer is starting. Try again in a moment.' });
    }

    const responseHeaders = new Headers();
    response.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.append(name, value);
    });
    responseHeaders.set('X-Frame-Options', 'DENY');
    responseHeaders.set('Referrer-Policy', 'no-referrer');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  };
}
