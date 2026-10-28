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
