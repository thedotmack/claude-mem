import { useEffect, useState } from 'react';

// The repository's GitHub star count, for the header menu's "Star" link: GitHub's own 10 s request limit, one read
// per page that is kept (a failed one too), a count that is a whole number of stars, a count read within GitHub's
// hourly window kept across reloads, GitHub's word that this address has used up its hourly limit kept until the
// reset it names, and no count when GitHub gives none, with the reason in the console.

/**
 * GitHub ends any REST API request that takes longer than 10 seconds (docs.github.com,
 * REST API troubleshooting, "Timeouts"), so waiting longer cannot bring a count.
 */
export const GITHUB_STARS_TIMEOUT_MS = 10_000;

/**
 * api.github.com allows 60 unauthenticated requests an hour per address, shared by every tab and every app on the
 * machine, counted in hourly windows (docs.github.com, "Rate limits for the REST API"). A count read within the last
 * hour is used after a reload instead of asking again, so the viewer spends at most one of those an hour per repository.
 */
export const STAR_COUNT_KEPT_FOR_MS = 60 * 60 * 1000;

/** Where the last count, and GitHub's limit, are kept between visits (localStorage, this browser only), per repository. */
export const STAR_COUNT_STORAGE_KEY = 'claude-mem:viewer:github-stars';

export function starCountStorageKey(username: string, repo: string): string {
  return `${STAR_COUNT_STORAGE_KEY}:${username}/${repo}`;
}

export interface StarCountStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** The one call the reader makes: GET the repository from api.github.com, stoppable by `signal`. */
type FetchStarCount = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/** What the last visit learned: a count and when it was read, and until when GitHub refuses this address. */
interface KeptStarCount { count?: number; readAt?: number; limitedUntil?: number }

const isStarCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * One page's reader. The first call for a repository asks (or uses what was kept); every later call for it answers
 * the same, so the page asks GitHub at most once per repository whatever it shows. Resolves to the count, or to null
 * when there is none to show. `fetchImpl` on a call replaces the reader's own for that repository's first read.
 */
export function createStarCountReader({ fetchImpl, storage, now }: {
  fetchImpl: FetchStarCount;
  storage: StarCountStorage | null;
  now: () => number;
}): (username: string, repo: string, fetchOverride?: FetchStarCount) => Promise<number | null> {
  const reads = new Map<string, Promise<number | null>>();

  const ask = async (username: string, repo: string, fetchWith: FetchStarCount): Promise<number | null> => {
    const storageKey = starCountStorageKey(username, repo);
    const kept = (): KeptStarCount => {
      try {
        const value: unknown = JSON.parse(storage?.getItem(storageKey) ?? 'null');
        return value && typeof value === 'object' ? value as KeptStarCount : {};
      } catch (error) {
        console.warn('[viewer] The kept GitHub star count could not be read; asking GitHub again:', error);
        return {};
      }
    };
    const keep = (value: KeptStarCount) => {
      try {
        storage?.setItem(storageKey, JSON.stringify(value));
      } catch (error) {
        console.warn('[viewer] The GitHub star count could not be kept for the next visit:', error);
      }
    };

    const last = kept();
    if (isStarCount(last.count) && typeof last.readAt === 'number' && now() - last.readAt >= 0 && now() - last.readAt < STAR_COUNT_KEPT_FOR_MS) return last.count;
    if (typeof last.limitedUntil === 'number' && now() < last.limitedUntil) {
      console.error(`Failed to fetch GitHub stars: GitHub's hourly limit for this address is used up until ${new Date(last.limitedUntil).toISOString()}`);
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`GitHub did not answer within ${GITHUB_STARS_TIMEOUT_MS} ms`)), GITHUB_STARS_TIMEOUT_MS);
    try {
      const response = await fetchWith(`https://api.github.com/repos/${username}/${repo}`, { signal: controller.signal });
      if (!response.ok) {
        // GitHub's own word that the limit is used up, and when it resets (seconds since 1970, x-ratelimit-reset).
        const reset = Number(response.headers.get('x-ratelimit-reset'));
        if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) {
          keep({ limitedUntil: reset * 1000 });
        }
        throw new Error(`GitHub API error: ${response.status}`);
      }
      const data: unknown = await response.json();
      const stars = typeof data === 'object' && data !== null ? (data as { stargazers_count?: unknown }).stargazers_count : undefined;
      if (!isStarCount(stars)) throw new Error('GitHub answered without a star count');
      keep({ count: stars, readAt: now() });
      return stars;
    } catch (error) {
      console.error('Failed to fetch GitHub stars:', error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  return (username, repo, fetchOverride) => {
    const key = `${username}/${repo}`;
    let read = reads.get(key);
    if (!read) {
      read = ask(username, repo, fetchOverride ?? fetchImpl);
      reads.set(key, read);
    }
    return read;
  };
}

/** localStorage, or none outside a browser page or when the browser blocks site data (the count then lasts this page only). */
function browserStorage(): StarCountStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch (error) {
    console.warn('[viewer] Site data is blocked, so the GitHub star count is not kept between visits:', error);
    return null;
  }
}

/** This page's one reader: every place that shows the count shares its one read per repository. */
const pageReader = createStarCountReader({ fetchImpl: (input, init) => fetch(input, init), storage: browserStorage(), now: () => Date.now() });

/**
 * The repository's star count from api.github.com, read once per page and kept (createStarCountReader); null when
 * GitHub could not be reached in time or answered without a count (the reason goes to the console).
 */
export function readStarCount(username: string, repo: string, fetchImpl?: FetchStarCount): Promise<number | null> {
  return pageReader(username, repo, fetchImpl);
}

/**
 * The star count for a "Star" link. `enabled` defers the read until the count can be seen
 * (the header asks when its "…" menu first opens); `failed` means the link shows no count.
 */
export function useGitHubStars(username: string, repo: string, enabled = true) {
  const [stars, setStars] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setIsLoading(true);
    void readStarCount(username, repo).then(count => {
      if (cancelled) return;
      setStars(count);
      setFailed(count === null);
      setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [username, repo, enabled]);

  return { stars, isLoading, failed, repoUrl: `https://github.com/${username}/${repo}` };
}

/** "117.4k" for the compact count beside the word Star. */
export function formatStarCount(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}
