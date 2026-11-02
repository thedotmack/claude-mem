// Late answers from the worker never undo a newer share, stop or forget in My Work.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { focusSharesNow as shares, loadFocusShares, readFocusShareComments, shareFocusArea, stopSharingFocusArea } from './focus-shares.ts'

type Answer = { status: number; body: unknown }
const held: Array<{ url: string; method: string; release: (answer: Answer) => void }> = []
const heldFetch = ((url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
  held.push({ url, method: init?.method ?? 'GET', release: (answer) => resolve(new Response(JSON.stringify(answer.body), { status: answer.status })) })
})) as typeof fetch
// Every test file shares one process in the fast lane, so the real fetch comes back after each test.
const withHeldFetch = (run: () => Promise<void>) => async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = heldFetch
  try { await run() } finally { globalThis.fetch = realFetch; held.length = 0 }
}
const next = () => held.shift()!
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const SHARE = { url: 'https://cmem.ai/focus/aaaa', sharedAt: '2026-11-01T00:00:00Z', publishedAt: '2026-11-01T00:00:01Z', sent: true }

test('an older share list does not bring back a stopped link or hide a new one', withHeldFetch(async () => {
  const shared = shareFocusArea('area-1'); await tick(); next().release({ status: 200, body: SHARE }); await shared
  const oldList = loadFocusShares(); await tick(); const listCall = next()
  const stopped = stopSharingFocusArea('area-1'); await tick(); next().release({ status: 200, body: { stopped: true } }); await stopped
  listCall.release({ status: 200, body: { connected: true, shares: { 'area-1': { ...SHARE, publishError: null } } } }); await oldList
  assert.equal(shares().shares['area-1'], undefined)
}))

test('a comment read that answers 410 for the old link leaves the new share on screen', withHeldFetch(async () => {
  const shared = shareFocusArea('area-2'); await tick(); next().release({ status: 200, body: SHARE }); await shared
  const oldRead = readFocusShareComments('area-2').catch((error: unknown) => error); await tick(); const readCall = next()
  const stopped = stopSharingFocusArea('area-2'); await tick(); next().release({ status: 200, body: { stopped: true } }); await stopped
  const again = shareFocusArea('area-2'); await tick(); next().release({ status: 200, body: { ...SHARE, url: 'https://cmem.ai/focus/bbbb' } }); await again
  readCall.release({ status: 410, body: { error: 'This area is no longer shared.' } }); await oldRead
  assert.equal(shares().shares['area-2']?.url, 'https://cmem.ai/focus/bbbb')
}))
