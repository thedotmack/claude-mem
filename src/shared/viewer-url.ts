/**
 * Base URL of the viewer as printed to users (live view, welcome hint, the
 * observer-health "Click to restart" link).
 *
 * `CLAUDE_MEM_PUBLIC_URL` (env first, then the settings value) is the
 * browser-reachable address when the worker runs in a remote sandbox behind a
 * port-forward; empty or unset keeps the historical `http://localhost:<port>`.
 *
 * Dependency-free on purpose: hooks import `observer-health.ts`, which must not
 * drag in worker-utils' process-management tree just to format a URL.
 */
export function viewerBaseUrl(port: number | string, configuredPublicUrl: string | undefined): string {
  const publicUrl = (process.env.CLAUDE_MEM_PUBLIC_URL ?? configuredPublicUrl ?? '').trim();
  return publicUrl ? publicUrl.replace(/\/+$/, '') : `http://localhost:${port}`;
}
