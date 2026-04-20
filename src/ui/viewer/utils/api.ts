/**
 * Authenticated fetch wrapper for viewer API calls.
 * Reads the auth token injected into the page by the server (#1932/#1933).
 */

declare global {
  interface Window {
    __CLAUDE_MEM_AUTH_TOKEN__?: string;
  }
}

export function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = window.__CLAUDE_MEM_AUTH_TOKEN__;
  if (!token) {
    return fetch(input, init);
  }

  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);

  return fetch(input, { ...init, headers });
}
