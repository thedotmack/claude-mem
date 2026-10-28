/**
 * Owner-token plumbing — mirrors src/ui/viewer/utils/auth.ts (kept separate:
 * my-work is its own vite root). The worker API requires the shared secret
 * from <DATA_DIR>/worker-auth-token; the owner pastes it once, or opens the
 * page with ?token=<token> / #token=<token>.
 */

const TOKEN_STORAGE_KEY = 'cmem.workerToken'

export function getWorkerToken(): string {
  try {
    const hash = window.location.hash.slice(1)
    const fromHash = new URLSearchParams(hash.includes('=') ? hash : '').get('token') ?? ''
    if (fromHash) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, fromHash)
      history.replaceState(null, '', window.location.pathname + window.location.search)
      return fromHash
    }
    const fromQuery = new URLSearchParams(window.location.search).get('token') ?? ''
    if (fromQuery) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, fromQuery)
      return fromQuery
    }
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setWorkerToken(token: string): void {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token.trim())
}

/** fetch() with the owner token attached when one is known. */
export function authedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getWorkerToken()
  if (!token) return fetch(input, init)
  return fetch(input, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
  })
}

/** Append ?token= for EventSource, which cannot set headers. */
export function withWorkerToken(url: string): string {
  const token = getWorkerToken()
  if (!token) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}token=${encodeURIComponent(token)}`
}
