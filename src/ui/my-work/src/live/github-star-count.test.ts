// The header menu's GitHub star count: GitHub is asked at most once a page and at most once an hour across reloads,
// never while it says this address is over its limit, gives up at GitHub's own request limit, and shows no count
// (with the reason in the console) when GitHub gives none.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import {
  CLAUDE_MEM_REPO_API_URL, createStarCountReader, GITHUB_STARS_TIMEOUT_MS, STAR_COUNT_KEPT_FOR_MS, STAR_COUNT_STORAGE_KEY,
  type StarCountStorage,
} from './github-star-count.ts'

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0)

function memoryStorage(initial: Record<string, unknown> = {}): StarCountStorage & { items: Map<string, string> } {
  const items = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]))
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, value) }, items }
}

/** A fetch that answers `body` with `status` and `headers`, and counts its calls. */
function github(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const calls: { url: string; signal: AbortSignal | undefined }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, signal: init?.signal ?? undefined })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('the GitHub star count', () => {
  const errors: unknown[][] = []
  beforeEach(() => { errors.length = 0; mock.method(console, 'error', (...args: unknown[]) => { errors.push(args) }); mock.method(console, 'warn', () => {}) })
  afterEach(() => { mock.restoreAll(); mock.timers.reset() })

  it('is read once for the page, kept, and kept for the next visit within the hour', async () => {
    const storage = memoryStorage()
    const answer = github({ stargazers_count: 117_482 })
    const read = createStarCountReader({ fetchImpl: answer.fetchImpl, storage, now: () => NOW })
    assert.equal(await read(), 117_482)
    assert.equal(await read(), 117_482)
    assert.deepEqual(answer.calls.map((call) => call.url), [CLAUDE_MEM_REPO_API_URL])
    assert.deepEqual(JSON.parse(storage.items.get(STAR_COUNT_STORAGE_KEY)!), { count: 117_482, readAt: NOW })

    const reload = github({ stargazers_count: 1 })
    assert.equal(await createStarCountReader({ fetchImpl: reload.fetchImpl, storage, now: () => NOW + STAR_COUNT_KEPT_FOR_MS - 1 })(), 117_482)
    assert.equal(reload.calls.length, 0, 'a reload within the hour does not ask GitHub')
    assert.equal(await createStarCountReader({ fetchImpl: reload.fetchImpl, storage, now: () => NOW + STAR_COUNT_KEPT_FOR_MS })(), 1)
    assert.equal(reload.calls.length, 1, 'an hour later it asks again')
    assert.equal(STAR_COUNT_KEPT_FOR_MS, 60 * 60 * 1000, "GitHub's hourly window")
  })

  it('shows no count when GitHub answers without one, or refuses, and says why in the console', async () => {
    for (const [body, status] of [[{ message: 'API rate limit exceeded' }, 200], [{ stargazers_count: '117k' }, 200], [{ stargazers_count: -1 }, 200], [{ stargazers_count: 1.5 }, 200], ['<html>', 200], [{}, 403], [{}, 500]] as const) {
      const answer = github(body, status)
      const read = createStarCountReader({ fetchImpl: answer.fetchImpl, storage: memoryStorage(), now: () => NOW })
      assert.equal(await read(), null, JSON.stringify(body))
      assert.equal(await read(), null)
      assert.equal(answer.calls.length, 1, 'a failed read is kept for the page too')
    }
    assert.equal(errors.length, 7)
    assert.ok(errors.every(([words]) => words === 'Failed to fetch GitHub stars:'))
  })

  it('stops asking while GitHub says this address has used its hourly limit, across reloads', async () => {
    const storage = memoryStorage()
    const resetSeconds = Math.floor(NOW / 1000) + 600
    const limited = github({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) })
    assert.equal(await createStarCountReader({ fetchImpl: limited.fetchImpl, storage, now: () => NOW })(), null)
    assert.deepEqual(JSON.parse(storage.items.get(STAR_COUNT_STORAGE_KEY)!), { limitedUntil: resetSeconds * 1000 })

    const reload = github({ stargazers_count: 2 })
    assert.equal(await createStarCountReader({ fetchImpl: reload.fetchImpl, storage, now: () => resetSeconds * 1000 - 1 })(), null)
    assert.equal(reload.calls.length, 0, 'no request before the reset GitHub named')
    assert.match(String(errors.at(-1)?.[0]), /hourly limit for this address is used up until/)
    assert.equal(await createStarCountReader({ fetchImpl: reload.fetchImpl, storage, now: () => resetSeconds * 1000 })(), 2)
    assert.equal(reload.calls.length, 1, 'asks again once the limit resets')

    // A refusal without GitHub's limit headers is not remembered past the page.
    const other = memoryStorage()
    await createStarCountReader({ fetchImpl: github({}, 403).fetchImpl, storage: other, now: () => NOW })()
    assert.equal(other.items.has(STAR_COUNT_STORAGE_KEY), false)
  })

  it("gives up at GitHub's own 10 second request limit", async () => {
    assert.equal(GITHUB_STARS_TIMEOUT_MS, 10_000)
    mock.timers.enable({ apis: ['setTimeout'] })
    let signal: AbortSignal | undefined
    const hanging = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason)))
    }) as typeof fetch
    const counted = createStarCountReader({ fetchImpl: hanging, storage: memoryStorage(), now: () => NOW })()
    await Promise.resolve()
    assert.ok(signal instanceof AbortSignal)
    mock.timers.tick(GITHUB_STARS_TIMEOUT_MS - 1)
    assert.equal(signal.aborted, false)
    mock.timers.tick(1)
    assert.equal(signal.aborted, true)
    assert.equal(await counted, null)
    assert.match(String(errors.at(-1)?.[1]), /did not answer within 10000 ms/)
  })

  it('works without storage (blocked site data) and with kept data it cannot read', async () => {
    const answer = github({ stargazers_count: 5 })
    assert.equal(await createStarCountReader({ fetchImpl: answer.fetchImpl, storage: null, now: () => NOW })(), 5)
    const broken: StarCountStorage = { getItem: () => '{not json', setItem: () => { throw new Error('QuotaExceededError') } }
    assert.equal(await createStarCountReader({ fetchImpl: answer.fetchImpl, storage: broken, now: () => NOW })(), 5)
    assert.equal(answer.calls.length, 2)
  })
})
