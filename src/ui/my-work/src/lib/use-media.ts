import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react'

/**
 * An element's own content width and the page's root font size (px), followed as either changes: a window resize, a
 * classic scrollbar appearing (Chrome on Windows and Linux draws one 15px wide, which a media query does not count), or
 * the root size stepping at the md breakpoint. Measured before paint, so a layout chosen from it never flashes; null
 * until the element is on the page.
 */
export function useWidthOf(ref: RefObject<HTMLElement | null>): { width: number; remPx: number } | null {
  const [measured, setMeasured] = useState<{ width: number; remPx: number } | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const next = { width: element.clientWidth, remPx: parseFloat(getComputedStyle(document.documentElement).fontSize) }
      setMeasured((current) => current && current.width === next.width && current.remPx === next.remPx ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return measured
}

/** Whether a CSS media query matches now, re-rendering when that changes. */
export function useMatchesMedia(query: string) {
  return useSyncExternalStore(
    (onChange) => { const list = window.matchMedia(query); list.addEventListener('change', onChange); return () => list.removeEventListener('change', onChange) },
    () => window.matchMedia(query).matches,
    // Server render (and its tests) has no window: render as if the query does not match.
    () => false,
  )
}

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Whether the reader asked for reduced motion, following a change made while the page is open. Use it where two
 * components lay themselves out by the setting together (the swipe strip and the card over it). motion's
 * useReducedMotion did not follow a change made after its component mounted (seen 2026-11-16: the page matched
 * reduced motion while SwipeToDecide still laid out for motion, and the card covered the strip's word).
 */
export const usePrefersReducedMotion = () => useMatchesMedia(REDUCED_MOTION_QUERY)
