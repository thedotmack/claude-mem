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
import { isLoopbackHostname } from './worker-url.js';
import { logger } from '../utils/logger.js';

export const LOCAL_API_TOKEN_SETTING = 'CLAUDE_MEM_LOCAL_API_TOKEN';
export const LOCAL_API_TOKEN_HEADER = 'x-claude-mem-token';

/**
 * The one remote worker a client may hand the token to (#6390). Empty = none, so the
 * token stays on loopback. It must name the same host as CLAUDE_MEM_WORKER_HOST: a
 * token that settings.json holds for one worker must never reach a host the user did
 * not name, and an SSH forward to another machine looks like loopback.
 */
export const LOCAL_API_TOKEN_REMOTE_HOST_SETTING = 'CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST';

// Exact "METHOD path" matches, no prefixes and no patterns. Only the health probe needs
// no token: clients run it before they know the worker is up, and the installer and the
// port logic identify the worker by it. It answers with status only. Everything else,
// the readiness routes and the hook spool included, takes the token.
const OPEN_ROUTES: ReadonlySet<string> = new Set(['GET /api/health']);

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

/** A configured remote token host, trimmed; whitespace-only is unset. */
export function normalizeRemoteTokenHost(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The token headers for a request to `workerOrigin`, or `{}` (#5141, #6390). One
 * rule, so the hooks, the CLI, the MCP servers and the integrations cannot drift:
 *
 *  - the token goes to this machine's worker at `localOrigin` when that is loopback,
 *    exactly as before. An explicit CLAUDE_MEM_WORKER_URL naming any other address
 *    never receives it: it may be an SSH forward to another machine's worker;
 *  - a non-loopback worker receives it only when CLAUDE_MEM_LOCAL_API_TOKEN_REMOTE_HOST
 *    names that host and equals CLAUDE_MEM_WORKER_HOST exactly. One host spelled one
 *    way: the token in settings.json belongs to the worker the user configured, and a
 *    near-match is a mistake, not an intent.
 *
 * With the remote host unset the second branch cannot fire, so nothing changes.
 */
export function localApiTokenHeadersFor(input: {
  token: string;
  /** The origin the request actually goes to. */
  workerOrigin: string;
  /** This machine's worker origin, from CLAUDE_MEM_WORKER_HOST and _PORT. */
  localOrigin: string;
  configuredHost: string;
  remoteTokenHost: string;
}): Record<string, string> {
  const token = normalizeLocalApiToken(input.token);
  if (!token) return {};

  let target: URL;
  try {
    target = new URL(input.workerOrigin);
  } catch {
    return {};
  }

  if (isLoopbackHostname(target.hostname)) {
    // Unchanged for every existing install: the token goes to this machine's worker and
    // to no other local address, because another loopback port may be an SSH forward.
    return input.workerOrigin === input.localOrigin ? localApiTokenHeaders(token) : {};
  }

  // A remote worker takes the opt-in twice over: the setting must be set, and it must
  // name the same host as CLAUDE_MEM_WORKER_HOST and the request's own host.
  const remote = normalizeRemoteTokenHost(input.remoteTokenHost);
  if (!remote || remote !== input.configuredHost.trim()) return {};
  if (target.hostname.toLowerCase() !== remote.toLowerCase()) return {};
  return localApiTokenHeaders(token);
}
