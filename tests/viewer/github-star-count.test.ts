// The classic viewer's GitHub star count (src/ui/viewer/hooks/useGitHubStars.ts): GitHub
// is asked at most once a page and at most once an hour across reloads, never while it says this address is over its
// limit, the read gives up at GitHub's own request limit, and no count shows (with the reason in the console) when
// GitHub gives none.
import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from 'bun:test';
import {
  GITHUB_STARS_TIMEOUT_MS, STAR_COUNT_KEPT_FOR_MS, STAR_COUNT_STORAGE_KEY, createStarCountReader, starCountStorageKey,
  type StarCountStorage,
} from '../../src/ui/viewer/hooks/useGitHubStars';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const REPO_API_URL = 'https://api.github.com/repos/thedotmack/claude-mem';
const KEY = starCountStorageKey('thedotmack', 'claude-mem');

function memoryStorage(initial: Record<string, unknown> = {}): StarCountStorage & { items: Map<string, string> } {
  const items = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value); }, items };
}

/** A fetch that answers `body` with `status` and `headers`, and counts its calls. */
function github(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const calls: { url: string; signal: AbortSignal | undefined }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, signal: init?.signal ?? undefined });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const read = (reader: ReturnType<typeof createStarCountReader>) => reader('thedotmack', 'claude-mem');

describe('the viewer\'s GitHub star count', () => {
  let errors: unknown[][];
  let warnings: unknown[][];
  beforeEach(() => {
    errors = [];
    warnings = [];
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
    spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args); });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('keeps its own count under the viewer\'s storage key, not My Work\'s', () => {
    expect(KEY).toBe('claude-mem:viewer:github-stars:thedotmack/claude-mem');
    expect(STAR_COUNT_STORAGE_KEY).not.toContain('my-work');
  });

  it('is read once for the page, kept, and kept for the next visit within the hour', async () => {
    const storage = memoryStorage();
    const answer = github({ stargazers_count: 117_482 });
    const reader = createStarCountReader({ fetchImpl: answer.fetchImpl, storage, now: () => NOW });
    expect(await read(reader)).toBe(117_482);
    expect(await read(reader)).toBe(117_482);
    expect(answer.calls.map(call => call.url)).toEqual([REPO_API_URL]);
    expect(JSON.parse(storage.items.get(KEY)!)).toEqual({ count: 117_482, readAt: NOW });

    const reload = github({ stargazers_count: 1 });
    expect(await read(createStarCountReader({ fetchImpl: reload.fetchImpl, storage, now: () => NOW + STAR_COUNT_KEPT_FOR_MS - 1 }))).toBe(117_482);
    expect(reload.calls.length).toBe(0); // a reload within the hour does not ask GitHub
    expect(await read(createStarCountReader({ fetchImpl: reload.fetchImpl, storage, now: () => NOW + STAR_COUNT_KEPT_FOR_MS }))).toBe(1);
    expect(reload.calls.length).toBe(1); // an hour later it asks again
    expect(STAR_COUNT_KEPT_FOR_MS).toBe(60 * 60 * 1000); // GitHub's hourly window
  });

  it('shows no count when GitHub answers without one, or refuses, and says why in the console', async () => {
    const cases: [unknown, number][] = [
      [{ message: 'API rate limit exceeded' }, 200], [{ stargazers_count: '117k' }, 200], [{ stargazers_count: -1 }, 200],
      [{ stargazers_count: 1.5 }, 200], ['<html>', 200], [{}, 403], [{}, 500],
    ];
    for (const [body, status] of cases) {
      const answer = github(body, status);
      const reader = createStarCountReader({ fetchImpl: answer.fetchImpl, storage: memoryStorage(), now: () => NOW });
      expect(await read(reader)).toBeNull();
      expect(await read(reader)).toBeNull();
      expect(answer.calls.length).toBe(1); // a failed read is kept for the page too
    }
    expect(errors.length).toBe(cases.length);
    expect(errors.every(([words]) => words === 'Failed to fetch GitHub stars:')).toBe(true);
  });

  it('stops asking while GitHub says this address has used its hourly limit, across reloads', async () => {
    const storage = memoryStorage();
    const resetSeconds = Math.floor(NOW / 1000) + 600;
    const limited = github({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) });
    expect(await read(createStarCountReader({ fetchImpl: limited.fetchImpl, storage, now: () => NOW }))).toBeNull();
    expect(JSON.parse(storage.items.get(KEY)!)).toEqual({ limitedUntil: resetSeconds * 1000 });

    const reload = github({ stargazers_count: 2 });
    expect(await read(createStarCountReader({ fetchImpl: reload.fetchImpl, storage, now: () => resetSeconds * 1000 - 1 }))).toBeNull();
    expect(reload.calls.length).toBe(0); // no request before the reset GitHub named
    expect(String(errors.at(-1)?.[0])).toMatch(/hourly limit for this address is used up until/);
    expect(await read(createStarCountReader({ fetchImpl: reload.fetchImpl, storage, now: () => resetSeconds * 1000 }))).toBe(2);
    expect(reload.calls.length).toBe(1); // asks again once the limit resets

    // GitHub's 429 with the same headers counts too.
    const tooMany = memoryStorage();
    await read(createStarCountReader({ fetchImpl: github({}, 429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) }).fetchImpl, storage: tooMany, now: () => NOW }));
    expect(JSON.parse(tooMany.items.get(KEY)!)).toEqual({ limitedUntil: resetSeconds * 1000 });

    // A refusal without GitHub's limit headers is not remembered past the page.
    const other = memoryStorage();
    await read(createStarCountReader({ fetchImpl: github({}, 403).fetchImpl, storage: other, now: () => NOW }));
    expect(other.items.has(KEY)).toBe(false);
  });

  it("gives up at GitHub's own 10 second request limit, and says so in the console", async () => {
    expect(GITHUB_STARS_TIMEOUT_MS).toBe(10_000);
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    // A request that ends only when its signal aborts, as fetch does.
    const hanging = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener('abort', () => reject(signal!.reason));
    })) as typeof fetch;
    const counted = read(createStarCountReader({ fetchImpl: hanging, storage: memoryStorage(), now: () => NOW }));
    expect(signal).toBeInstanceOf(AbortSignal);
    jest.advanceTimersByTime(GITHUB_STARS_TIMEOUT_MS - 1);
    expect(signal!.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(signal!.aborted).toBe(true);
    expect(await counted).toBeNull();
    expect(String(errors.at(-1)?.[1])).toMatch(/did not answer within 10000 ms/);
  });

  it('works without storage (blocked site data) and with kept data it cannot read or write, warning in the console', async () => {
    const answer = github({ stargazers_count: 5 });
    expect(await read(createStarCountReader({ fetchImpl: answer.fetchImpl, storage: null, now: () => NOW }))).toBe(5);
    const broken: StarCountStorage = { getItem: () => '{not json', setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(await read(createStarCountReader({ fetchImpl: answer.fetchImpl, storage: broken, now: () => NOW }))).toBe(5);
    expect(answer.calls.length).toBe(2);
    expect(warnings.map(([words]) => String(words))).toEqual([
      '[viewer] The kept GitHub star count could not be read; asking GitHub again:',
      '[viewer] The GitHub star count could not be kept for the next visit:',
    ]);
  });
});
