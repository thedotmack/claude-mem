// A clock for times on screen that count up (live-motion.tsx).
import { useEffect, useState } from 'react'

/** One shared clock: every subscriber re-renders on the same tick, so times on screen never disagree. */
const listeners = new Set<(now: number) => void>()
let clock: ReturnType<typeof setInterval> | undefined
const CLOCK_TICK_MS = 15_000

function subscribeToClock(listener: (now: number) => void) {
  listeners.add(listener)
  clock ??= setInterval(() => { const now = Date.now(); for (const notify of listeners) notify(now) }, CLOCK_TICK_MS)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) { clearInterval(clock); clock = undefined }
  }
}

/** The current time, updated every 15 seconds. */
export function useNow(enabled = true) {
  const [now, setNow] = useState(() => Date.now())
  const [wasEnabled, setWasEnabled] = useState(enabled)
  // Re-read the clock in the render that turns it on, so the first live paint is never stale.
  if (enabled !== wasEnabled) {
    setWasEnabled(enabled)
    if (enabled) setNow(Date.now())
  }
  useEffect(() => enabled ? subscribeToClock(setNow) : undefined, [enabled])
  return now
}
