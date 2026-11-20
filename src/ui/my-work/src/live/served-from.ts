const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Served by the cloud viewer (claude-mem services/viewer-host) rather than the worker on this computer. */
export function isServedFromCloud(hostname: string | undefined): boolean {
  return typeof hostname === 'string' && hostname.length > 0 && !LOOPBACK_HOSTNAMES.has(hostname)
}

/** The part of `document` that says whether the tab is on screen. */
export interface PageVisibility {
  readonly visibilityState: string
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/** This page's hostname; undefined outside a browser. */
export const browserHostname = () => (globalThis as { location?: { hostname?: string } }).location?.hostname
/** This page's `document`; undefined outside a browser. */
export const browserVisibility = () => (globalThis as { document?: PageVisibility }).document

/**
 * Runs `work` now, or, on a cloud page whose tab is hidden, once the tab is shown again. Returns a cancel function.
 * A cloud viewer's machine sleeps only while nothing reaches it (Fly stops a machine with no traffic), so a timed
 * request from a background tab would keep it running. On this computer `work` always runs now.
 */
export function whenCloudPageVisible(work: () => void, hostname = browserHostname(), visibility = browserVisibility()): () => void {
  if (!visibility || !isServedFromCloud(hostname) || visibility.visibilityState !== 'hidden') {
    work()
    return () => {}
  }
  const shown = () => {
    if (visibility.visibilityState === 'hidden') return
    visibility.removeEventListener('visibilitychange', shown)
    work()
  }
  visibility.addEventListener('visibilitychange', shown)
  return () => visibility.removeEventListener('visibilitychange', shown)
}

/**
 * A timed request: after `delayMs`, runs `work`, or, on a cloud page whose tab is hidden then, once the tab is shown
 * again. The returned function cancels both the timer and the wait. On this computer it is a plain setTimeout.
 */
export function setTimeoutThenWaitUntilCloudPageVisible(work: () => void, delayMs: number, hostname = browserHostname(), visibility = browserVisibility()): () => void {
  let cancelWaitUntilVisible: (() => void) | undefined
  const timer = setTimeout(() => { cancelWaitUntilVisible = whenCloudPageVisible(work, hostname, visibility) }, delayMs)
  return () => { clearTimeout(timer); cancelWaitUntilVisible?.() }
}
