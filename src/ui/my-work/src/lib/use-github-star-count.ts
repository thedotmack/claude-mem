import { useEffect, useState } from 'react'
import { createStarCountReader, type StarCountRead, type StarCountStorage } from '@/live/github-star-count'

/** localStorage, or none when the browser blocks site data (the count then lasts this page only). */
function browserStorage(): StarCountStorage | null {
  try {
    return window.localStorage
  } catch (error) {
    console.warn('[my-work] Site data is blocked, so the GitHub star count is not kept between visits:', error)
    return null
  }
}

/** This page's one reader: every place that shows the count shares its one read (live/github-star-count.ts). */
const readStarCount = createStarCountReader({ fetchImpl: (input, init) => fetch(input, init), storage: browserStorage(), now: () => Date.now() })

/**
 * The claude-mem repo's GitHub star count. `wanted` puts off the read until the count can be seen: My Work's header
 * shows it only inside its "…" menu, so it asks when the menu first opens. Reading until GitHub answers (at most
 * GITHUB_STARS_TIMEOUT_MS), then the count, or `unavailable` when GitHub gave none (the reason is in the console).
 */
export function useGitHubStarCount(wanted = true): StarCountRead {
  const [read, setRead] = useState<StarCountRead>({ state: 'reading' })
  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    void readStarCount().then((count) => {
      if (!cancelled) setRead(count === null ? { state: 'unavailable' } : { state: 'read', count })
    })
    return () => { cancelled = true }
  }, [wanted])
  return read
}
