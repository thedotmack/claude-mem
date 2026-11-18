// The header's Live chip names one problem, the most important one, and says "Live" only when the feed is.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getConnectionStatus, type ConnectionStatusInput } from './connection-status.ts'
import { LIVE_CHIP_PROBLEMS, liveChipProblem } from './live-chip.ts'
import type { SyncStatusForDisplay } from '../../../viewer/utils/sync-presentation.ts'

const NOW = 1_000_000
const CHECKED_AT = new Date(Date.UTC(2026, 10, 16, 2, 9, 24)).toISOString()

/** A feed that is live: connected, a heartbeat 10 ms ago, a successful check received 10 ms ago. */
const LIVE: ConnectionStatusInput = {
  now: NOW, transportConnected: true, lastEventAt: NOW - 10, sourceConnected: true,
  lastSuccessfulCheckAt: CHECKED_AT, lastSuccessfulCheckReceivedAt: NOW - 10,
}

function sync(state: SyncStatusForDisplay['state']): SyncStatusForDisplay {
  return {
    configured: true, state, mode: 'polling', observedAt: NOW, checkedAt: NOW, message: `Sync is ${state}.`,
    download: { lastSuccessAt: NOW }, projection: { remaining: '0' },
    completeness: { pushQuarantine: 0, pullQuarantine: 0, excludedNative: 0, scope: 'eligible' },
  }
}

const connection = (input: Partial<ConnectionStatusInput>) => getConnectionStatus({ ...LIVE, ...input })
const REFUSED = { attention: true }
const FINE = { attention: false }

describe('the Live chip', () => {
  it('says "Live" when the feed is live, the cloud copy is current or quietly unknown, and sharing is fine', () => {
    assert.equal(liveChipProblem(connection({ sync: sync('current'), syncReceivedAt: NOW }), FINE), null)
    assert.equal(liveChipProblem(connection({}), FINE), null, 'cloud freshness not reported yet is not a problem')
    assert.equal(liveChipProblem(connection({ sync: { ...sync('unconfigured'), configured: false } }), null), null, 'cloud sync off is not a problem')
  })

  it('never says "Live" before the feed is: a first connection is named', () => {
    assert.equal(liveChipProblem(connection({ transportConnected: false, lastEventAt: null }), FINE), 'feed-connecting')
  })

  it('names the cloud copy falling behind, and refused sharing before it', () => {
    const behind = connection({ sync: sync('catching-up'), syncReceivedAt: NOW })
    assert.equal(liveChipProblem(behind, FINE), 'cloud-behind')
    for (const state of ['paused', 'offline', 'partial'] as const) {
      assert.equal(liveChipProblem(connection({ sync: sync(state), syncReceivedAt: NOW }), FINE), 'cloud-behind', state)
    }
    assert.equal(liveChipProblem(behind, REFUSED), 'sharing-refused')
  })

  it('puts the page’s own feed first: without it nothing on screen is current', () => {
    const cloudBehind = { sync: sync('offline'), syncReceivedAt: NOW }
    assert.equal(liveChipProblem(connection({ ...cloudBehind, sourceConnected: false }), REFUSED), 'feed-unavailable')
    assert.equal(liveChipProblem(connection({ ...cloudBehind, lastSuccessfulCheckReceivedAt: 1 }), REFUSED), 'feed-stale')
    assert.equal(liveChipProblem(connection({ ...cloudBehind, transportConnected: false, reconnecting: true }), REFUSED), 'feed-reconnecting')
  })

  it('names the feed whenever it is not live, whatever else is wrong (FEED_PROBLEM covers every state)', () => {
    const notLive = [
      connection({ sourceConnected: false }),
      connection({ lastSuccessfulCheckReceivedAt: 1 }),
      connection({ transportConnected: false, reconnecting: true }),
      connection({ transportConnected: false, reconnecting: true, lastEventAt: 1 }),
      connection({ transportConnected: false, lastEventAt: null }),
      connection({ activityCheckedAt: CHECKED_AT }),
    ]
    assert.deepEqual([...new Set(notLive.map((status) => status.state))].sort(), ['connecting', 'reconnecting', 'stale', 'unavailable'])
    for (const status of notLive) {
      assert.equal(status.isLive, false)
      assert.match(liveChipProblem({ ...status, sync: connection({ sync: sync('offline'), syncReceivedAt: NOW }).sync }, REFUSED) ?? 'live', /^feed-/, status.state)
    }
  })

  it('every listed problem can be the one the chip names', () => {
    const named = new Set([
      liveChipProblem(connection({ sourceConnected: false }), null),
      liveChipProblem(connection({ lastSuccessfulCheckReceivedAt: 1 }), null),
      liveChipProblem(connection({ transportConnected: false, reconnecting: true }), null),
      liveChipProblem(connection({ transportConnected: false, lastEventAt: null }), null),
      liveChipProblem(connection({}), REFUSED),
      liveChipProblem(connection({ sync: sync('stale'), syncReceivedAt: NOW }), null),
    ])
    assert.deepEqual([...named].sort(), [...LIVE_CHIP_PROBLEMS].sort())
  })
})
