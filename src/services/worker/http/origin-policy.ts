// Browser-origin policy shared by the worker's HTTP middleware and the MCP
// server's loopback HTTP transport (src/servers/mcp-http.ts). Kept free of
// express so the MCP bundle can import it without pulling express in.

/**
 * Which browser origins and Host names the worker accepts (plan-23 step 4).
 *
 * Only the worker runtime sets this. The server runtime authenticates every
 * request with an API key and is reached through public DNS names, so neither
 * the Host check nor same-host CORS applies there.
 */
export interface WorkerOriginPolicy {
  /**
   * Exact origins allowed cross-origin besides `http://localhost:*` and
   * `http://127.0.0.1:*` (CLAUDE_MEM_ALLOWED_ORIGINS). Their host names are
   * also trusted by the Host check.
   */
  allowedOrigins: string[];
  /** CLAUDE_MEM_WORKER_HOST. Trusted by the Host check when it is a DNS name. */
  workerHost: string;
}

// Parses CLAUDE_MEM_ALLOWED_ORIGINS: comma-separated full origins. Trailing
// slashes are stripped so `https://a.com/` matches the browser-sent
// `Origin: https://a.com`.
export function parseAllowedOriginsSetting(value: string): string[] {
  return value
    .split(',')
    .map(origin => origin.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
}

/**
 * The worker's policy from its settings. CLAUDE_MEM_PUBLIC_URL (the viewer's
 * published base URL, e.g. a remote sandbox's port-forward) is where the browser
 * loads the viewer from, so its origin is trusted like an allowlisted one.
 */
export function buildWorkerOriginPolicy(settings: {
  CLAUDE_MEM_ALLOWED_ORIGINS?: string;
  CLAUDE_MEM_WORKER_HOST?: string;
  CLAUDE_MEM_PUBLIC_URL?: string;
}): WorkerOriginPolicy {
  const allowedOrigins = parseAllowedOriginsSetting(settings.CLAUDE_MEM_ALLOWED_ORIGINS ?? '');
  const publicUrl = (settings.CLAUDE_MEM_PUBLIC_URL ?? '').trim();
  if (publicUrl) {
    try {
      allowedOrigins.push(new URL(publicUrl).origin.toLowerCase());
    } catch {
      // Not a URL: there is no origin to trust.
    }
  }
  return { allowedOrigins, workerHost: settings.CLAUDE_MEM_WORKER_HOST ?? '' };
}

export function isLocalhostOrigin(origin: string): boolean {
  return origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
}

// An Origin naming the host and port the request was sent to: the viewer served
// from http://<lan-ip>:<port> calling its own API. Safe only behind the Host
// check, which has already refused any Host the operator did not trust;
// otherwise a rebound attacker page would qualify as "same host".
export function isSameHostOrigin(origin: string, rawHost: string | undefined): boolean {
  if (!rawHost) return false;
  try {
    return new URL(origin).host === rawHost.trim().toLowerCase();
  } catch {
    return false;
  }
}

const LOOPBACK_URL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a browser Origin is the worker's own page: an allowlisted origin
 * (CLAUDE_MEM_ALLOWED_ORIGINS, which includes the CLAUDE_MEM_PUBLIC_URL
 * viewer), the host:port the request was sent to (the viewer at localhost,
 * 127.0.0.1, a LAN address or a trusted machine name), or another loopback
 * name for that same port. Every other page CORS admits, such as any
 * http://localhost:* dev server, belongs to someone else. Safe only behind the
 * Host check, like isSameHostOrigin.
 */
export function isOwnPageOrigin(origin: string, rawHost: string | undefined, policy: WorkerOriginPolicy): boolean {
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false;
  if (policy.allowedOrigins.includes(originUrl.origin)) return true;
  if (!rawHost) return false;
  if (isSameHostOrigin(origin, rawHost)) return true;
  let hostUrl: URL;
  try {
    hostUrl = new URL(`${originUrl.protocol}//${rawHost.trim().toLowerCase()}`);
  } catch {
    return false;
  }
  return LOOPBACK_URL_HOSTNAMES.has(originUrl.hostname)
    && LOOPBACK_URL_HOSTNAMES.has(hostUrl.hostname)
    && originUrl.port === hostUrl.port;
}
