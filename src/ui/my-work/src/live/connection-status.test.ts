// Ported from claude-mem v15.0.1 tests/ui/work-view-live-status.test.ts (bun:test → node:test).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getConnectionStatus, LOCAL_FEED_STALE_AFTER_MS } from './connection-status.ts'

const wallNow = Date.parse('2026-10-17T12:00:00.000Z')
const check = '2026-10-17T11:59:59.000Z'
const live = { transportConnected: true, now: 100_000, lastEventAt: 99_000,
  sourceConnected: true, lastSuccessfulCheckAt: check, lastSuccessfulCheckReceivedAt: 99_000, wallNow }

describe('local feed status', () => {
  it('requires both a fresh SSE signal and a successful local check', () => {
    const status = getConnectionStatus(live)
    assert.equal(status.state, 'live')
    assert.equal(status.label, 'Live updates')
    assert.equal(status.isLive, true)
    assert.equal(status.eventAgeMs, 1000)
    assert.equal(status.clockSkew, false)
    assert.ok(status.tooltip.includes(`Last successful local check: ${check}`))
  })
  it('starts connecting with no implied presence', () => {
    assert.equal(getConnectionStatus({ now: 0 }).label, 'Connecting to local feed')
    assert.equal(getConnectionStatus({ now: 0 }).isLive, false)
  })
  it('does not use an HTTP snapshot as proof of a live event feed', () => {
    assert.equal(getConnectionStatus({ ...live, lastEventAt: null }).state, 'connecting')
    assert.equal(getConnectionStatus({ ...live, transportConnected: false }).isLive, false)
  })
  it('shows reconnecting immediately even if the last signal is fresh', () => {
    const status = getConnectionStatus({ ...live, transportConnected: false, reconnecting: true })
    assert.equal(status.label, 'Reconnecting to local feed')
    assert.equal(status.isLive, false)
    assert.ok(status.tooltip.includes(check))
  })
  it('expires a silent open event stream after two heartbeats plus margin', () => {
    assert.equal(getConnectionStatus({ ...live, now: live.lastEventAt + LOCAL_FEED_STALE_AFTER_MS }).isLive, true)
    assert.equal(getConnectionStatus({ ...live, now: live.lastEventAt + LOCAL_FEED_STALE_AFTER_MS + 1 }).label, 'Local feed stale')
  })
  it('marks retained work stale when reconnecting exceeds the freshness window', () => {
    const status = getConnectionStatus({ ...live, transportConnected: false, reconnecting: true,
      now: live.lastEventAt + LOCAL_FEED_STALE_AFTER_MS + 1 })
    assert.equal(status.state, 'stale')
    assert.equal(status.isLive, false)
    assert.ok(status.detail.includes('Reconnecting'))
    assert.ok(status.tooltip.includes(check))
  })
  it('reports an unreadable source even while heartbeats arrive', () => {
    const status = getConnectionStatus({ ...live, sourceConnected: false })
    assert.equal(status.label, 'Local source unavailable')
    assert.equal(status.isLive, false)
    assert.equal(status.lastSuccessfulCheckAt, check)
  })
  it('does not reuse a stale source success just because messages arrive', () => {
    assert.equal(getConnectionStatus({ ...live, lastSuccessfulCheckReceivedAt: 1 }).state, 'stale')
  })
  it('does not infer source health from an unknown source flag', () => {
    assert.equal(getConnectionStatus({ ...live, sourceConnected: null }).isLive, false)
  })
  it('requires a valid successful-check timestamp for the evidence tooltip', () => {
    for (const stamp of [null, 'yesterday', '123', '<script>']) {
      const status = getConnectionStatus({ ...live, lastSuccessfulCheckAt: stamp })
      assert.equal(status.isLive, false)
      assert.ok(status.tooltip.includes('not yet confirmed'))
    }
  })
  it('uses monotonic receipt age when the source clock is ahead or behind', () => {
    for (const offset of [-3_600_000, 3_600_000]) {
      const stamp = new Date(Date.parse(check) + offset).toISOString()
      const status = getConnectionStatus({ ...live, lastSuccessfulCheckAt: stamp })
      assert.equal(status.state, 'live')
      assert.equal(status.clockSkew, true)
      assert.ok(status.tooltip.includes(stamp))
      assert.ok(status.tooltip.includes('freshness uses received heartbeats'))
    }
  })
  it('does not extend liveness when the wall clock jumps after receipt', () => {
    assert.equal(getConnectionStatus({ ...live, now: 200_000, wallNow: wallNow - 3_600_000 }).state, 'stale')
  })
  it('rejects mismatched clock origins instead of keeping future events live forever', () => {
    assert.equal(getConnectionStatus({ ...live, lastEventAt: wallNow }).state, 'stale')
    assert.equal(getConnectionStatus({ ...live, now: NaN }).isLive, false)
  })
  it('can be live while recorded work is old or quiet', () => {
    const status = getConnectionStatus(live)
    assert.equal(status.state, 'live')
    assert.ok(status.tooltip.includes('does not indicate an agent is running'))
  })
  it('falls back to the documented threshold for invalid configuration', () => {
    assert.equal(getConnectionStatus({ ...live, staleAfterMs: -1 }).staleAfterMs, 35_000)
  })
})
