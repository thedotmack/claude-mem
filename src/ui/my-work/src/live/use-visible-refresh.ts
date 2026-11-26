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
 */
export function useVisibleRefresh<T>(
  enabled: boolean,
  read: (signal: AbortSignal) => Promise<T>,
  nextCheckAt: (value: T, now: number) => number | null,
  retryMs = VISIBLE_REFRESH_RETRY_MS,
): T | null {
  const [value, setValue] = useState<T | null>(null)
  const latest = useRef({ read, nextCheckAt })
  latest.current = { read, nextCheckAt }
  useEffect(() => {
    if (!enabled) return
    let pending: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let listening = true
    const later = (at: number) => { timer = setTimeout(refresh, Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS)) }
    const stop = () => {
      if (!listening) return
      listening = false
      clearTimeout(timer)
      window.removeEventListener('pageshow', onPageShow)
      document.removeEventListener('visibilitychange', refresh)
    }
    async function refresh() {
      if (!listening || document.visibilityState === 'hidden') return
      pending?.abort()
      clearTimeout(timer)
      const controller = new AbortController()
      pending = controller
      try {
        const next = await latest.current.read(controller.signal)
        if (controller.signal.aborted) return
        setValue(next)
        const at = latest.current.nextCheckAt(next, Date.now())
        if (at === Number.POSITIVE_INFINITY) stop()
        else if (at !== null) later(at)
      } catch {
        if (!controller.signal.aborted) later(Date.now() + retryMs)
      }
    }
    function onPageShow(event: PageTransitionEvent) { if (event.persisted) void refresh() }
    void refresh()
    window.addEventListener('pageshow', onPageShow)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      pending?.abort()
      stop()
    }
  }, [enabled, retryMs])
  return enabled ? value : null
}
