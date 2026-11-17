import { useSyncExternalStore } from 'react'

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
