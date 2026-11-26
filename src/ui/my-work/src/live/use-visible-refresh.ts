import { useEffect, useRef, useState } from 'react'

/** After a read that failed, look again this soon. The last answer stays shown meanwhile. */
export const VISIBLE_REFRESH_RETRY_MS = 60_000
/** setTimeout's largest delay; a later time is reached in steps. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * Reads `read` while the page is shown, and again whenever it is shown again (a tab coming back, or a page restored
 * from the back/forward cache) and at the time `nextCheckAt` gives for the answer. `nextCheckAt` answers a time,
 * null for no timer (only showing the page again reads), or Infinity to stop reading and listening for good.
 * A read that fails keeps the last answer and tries again after `retryMs`. A newer read cancels an older one.
 * `read` and `nextCheckAt` are read from the latest render, so callers need not memoize them.
 *
 * `reschedule`: when it changes, `nextCheckAt` is asked again for the last answer, without a read, for a fact the
 * caller has from elsewhere that `nextCheckAt` depends on (Work View's Cloud Sync state). It starts no read and does
 * not restart reading that has stopped for good; while a read is on its way, or a failed read waits to retry, that
 * read's own schedule stands.
 */
export function useVisibleRefresh<T>(
  enabled: boolean,
  read: (signal: AbortSignal) => Promise<T>,
  nextCheckAt: (value: T, now: number) => number | null,
  retryMs = VISIBLE_REFRESH_RETRY_MS,
  reschedule?: unknown,
): T | null {
  const [value, setValue] = useState<T | null>(null)
  const latest = useRef({ read, nextCheckAt })
  latest.current = { read, nextCheckAt }
  const scheduleAgain = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!enabled) return
    let pending: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let listening = true
    // The last answer this effect read, while no read is on its way and the last one did not fail.
    let settled: { value: T } | null = null
    const later = (at: number) => { timer = setTimeout(refresh, Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS)) }
    const stop = () => {
      if (!listening) return
      listening = false
      clearTimeout(timer)
      window.removeEventListener('pageshow', onPageShow)
      document.removeEventListener('visibilitychange', refresh)
    }
    const schedule = (next: T) => {
      const at = latest.current.nextCheckAt(next, Date.now())
      if (at === Number.POSITIVE_INFINITY) stop()
      else if (at !== null) later(at)
    }
    async function refresh() {
      if (!listening || document.visibilityState === 'hidden') return
      pending?.abort()
      clearTimeout(timer)
      settled = null
      const controller = new AbortController()
      pending = controller
      try {
        const next = await latest.current.read(controller.signal)
        if (controller.signal.aborted) return
        setValue(next)
        settled = { value: next }
        schedule(next)
      } catch {
        if (!controller.signal.aborted) later(Date.now() + retryMs)
      }
    }
    function onPageShow(event: PageTransitionEvent) { if (event.persisted) void refresh() }
    scheduleAgain.current = () => {
      if (!listening || !settled) return
      clearTimeout(timer)
      schedule(settled.value)
    }
    void refresh()
    window.addEventListener('pageshow', onPageShow)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      scheduleAgain.current = null
      pending?.abort()
      stop()
    }
  }, [enabled, retryMs])
  // Declared after the reading effect, so on the first render it finds that effect's read on its way and does nothing.
  useEffect(() => { scheduleAgain.current?.() }, [reschedule])
  return enabled ? value : null
}
