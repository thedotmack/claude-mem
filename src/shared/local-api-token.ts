// Local API token mode (#5141).
//
// The worker API and the MCP HTTP transport trust any process that can reach
// loopback. On a host with several OS users that is every user. Setting
// CLAUDE_MEM_LOCAL_API_TOKEN in the owner's settings.json (mode 0600) turns on a
// check: a request must carry the token, or it is refused. Unset, nothing
// changes.
//
// The key is file-only. HTTP cannot write it (SettingsRoutes), and the
// environment neither turns the check on nor off for the servers (they read it
// with applyEnvOverrides = false).
//
// The policy is a pure function so both servers and their tests share one
// definition. Allowlist only, never the inverse: the route count grows every
// release, and a list of "protected" routes is only a list of the ones someone
// remembered.
import { createHash, timingSafeEqual } from 'crypto';
import type { IncomingHttpHeaders } from 'http';
import { parseBearerToken } from '../server/middleware/request-auth-helpers.js';
import { logger } from '../utils/logger.js';

export const LOCAL_API_TOKEN_SETTING = 'CLAUDE_MEM_LOCAL_API_TOKEN';
export const LOCAL_API_TOKEN_HEADER = 'x-claude-mem-token';

// Exact "METHOD path" matches, no prefixes and no patterns. Only the health probe needs
// no token: clients run it before they know the worker is up, and the installer and the
// port logic identify the worker by it. It answers with status only. Everything else,
// the readiness routes and the hook spool included, takes the token.
const OPEN_ROUTES: ReadonlySet<string> = new Set(['GET /api/health']);

/**
 * The cookie a browser page holds after it was opened with a valid `?token=`. A script, an
 * image or an event stream cannot send a header, so a page's own subresources carry the
 * token this way. It is accepted on GET and HEAD only: a write must send the header.
 */
export const LOCAL_API_TOKEN_COOKIE = 'claude_mem_token';

/** Whitespace-only is OFF, not a secret equal to a space. */
export function normalizeLocalApiToken(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function safeEqualSecret(presented: string, expected: string): boolean {
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

/** `X-Claude-Mem-Token: <token>` or `Authorization: Bearer <token>`, in that order. */
export function extractLocalApiToken(headers: IncomingHttpHeaders): string | null {
  const dedicated = headers[LOCAL_API_TOKEN_HEADER];
  if (typeof dedicated === 'string' && dedicated.trim()) return dedicated.trim();
  const authorization = headers.authorization;
  return typeof authorization === 'string' ? parseBearerToken(authorization) : null;
}

/**
 * The token in a `Cookie` header, or null for none, a blank value, or a repeated name:
 * which of two copies the browser meant is not for the server to guess.
 */
export function readCookieToken(cookieHeader: string | undefined): string | null {
  if (typeof cookieHeader !== 'string') return null;
  let found: string | null = null;
  for (const part of cookieHeader.split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== LOCAL_API_TOKEN_COOKIE) continue;
    if (found !== null) return null;
    found = part.slice(at + 1).trim();
  }
  if (!found) return null;
  try {
    return decodeURIComponent(found) || null;
  } catch {
    return null;
  }
}

export type LocalApiAccessDecision = { allow: true } | { allow: false; reason: 'token' };

/**
 * The whole policy for the worker API. An empty `expectedToken` denies
 * everything: the guard is only mounted when a token is set, and must fail
 * closed if it is ever mounted without one.
 */
export function decideLocalApiAccess(input: {
  method: string;
  path: string;
  presentedToken: string | null;
  expectedToken: string;
}): LocalApiAccessDecision {
  if (!input.expectedToken) return { allow: false, reason: 'token' };
  if (OPEN_ROUTES.has(`${input.method} ${input.path}`)) return { allow: true };
  if (input.presentedToken && safeEqualSecret(input.presentedToken, input.expectedToken)) {
    return { allow: true };
  }
  return { allow: false, reason: 'token' };
}

/** The header a client adds for a worker that has an local API token; none when it has no token. */
export function localApiTokenHeaders(token: string): Record<string, string> {
  return token ? { [LOCAL_API_TOKEN_HEADER]: token } : {};
}
