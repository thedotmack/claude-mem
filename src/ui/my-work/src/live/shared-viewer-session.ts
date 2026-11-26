// cmem.ai adds this meta element to the signed-in /work document. Its value pins the
// displayed page to an account. The API independently authenticates the browser session.
type OwnerDocument = { querySelector(selector: string): { getAttribute(name: string): string | null } | null }

export function sharedViewerOwner(doc = (globalThis as { document?: OwnerDocument }).document): string | null {
  return doc?.querySelector('meta[name="cmem-work-owner"]')?.getAttribute('content')?.trim() || null
}

export function notifySharedViewer(event: 'cmem:session-ended' | 'cmem:session-check') {
  const win = (globalThis as { window?: { dispatchEvent(event: Event): boolean } }).window
  win?.dispatchEvent(new Event(event))
}

function scopedPath(url: URL) {
  return url.pathname === '/api/work-view' || url.pathname.startsWith('/api/work-view/')
    || url.pathname === '/api/cloud-sync/renewal-status'
}

/** Applies the stale-page precondition to the same-origin viewer API. A transport retry of
 * a user action carries precisely the same body and idempotency key, even if the first reply was lost. */
export function sharedViewerFetch(owner: string, page: URL, send: typeof fetch, onSessionEnded: () => void): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), page)
    if (url.origin !== page.origin || !scopedPath(url)) return send(input, init)
    const request = new Request(input instanceof Request ? input : url, { ...init, redirect: 'error' })
    request.headers.set('X-Work-Session', owner)
    const write = request.method === 'POST' && url.pathname.startsWith('/api/work-view/')
    if (write && !request.headers.has('Idempotency-Key')) request.headers.set('Idempotency-Key', crypto.randomUUID())
    let response: Response
    try {
      response = await send(write ? request.clone() : request)
    } catch (error) {
      if (!write || request.signal.aborted || !(error instanceof TypeError)) throw error
      response = await send(request)
    }
    if (response.status === 401) onSessionEnded()
    if (response.status === 409 || response.status === 403) {
      const body = await response.clone().json().catch(() => null) as { code?: string } | null
      if (body?.code === 'owner_changed' || body?.code === 'not_entitled') onSessionEnded()
    }
    return response
  }
}
