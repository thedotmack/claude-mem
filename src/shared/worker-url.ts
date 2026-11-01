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
