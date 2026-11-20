// Run with `npm test`. What the change ticker shows from the feed's connection (components/live-motion.tsx).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getConnectionStatus } from './connection-status.ts'
import { TICKER_OFFERS_RECONNECT, TICKER_STATES, tickerState } from './change-ticker.ts'

const NOW = 100_000
/** The connection evidence of a page whose stream delivers heartbeats and whose saved work was read just now. */
const healthy = { transportConnected: true, now: NOW, lastEventAt: NOW - 1_000, sourceConnected: true, lastSuccessfulCheckAt: '2026-11-16T22:00:00Z', lastSuccessfulCheckReceivedAt: NOW - 1_000 }

test('while a page connects the ticker says it is connecting, with no Reconnect (it said "Not live · Reconnect")', () => {
  const connecting = getConnectionStatus({ now: NOW })
  assert.equal(connecting.state, 'connecting')
  assert.equal(tickerState(connecting, false, 0), 'connecting')
  // A stream that opened but sent nothing yet is still connecting.
  assert.equal(tickerState(getConnectionStatus({ transportConnected: true, now: NOW }), false, 0), 'connecting')
  assert.equal(TICKER_OFFERS_RECONNECT.connecting, false)
})

test('live, it is quiet or shows its changes; the sample is always live', () => {
  const live = getConnectionStatus(healthy)
  assert.equal(live.state, 'live')
  assert.equal(tickerState(live, false, 0), 'quiet')
  assert.equal(tickerState(live, false, 3), 'changes')
  assert.equal(tickerState(getConnectionStatus({ now: NOW }), true, 0), 'quiet')
})

test('Reconnect only where reading the page again can help: the stream down or silent', () => {
  const reconnecting = getConnectionStatus({ now: NOW, reconnecting: true, lastEventAt: NOW - 1_000 })
  assert.equal(tickerState(reconnecting, false, 0), 'stream-down')
  const silent = getConnectionStatus({ ...healthy, lastEventAt: NOW - 60_000 })
  assert.equal(silent.state, 'stale')
  assert.equal(tickerState(silent, false, 2), 'stream-down', 'a silent stream hides the changes until it is live again')
  assert.equal(TICKER_OFFERS_RECONNECT['stream-down'], true)
})

test('messages arriving while the saved work is not current: not live, and no Reconnect, since a reload cannot fix it', () => {
  const unreadable = getConnectionStatus({ ...healthy, sourceConnected: false })
  assert.equal(unreadable.state, 'unavailable')
  assert.equal(tickerState(unreadable, false, 0), 'source-behind')
  const oldCheck = getConnectionStatus({ ...healthy, lastSuccessfulCheckReceivedAt: NOW - 60_000 })
  assert.equal(oldCheck.state, 'stale')
  assert.equal(tickerState(oldCheck, false, 0), 'source-behind')
  const staleActivity = getConnectionStatus({ ...healthy, activityCheckedAt: '2026-11-16T21:00:00Z', activityAgeAtReceipt: 200_000, activityReceivedAt: NOW - 1_000 })
  assert.equal(staleActivity.state, 'stale')
  assert.equal(tickerState(staleActivity, false, 0), 'source-behind')
  assert.equal(TICKER_OFFERS_RECONNECT['source-behind'], false)
})

test('of all the ticker states, only stream-down offers Reconnect', () => {
  assert.deepEqual(TICKER_STATES.filter((state) => TICKER_OFFERS_RECONNECT[state]), ['stream-down'])
})
