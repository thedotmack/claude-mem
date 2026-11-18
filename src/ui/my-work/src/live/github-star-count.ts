// The claude-mem repo's GitHub star count, for the "Star on GitHub" row in the header menu. The same rules as the
// classic viewer's star count (src/ui/viewer/hooks/useGitHubStars.ts), so the two behave alike: GitHub's own 10 s
// request limit, one read per page that is kept (a failed one too), a count that is a whole number of stars, and no
// count when GitHub gives none, with the reason in the console. My Work also keeps, across reloads, a count read
// within GitHub's hourly window and GitHub's word that this address has used up its hourly limit, so reloading the
// page does not ask again. No React and no DOM here, so `node --test` loads it (github-star-count.test.ts).

export const CLAUDE_MEM_REPO_API_URL = 'https://api.github.com/repos/thedotmack/claude-mem'

/**
 * GitHub ends any REST API request that takes longer than 10 seconds (docs.github.com, REST API troubleshooting,
 * "Timeouts"), so waiting longer cannot bring a count. The classic viewer waits the same.
 */
export const GITHUB_STARS_TIMEOUT_MS = 10_000

/**
 * api.github.com allows 60 unauthenticated requests an hour per address, shared by every tab and every app on the
 * machine, counted in hourly windows (docs.github.com, "Rate limits for the REST API"). A count read within the last
 * hour is used after a reload instead of asking again, so My Work spends at most one of those an hour.
 */
export const STAR_COUNT_KEPT_FOR_MS = 60 * 60 * 1000

/** Where the last count, and GitHub's limit, are kept between visits (localStorage, this browser only). */
export const STAR_COUNT_STORAGE_KEY = 'claude-mem:my-work:github-stars'

/** What the star count shows: a quiet bar while GitHub is asked, the number, or no number when GitHub gave none. */
export type StarCountRead = { state: 'reading' } | { state: 'read'; count: number } | { state: 'unavailable' }

export interface StarCountStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** What the last visit learned: a count and when it was read, and until when GitHub refuses this address. */
interface KeptStarCount { count?: number; readAt?: number; limitedUntil?: number }

const isStarCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * One page's reader. The first call asks (or uses what was kept); every later call answers the same, so the page asks
 * GitHub at most once whatever it shows. Resolves to the count, or to null when there is none to show.
 */
export function createStarCountReader({ fetchImpl, storage, now }: { fetchImpl: typeof fetch; storage: StarCountStorage | null; now: () => number }): () => Promise<number | null> {
  let read: Promise<number | null> | null = null

  const kept = (): KeptStarCount => {
    try {
      const value: unknown = JSON.parse(storage?.getItem(STAR_COUNT_STORAGE_KEY) ?? 'null')
      return value && typeof value === 'object' ? value as KeptStarCount : {}
    } catch (error) {
      console.warn('[my-work] The kept GitHub star count could not be read; asking GitHub again:', error)
      return {}
    }
  }
  const keep = (value: KeptStarCount) => {
    try {
      storage?.setItem(STAR_COUNT_STORAGE_KEY, JSON.stringify(value))
    } catch (error) {
      console.warn('[my-work] The GitHub star count could not be kept for the next visit:', error)
    }
  }

  const ask = async (): Promise<number | null> => {
    const last = kept()
    if (isStarCount(last.count) && typeof last.readAt === 'number' && now() - last.readAt >= 0 && now() - last.readAt < STAR_COUNT_KEPT_FOR_MS) return last.count
    if (typeof last.limitedUntil === 'number' && now() < last.limitedUntil) {
      console.error(`Failed to fetch GitHub stars: GitHub's hourly limit for this address is used up until ${new Date(last.limitedUntil).toISOString()}`)
      return null
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`GitHub did not answer within ${GITHUB_STARS_TIMEOUT_MS} ms`)), GITHUB_STARS_TIMEOUT_MS)
    try {
      const response = await fetchImpl(CLAUDE_MEM_REPO_API_URL, { signal: controller.signal })
      if (!response.ok) {
        // GitHub's own word that the limit is used up, and when it resets (seconds since 1970, x-ratelimit-reset).
        const reset = Number(response.headers.get('x-ratelimit-reset'))
        if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) {
          keep({ limitedUntil: reset * 1000 })
        }
        throw new Error(`GitHub API error: ${response.status}`)
      }
      const data: unknown = await response.json()
      const stars = typeof data === 'object' && data !== null ? (data as { stargazers_count?: unknown }).stargazers_count : undefined
      if (!isStarCount(stars)) throw new Error('GitHub answered without a star count')
      keep({ count: stars, readAt: now() })
      return stars
    } catch (error) {
      console.error('Failed to fetch GitHub stars:', error)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return () => {
    read ??= ask()
    return read
  }
}
