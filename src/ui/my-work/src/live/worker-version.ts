// The worker version Machine and sync shows (design pass Phase 4), read from GET /api/version when the page opens. Pure,
// with .ts imports, so `node --test` loads it. A page never shows a version it did not read from the worker it reads
// its work from: until the read answers it says so, an answer that is not a version says what came back instead of
// leaving the row empty, and a host that runs no worker is not asked. Behind the cloud viewer's gate
// (services/viewer-host/src/gate.ts) a read the gate refuses answers 403 with its reason.

/** Where the worker says which claude-mem it runs (src/services/server/Server.ts). */
export const WORKER_VERSION_URL = '/api/version'

/**
 * Where the read is. The one definition: Machine and sync words each state in a Record over it. Its one writer is
 * the page's read (pages/machine-sync.tsx). Moves: reading ──answer──▶ read | refused | failed. `not-read-here` is
 * where it starts, and stays, on a host that runs no worker (workerVersionReadHere).
 */
export const WORKER_VERSION_READ_STATES = ['reading', 'read', 'refused', 'failed', 'not-read-here'] as const
export type WorkerVersionReadState = (typeof WORKER_VERSION_READ_STATES)[number]

export type WorkerVersionRead =
  | { state: 'reading' }
  | { state: 'read'; version: string }
  /** The server answered with an error status; `reason` is its own sentence when it sent one (the gate does). */
  | { state: 'refused'; status: number; reason: string | null }
  /** No answer (the worker is down, the network failed), or one that held no version: the raw cause. */
  | { state: 'failed'; cause: string }
  /** The page's host runs no worker, so its /api/version would not be this page's worker: nothing is asked. */
  | { state: 'not-read-here' }

/**
 * Whether GET /api/version on this page's host is answered by the worker the page reads its work from. This computer's
 * worker answers it, and so does the cloud viewer at work.cmem.ai, a worker behind the gate, which lets the read
 * through. cmem.ai/work does not: cmem.ai serves that page from its own app (claude-mem-pro src/app/work/route.ts),
 * which runs no worker and has no /api/version route, so the read would get cmem.ai's own not-found page, or one day
 * some other app's version. cmem.ai marks that page with its owner meta (live/shared-viewer-session.ts), which is how
 * the page knows where it is; `sharedViewerOwner` is that meta's value, null everywhere else.
 */
export function workerVersionReadHere(sharedViewerOwner: string | null): boolean {
  return sharedViewerOwner === null
}

const textField = (body: unknown, field: string): string | null => {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[field] : null
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function readWorkerVersion(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>): Promise<Exclude<WorkerVersionRead, { state: 'reading' | 'not-read-here' }>> {
  let response: Response
  try {
    response = await fetchImpl(WORKER_VERSION_URL, { headers: { Accept: 'application/json' } })
  } catch (cause) {
    return { state: 'failed', cause: cause instanceof Error ? cause.message : String(cause) }
  }
  const text = await response.text().catch(() => '')
  let body: unknown = null
  try { body = JSON.parse(text) } catch { /* not JSON: said below */ }
  if (!response.ok) return { state: 'refused', status: response.status, reason: textField(body, 'error') }
  const version = textField(body, 'version')
  // The whole answer is the cause: it folds under Details on the page, so nothing of it is hidden or cut.
  return version ? { state: 'read', version } : { state: 'failed', cause: `The worker answered ${response.status} without a version: ${text || '(empty)'}` }
}
