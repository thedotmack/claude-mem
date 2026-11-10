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

test('a late share response cannot bring back the link a later stop removed', withHeldFetch(async () => {
  const shared = shareFocusArea('ordered-stop'); await tick(); const shareCall = next()
  const stopped = stopSharingFocusArea('ordered-stop'); await tick()
  if (held.length) {
    // When both writes are in flight, their HTTP responses can arrive backwards.
    next().release({ status: 200, body: { stopped: true } }); await stopped
    shareCall.release({ status: 200, body: SHARE }); await shared
  } else {
    shareCall.release({ status: 200, body: SHARE }); await shared; await tick()
    next().release({ status: 200, body: { stopped: true } }); await stopped
  }
  assert.equal(shares().shares['ordered-stop'], undefined)
}))

test('the later share keeps its returned link when an earlier share answers last', withHeldFetch(async () => {
  const first = shareFocusArea('ordered-share'); await tick(); const firstCall = next()
  const second = shareFocusArea('ordered-share'); await tick()
  const latest = { ...SHARE, url: 'https://cmem.ai/focus/newest' }
  if (held.length) {
    next().release({ status: 200, body: latest }); await second
    firstCall.release({ status: 200, body: SHARE }); await first
  } else {
    firstCall.release({ status: 200, body: SHARE }); await first; await tick()
    next().release({ status: 200, body: latest }); await second
  }
  assert.equal(shares().shares['ordered-share']?.url, latest.url)
}))

test('an older list response cannot overwrite a newer successful list', withHeldFetch(async () => {
  const older = loadFocusShares(); await tick(); const oldCall = next()
  const newer = loadFocusShares(); await tick(); const newCall = next()
  newCall.release({ status: 200, body: { connected: true, shares: { current: { ...SHARE, publishError: null } } } }); await newer
  oldCall.release({ status: 200, body: { connected: false, shares: {} } }); await older
  assert.equal(shares().connected, true)
  assert.equal(shares().shares.current?.url, SHARE.url)
}))

test('a failed later list does not discard an older successful read', withHeldFetch(async () => {
  const older = loadFocusShares(); await tick(); const oldCall = next()
  const newer = loadFocusShares(); await tick(); next().release({ status: 503, body: { error: 'Unavailable' } }); await newer
  oldCall.release({ status: 200, body: { connected: true, shares: { recovered: { ...SHARE, publishError: null } } } }); await older
  assert.equal(shares().shares.recovered?.url, SHARE.url)
}))

test('one area can stop while another is sharing, and a failed write does not block its successor', withHeldFetch(async () => {
  const first = shareFocusArea('independent-a').catch((error: unknown) => error); await tick(); const firstCall = next()
  const other = stopSharingFocusArea('independent-b'); await tick(); const otherCall = next()
  assert.equal(otherCall.method, 'POST')
  otherCall.release({ status: 200, body: { stopped: true } }); await other
  const retry = shareFocusArea('independent-a'); await tick()
  firstCall.release({ status: 503, body: { error: 'Unavailable' } }); await first; await tick()
  next().release({ status: 200, body: SHARE }); await retry
  assert.equal(shares().shares['independent-a']?.url, SHARE.url)
}))
