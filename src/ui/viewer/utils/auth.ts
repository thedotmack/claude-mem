/**
 * Owner-token plumbing for the viewer.
 *
 * The worker API requires the shared secret from <DATA_DIR>/worker-auth-token
 * (see shared/worker-auth.ts). A browser cannot read that file, so the owner
 * pastes the token once (`cat ~/.claude-mem/worker-auth-token`); it is kept in
 * sessionStorage and sent as `Authorization: Bearer` on every API call, or as
 * `?token=` on the EventSource stream, which cannot set headers. Opening the
 * viewer with `#token=<token>` or `?token=<token>` also works — handy for
 * bookmarked links on the same machine; the hash copy is stripped immediately.
 */

const TOKEN_STORAGE_KEY = 'cmem.workerToken';

/** Read the owner token: URL fragment → query → sessionStorage → localStorage. */
export function getWorkerToken(): string {
  try {
    const hash = window.location.hash.slice(1);
    // The fragment doubles as the viewer's router (#/sessions/...); parse only
    // a real query-shaped fragment.
    const fromHash = new URLSearchParams(hash.includes('=') ? hash : '').get('token') ?? '';
    if (fromHash) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, fromHash);
      history.replaceState(null, '', window.location.pathname + window.location.search);
      return fromHash;
    }
    const fromQuery = new URLSearchParams(window.location.search).get('token') ?? '';
    if (fromQuery) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, fromQuery);
      return fromQuery;
    }
    return sessionStorage.getItem(TOKEN_STORAGE_KEY)
      ?? localStorage.getItem(TOKEN_STORAGE_KEY)
      ?? '';
  } catch {
    return '';
  }
}

export function setWorkerToken(token: string): void {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
}

/** fetch() with the owner token attached when one is known. */
export const authedFetch: typeof fetch = Object.assign(
  (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const token = getWorkerToken();
    if (!token) return fetch(input, init);
    return fetch(input, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
    });
  },
  // `typeof fetch` under the Bun types requires preconnect; browsers don't
  // implement it, so forward whatever the global has (usually undefined).
  { preconnect: fetch.preconnect },
);

/** Append ?token= for EventSource, which cannot set headers. */
export function withWorkerToken(url: string): string {
  const token = getWorkerToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}
