import { useEffect, useState } from 'react';

/**
 * GitHub ends any REST API request that takes longer than 10 seconds (docs.github.com,
 * REST API troubleshooting, "Timeouts"), so waiting longer cannot bring a count.
 */
export const GITHUB_STARS_TIMEOUT_MS = 10_000;

// One read per repository for the life of the page: api.github.com allows 60 unauthenticated
// requests an hour per address, and every open viewer tab shares that address.
const starCounts = new Map<string, Promise<number | null>>();

/**
 * The repository's star count from api.github.com, read once per page and kept; null when
 * GitHub could not be reached in time or answered without a count (the reason goes to the console).
 */
export function readStarCount(username: string, repo: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const key = `${username}/${repo}`;
  let count = starCounts.get(key);
  if (!count) {
    count = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GITHUB_STARS_TIMEOUT_MS);
      try {
        const response = await fetchImpl(`https://api.github.com/repos/${key}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
        const data: unknown = await response.json();
        const stars = typeof data === 'object' && data !== null ? (data as { stargazers_count?: unknown }).stargazers_count : undefined;
        if (typeof stars !== 'number' || !Number.isSafeInteger(stars) || stars < 0) {
          throw new Error('GitHub answered without a star count');
        }
        return stars;
      } catch (error) {
        console.error('Failed to fetch GitHub stars:', error);
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();
    starCounts.set(key, count);
  }
  return count;
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
