/**
 * Fetch wrapper for viewer API calls.
 * Worker is localhost-only; no auth header needed.
 */
export function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}
