// The one read of a request's detail, for every screen that shows it: the request drawer (components/request-detail.tsx)
// and the focus page's main card (components/focus-main-card.tsx). The compact overview leaves each request's evidence
// out (conversations, records, deliverables), so a screen that shows them reads the detail of the version it has.
import { useEffect, useRef, useState } from 'react'
import type { Request } from '@/data'
import { mergeRequestDetail, requestDetailKey, requestDetailToShow, requestOnScreen, type RequestDetailRead } from '@/live/request-detail-state'
import { useStore } from '@/store'

/** One read and, when it failed, how long it waited for its answer (page-05 F timeout-feedback). */
type TimedRead = RequestDetailRead & { waitedMs?: number }

/**
 * A request's detail, read by the drawer's rule (live/request-detail-state.ts requestDetailToShow): the version the
 * screen has is read once, and a newer version of the same request (a new captured prompt or observation gives it one)
 * keeps the last detail read on screen while its own read runs, then with that read's failure beside it if it fails. So
 * what the owner was doing there stays as they left it: open sections, the words typed in a reply box, the conversation
 * chosen. A new overview object for the same version reads nothing again.
 *
 * - `loaded`: the request with the detail on screen, null while its first read runs or after that read failed;
 * - `failure`: that first read failed, with why and how long it waited;
 * - `newerVersionReadFailure`: why the newer version could not be read, while the older detail stays on screen;
 * - `tryAgain`: reads the version on screen once more.
 *
 * `needed` false reads nothing (a screen that does not show the detail here); a request that carries its detail already
 * (sample data, an older worker's full model) is read at once.
 */
export function useRequestDetail(request: Request | null, needed = true): {
  loaded: Request | null
  failure: { message: string; waitedMs: number | null } | null
  newerVersionReadFailure: string | null
  tryAgain: () => void
} {
  const readDetail = useStore((state) => state.loadRequestDetail)
  const [retry, setRetry] = useState(0)
  const [detail, setDetail] = useState<TimedRead | null>(null)
  // The last read that brought a detail back. A newer version's read starts empty, so this one stays on screen meanwhile
  // (requestDetailToShow). It is recorded while rendering: React's way to keep a value from an earlier render.
  const [lastReadWithDetail, setLastReadWithDetail] = useState<TimedRead | null>(null)
  if (detail?.request && detail !== lastReadWithDetail) setLastReadWithDetail(detail)
  const key = request ? requestDetailKey(request) : ''
  const needsDetail = needed && request?.detailLoaded === false
  // The newest request for the read below, kept after each render; the read starts again only for a new version.
  const requestRef = useRef(request)
  useEffect(() => { requestRef.current = request })
  useEffect(() => {
    const summary = requestRef.current
    if (!summary || !needsDetail) return
    const controller = new AbortController()
    let active = true
    const startedAt = Date.now()
    setDetail({ key })
    void readDetail(summary, { signal: controller.signal }).then(
      (loaded) => { if (active) setDetail({ key, request: loaded }) },
      (error: unknown) => {
        if (active && !controller.signal.aborted) setDetail({ key, error: error instanceof Error ? error.message : 'Request detail could not be loaded.', waitedMs: Date.now() - startedAt })
      },
    )
    return () => { active = false; controller.abort() }
    // The detail version changes only when recorded content changes. A new overview object must not restart this read.
  }, [key, needsDetail, readDetail, retry])
  const tryAgain = () => setRetry((value) => value + 1)
  if (!request) return { loaded: null, failure: null, newerVersionReadFailure: null, tryAgain }
  if (!needsDetail) return { loaded: request, failure: null, newerVersionReadFailure: null, tryAgain }
  const current = detail?.key === key ? detail : null
  if (current?.request) return { loaded: mergeRequestDetail(request, current.request), failure: null, newerVersionReadFailure: null, tryAgain }
  // A newer version of the same request is being read, or its read failed: the detail read before it stays on screen,
  // with that version's own fingerprint, so a review action names the version on screen (requestOnScreen).
  const shown = requestDetailToShow(request.id, current, lastReadWithDetail)
  if (shown) return { loaded: requestOnScreen(request, shown.request), failure: null, newerVersionReadFailure: shown.newerVersionReadFailure ?? null, tryAgain }
  return { loaded: null, failure: current?.error === undefined ? null : { message: current.error, waitedMs: current.waitedMs ?? null }, newerVersionReadFailure: null, tryAgain }
}
