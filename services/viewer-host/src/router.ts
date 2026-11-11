/**
 * The router in front of every account's viewer (VIEWER_ROLE=router, index.ts).
 * It holds the master secret and nothing else: no worker, no volume, no account
 * data. For each request it checks the signed token, works out which account it
 * belongs to, and answers with a `fly-replay` header naming that account's Fly
 * app. Fly's proxy then delivers the request there and starts the machine if it
 * is stopped ("If the machine is not running, the proxy will start it",
 * https://docs.fly.io/blueprints/connecting-to-user-machines).
 *
 * A token for user U verifies only with U's derived key (perUserViewerLinkSecret),
 * which is the key U's machine holds as its VIEWER_LINK_SECRET. So the router
 * sends a request only to the machine whose gate will accept the same token, and
 * that gate (gate.ts) still makes every access decision past this point.
 *
 * The router never proxies a body and never talks to an account's machine.
 */
import { json, page, readCookie, SESSION_COOKIE, wantsHtml } from './gate.js';
import { perUserViewerLinkSecret, replicaFlyAppNameForUser, verifyToken, type TokenAudience } from './token.js';

/**
 * Fly cannot replay a request larger than 1MB ("Requests larger than 1MB cannot
 * be replayed", https://docs.fly.io/networking/dynamic-request-routing). 1,000,000
 * is the smaller reading of "1MB", so nothing that passes this check is over Fly's limit.
 */
const MAX_REPLAYABLE_CONTENT_LENGTH = 1_000_000;

export interface RouterOptions {
  /** The master secret (same value as cmem.ai's CMEM_VIEWER_LINK_SECRET). Never given to an account's machine. */
  masterSecret: string;
  /** Account apps are named this prefix plus a keyed hash of the user id, e.g. cmem-vw-. */
  replicaFlyAppNamePrefix: string;
  /** This host's public origin, e.g. https://work.cmem.ai. Decides the cookie's Secure flag. */
  publicOrigin: string;
  /** Where a visitor without a session goes to sign in: cmem.ai's /work mints the link. */
  signInUrl: string;
  now?: () => number;
  log?: (message: string) => void;
}

/** The token's `sub`, read before the signature is checked. Only used to pick the key to check it with. */
function unverifiedSubject(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const { sub } = (JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) ?? {}) as { sub?: unknown };
    return typeof sub === 'string' && sub ? sub : null;
  } catch {
    return null;
  }
}

/** One field of a `fly-replay-failed` header, e.g. reason=timeout (https://docs.fly.io/networking/dynamic-request-routing). */
function replayFailedField(header: string, field: string): string {
  for (const pair of header.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key === field) return rest.join('=');
  }
  return 'unknown';
}

/**
 * Whether Fly could replay this request's body. A body sent without a stated length
 * (transfer-encoding) or with a malformed length cannot be checked against Fly's
 * limit, so it is refused rather than replayed blind. Content-Length must be digits
 * only (RFC 9110, section 8.6).
 */
function replayableBody(request: Request): boolean {
  const contentLength = request.headers.get('content-length');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.headers.has('transfer-encoding')) return false;
    if (contentLength !== null && !/^\d+$/.test(contentLength.trim())) return false;
  }
  return contentLength === null || Number(contentLength) <= MAX_REPLAYABLE_CONTENT_LENGTH;
}

export function createRouter(options: RouterOptions): (request: Request) => Response {
  const nowSeconds = () => Math.floor((options.now?.() ?? Date.now()) / 1000);
  const secure = new URL(options.publicOrigin).origin.startsWith('https:');
  const log = options.log ?? ((message: string) => console.error(message));

  /** The user id of a token that verifies with that user's own derived key, or null. */
  const verifiedUser = (token: string, audience: TokenAudience): string | null => {
    const claimedUser = unverifiedSubject(token);
    if (!claimedUser) return null;
    const claims = verifyToken(perUserViewerLinkSecret(options.masterSecret, claimedUser), token, audience, nowSeconds());
    return claims?.sub ?? null;
  };

  return function router(request: Request): Response {
    const url = new URL(request.url);

    if (url.pathname === '/health') return json(200, { ok: true, role: 'router' });

    if (url.pathname === '/logout' && request.method === 'POST') {
      const cookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
      return new Response(null, { status: 303, headers: { Location: options.signInUrl, 'Set-Cookie': cookie } });
    }

    // Known, accepted risk for now: login CSRF. Someone can send a victim a valid
    // /auth link for the sender's own account, and the victim's browser then opens
    // the sender's viewer. Deferred, not mitigated here.
    const isAuthLink = url.pathname === '/auth';
    const token = isAuthLink ? url.searchParams.get('t') ?? '' : readCookie(request, SESSION_COOKIE) ?? '';
    const userId = verifiedUser(token, isAuthLink ? 'link' : 'session');

    if (!userId) {
      if (isAuthLink) return page(403, 'This link has expired', `<p>Open your viewer again from cmem.ai.</p><a href="${options.signInUrl}">Go to cmem.ai</a>`);
      if (wantsHtml(request)) return Response.redirect(options.signInUrl, 302);
      return json(401, { error: 'Sign in at cmem.ai to open your viewer.' });
    }

    // Checked after the token: Fly's fallback request is the original request, so it still
    // carries the cookie or link, and an unauthenticated client cannot write log lines here.
    const replayFailed = request.headers.get('fly-replay-failed');
    if (replayFailed !== null) {
      // Fly delivered the request back here because the replay failed (fallback=force_self).
      // A fallback request cannot issue another replay (https://docs.fly.io/networking/dynamic-request-routing).
      log(`[viewer-router] replay failed: reason=${replayFailedField(replayFailed, 'reason')} app=${replayFailedField(replayFailed, 'app')}`);
      // A page for a browser, JSON for an API call, the same split as the unauthenticated answer above and the gate's own 503.
      if (wantsHtml(request)) return page(503, 'Your viewer is not available right now', `<p>Try again in a moment.</p><a href="${options.signInUrl}">Go to cmem.ai</a>`);
      return json(503, { error: 'Your viewer is not available right now. Try again in a moment.' });
    }

    if (!replayableBody(request)) return json(413, { error: 'This request is too large for your viewer.' });

    // The target is derived from the verified user id alone; nothing else from the request reaches this header.
    // fallback=force_self brings a failed replay back here with fly-replay-failed (handled above).
    const replicaFlyAppName = replicaFlyAppNameForUser(options.masterSecret, options.replicaFlyAppNamePrefix, userId);
    return new Response(null, { headers: { 'fly-replay': `app=${replicaFlyAppName};fallback=force_self` } });
  };
}
