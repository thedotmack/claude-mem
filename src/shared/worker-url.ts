/**
 * Format a worker host for a URL authority. An IPv6 literal must be bracketed,
 * so a `CLAUDE_MEM_WORKER_HOST` of `::1` yields `http://[::1]:port` instead of
 * the malformed `http://::1:port`.
 *
 * Keep this module import-free: the OpenCode plugin bundle uses it, and that
 * bundle must not pull in worker-utils (tests/integrations/opencode-plugin-contract.test.ts).
 */
export function formatHostForUrl(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host;
  return host.includes(':') ? `[${host}]` : host;
}

/** CLAUDE_MEM_WORKER_URL is set but unusable. Never falls back to host and port. */
export class InvalidWorkerUrlError extends Error {
  override name = 'InvalidWorkerUrlError';
}

/**
 * Validate an explicit client URL for the worker API. Remote worker requests
 * carry hook data and, for spool ingestion, a bearer token, so plain HTTP is
 * only acceptable when it stays on loopback (for example, an SSH port forward).
 */
export function normalizeWorkerBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidWorkerUrlError('CLAUDE_MEM_WORKER_URL must be an absolute http(s) URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidWorkerUrlError('CLAUDE_MEM_WORKER_URL must use http or https');
  }
  if (url.username || url.password || /[?#]/.test(url.href)) {
    throw new InvalidWorkerUrlError('CLAUDE_MEM_WORKER_URL cannot include credentials, a query, or a fragment');
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new InvalidWorkerUrlError('CLAUDE_MEM_WORKER_URL must use https for non-loopback workers');
  }

  return url.toString().replace(/\/+$/, '');
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1'
    || /^127(?:\.\d{1,3}){1,3}$/.test(host);
}
