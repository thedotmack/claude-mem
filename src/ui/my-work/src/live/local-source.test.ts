import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it, type TestContext } from 'node:test'
import { createLocalSource, type LocalSourceOptions } from './local-source.ts'
import { sampleSource } from './sample-source.ts'
import type { ConversationContinuationEvent, MappedWorkModel, WorkModel } from './work-data-source.ts'
import type { WorkViewOverview } from './work-view-overview.ts'
import type { WorkViewSnapshot } from './work-view-api-types.ts'
import { SaveRefusedError } from '../data.ts'

const SAMPLE = await sampleSource.loadWorkModel()
const FIRST = 'a'.repeat(64)
const SECOND = 'b'.repeat(64)
const THIRD = 'c'.repeat(64)
const source = { kind: 'claude-mem-recorded-agent-activity', mode: 'read-only-sqlite', connected: true, pollIntervalMs: 1000, lastCheckedAt: new Date().toISOString(), lastUpdatedAt: null, error: null, stale: false }
function overview(fingerprint = FIRST): WorkViewOverview {
  const { connection: _connection, ...model } = SAMPLE
  return { version: 1, revision: fingerprint, generatedAt: new Date().toISOString(), source,
    model: { ...model, sourceKind: 'local', requests: [{ ...model.requests[0], id: 'request-a', detailLoaded: false, detailRevision: fingerprint, contentFingerprint: fingerprint, granular: [], conversations: [], prompts: [], workstreams: [], story: [], evidence: [] }] } }
}
function fullRequest(fingerprint = FIRST, id = 'request-a') {
  return { ...SAMPLE.requests[0], id, contentFingerprint: fingerprint, detailRevision: fingerprint, detailLoaded: true }
}
function snapshot(fingerprint = FIRST): WorkViewSnapshot {
  const value: WorkViewSnapshot = JSON.parse(readFileSync(new URL('../../test-fixtures/work-view-snapshot.trimmed.json', import.meta.url), 'utf8'))
  value.humanRequests = [{ ...value.humanRequests[0], id: 'request-a', contentFingerprint: fingerprint }]
  return value
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
class FakeStream {
  readyState = 1
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  handlers = new Map<string, (event: { data: string }) => void>()
  addEventListener(type: string, listener: (event: { data: string }) => void) { this.handlers.set(type, listener) }
  emit(type: string, value: unknown) { this.handlers.get(type)?.({ data: JSON.stringify(value) }) }
  close() { this.closed = true; this.readyState = 2 }
}
/** A page that can be unloaded: it fires 'pagehide' to its listeners, as `window` does on a reload or a closed tab. */
function fakePageUnload() {
  const listeners = new Set<() => void>()
  return {
    addEventListener: (_type: 'pagehide', listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_type: 'pagehide', listener: () => void) => { listeners.delete(listener) },
    hide: () => { for (const listener of [...listeners]) listener() },
    listenerCount: () => listeners.size,
  }
}

function harness(fetcher: typeof fetch, bootstrapTimeoutMs = 100, page: Pick<LocalSourceOptions, 'hostname' | 'visibility' | 'pageUnload'> = {}) {
  const streams: FakeStream[] = []
  const urls: string[] = []
  const local = createLocalSource({ hostname: 'localhost', ...page, fetchImpl: fetcher, bootstrapTimeoutMs,
    eventSourceFactory: (url) => { urls.push(url); const stream = new FakeStream(); streams.push(stream); return stream as unknown as EventSource } })
  return { local, streams, urls }
}

describe('compact local source', () => {
  it('reuses unchanged compact requests while renewing connection health', async () => {
    const { local, streams } = harness(async () => json(overview()))
    const shown: WorkModel[] = []
    const connections: string[] = []
    const stop = local.subscribeToLiveUpdates(model => shown.push(model), connection => connections.push(connection.lastSuccessfulCheckAt!))
    try {
      const first = overview()
      streams[0].emit('work-view-overview', first)
      const requests = shown[0].requests
      const unchanged = overview(SECOND)
      unchanged.model = first.model
      unchanged.source = { ...first.source, lastCheckedAt: new Date(Date.now() + 1000).toISOString() }
      streams[0].emit('work-view-overview', unchanged)
      assert.equal(shown.length, 1)
      assert.equal(connections.at(-1), unchanged.source.lastCheckedAt)
      assert.equal((await local.loadWorkModel()).requests, requests)
    } finally { stop() }
  })

  it('publishes changed clock labels and device metadata even with the same revision', () => {
    const { local, streams } = harness(async () => json(overview()))
    const shown: WorkModel[] = []
    const stop = local.subscribeToLiveUpdates(model => shown.push(model), () => {})
    try {
      const first = overview()
      streams[0].emit('work-view-overview', first)
      const aged = structuredClone(first)
      aged.model.requests[0].progress.reviewedAt = 'A minute ago'
      streams[0].emit('work-view-overview', aged)
      assert.equal(shown.at(-1)?.requests[0].progress.reviewedAt, 'A minute ago')
      const renamed = structuredClone(aged)
      renamed.model.devices[0].name = 'Renamed computer'
      streams[0].emit('work-view-overview', renamed)
      assert.equal(shown.length, 3)
      assert.equal(shown.at(-1)?.devices[0].name, 'Renamed computer')
      // A sharing notice can change without any request changing.
      const sharing = structuredClone(renamed)
      sharing.model.sharedState = { enabled: true, pending: 2 }
      streams[0].emit('work-view-overview', sharing)
      assert.equal(shown.length, 4)
      assert.deepEqual(shown.at(-1)?.sharedState, { enabled: true, pending: 2 })
    } finally { stop() }
  })

  it('accepts omitted empty chart history without falling back and preserves recorded readings', () => {
    let gets = 0
    const { local, streams } = harness(async () => { gets++; return json(snapshot()) })
    const shown: WorkModel[] = []
    const stop = local.subscribeToLiveUpdates(model => shown.push(model), () => {})
    try {
      const compact = overview()
      compact.model.requests[0].progress = { percent: null, readings: 0, reviewedAt: 'Not reviewed yet' }
      streams[0].emit('work-view-overview', compact)
      assert.deepEqual(shown.at(-1)?.requests[0].progress.history, [])
      assert.equal(shown.at(-1)?.requests[0].detailLoaded, false)
      const withReadings = overview(SECOND)
      withReadings.model.requests[0].progress = { percent: 60, readings: 2, reviewedAt: 'Today', history: [40, 60] }
      streams[0].emit('work-view-overview', withReadings)
      assert.deepEqual(shown.at(-1)?.requests[0].progress.history, [40, 60])
      assert.equal(gets, 0)
    } finally { stop() }
  })

  it('posts the clicked review hash, preserves its receipt, and keeps old workers compatible', async () => {
    const bodies: unknown[] = []
    const { local } = harness(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return json({ ...snapshot(), save: { scope: 'shared', state: 'queued' } })
    })
    const result = await local.setRequestChecked('request-a', FIRST, true, null)
    assert.deepEqual(bodies[0], { requestId: 'request-a', expectedFingerprint: FIRST, checked: true, expectedReviewHash: null })
    assert.deepEqual(result.outcome === 'saved' && result.save, { scope: 'shared', state: 'queued' })
    await local.setRequestChecked('request-a', FIRST, false, 'review-version-read')
    assert.equal((bodies[1] as { expectedReviewHash: string }).expectedReviewHash, 'review-version-read')
    await local.setRequestChecked('request-a', FIRST, false)
    assert.equal(Object.hasOwn(bodies[2] as object, 'expectedReviewHash'), false)
    const legacy = harness(async () => json(snapshot())).local
    const oldResult = await legacy.setRequestChecked('request-a', FIRST, true)
    assert.equal(oldResult.outcome, 'saved')
    assert.equal(oldResult.outcome === 'saved' && oldResult.save, undefined)
  })

  it('keeps a shared review conflict explicit even when its evidence fingerprint did not change', async () => {
    const updated = snapshot()
    updated.humanRequests[0].review = { checked: false, checkedAtEpoch: null, available: true, mode: 'shared', hash: SECOND, conflict: true }
    const { local } = harness(async () => json({ error: 'Concurrent review decisions need a fresh choice.', snapshot: updated }, 409))
    const result = await local.setRequestChecked('request-a', FIRST, true, FIRST)
    assert.equal(result.outcome, 'refused')
    assert.equal(result.outcome === 'refused' && result.serverMessage, 'Concurrent review decisions need a fresh choice.')
    assert.equal('model' in result && result.model.requests[0].review?.hash, SECOND)
  })

  it('posts the clicked suggestion version, surfaces conflicts, and fences a late receipt behind newer events', async () => {
    const held = deferred<Response>()
    const bodies: unknown[] = []
    const { local, streams } = harness(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return held.promise })
    const stop = local.subscribeToLiveUpdates(() => {}, () => {})
    streams[0].emit('work-view-overview', overview())
    const suggestion = { conversationKey: 'conversation-a', requestId: 'group-a', requestTitle: 'A', evidence: 'Related work', expectedSuggestionHash: 'read-hash' }
    const saving = local.answerRequestSuggestion!(suggestion, 'join')
    streams[0].emit('work-view-overview', overview(THIRD))
    held.resolve(json({ ...snapshot(SECOND), save: { scope: 'shared', state: 'queued' } }))
    const result = await saving
    assert.deepEqual(bodies, [{ conversationKey: 'conversation-a', action: 'join', expectedSuggestionHash: 'read-hash' }])
    assert.equal(result.model.requests[0].contentFingerprint, THIRD)
    assert.deepEqual(result.save, { scope: 'shared', state: 'queued' })
    stop()
    const conflicting = harness(async () => json({ error: 'Suggestion has a concurrent decision.', snapshot: snapshot(SECOND) }, 409)).local
    await assert.rejects(conflicting.answerRequestSuggestion!(suggestion, 'not-this'), (error: unknown) =>
      error instanceof SaveRefusedError && /concurrent decision/.test(error.message) && error.model.requests[0].contentFingerprint === SECOND)
    const legacy = harness(async (_url, init) => {
      assert.equal(Object.hasOwn(JSON.parse(String(init?.body)), 'expectedSuggestionHash'), false)
      return json(snapshot())
    }).local
    assert.equal((await legacy.answerRequestSuggestion!({ ...suggestion, expectedSuggestionHash: undefined }, 'not-this')).save, undefined)
  })

  it('only local visible pages announce activity and stopping withdraws the lease', () => {
    class Visibility extends EventTarget { visibilityState = 'visible' }
    const activityDocument = new Visibility()
    const page = new EventTarget()
    const writes: Array<{ visible: boolean; sequence: number }> = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      writes.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: 204 })
    }
    const create = (hostname: string) => createLocalSource({ hostname, fetchImpl,
      activityOptions: { document: activityDocument, page, viewerId: 'activity-test' },
      eventSourceFactory: () => new FakeStream() as unknown as EventSource })
    const stopCloud = create('viewer.example').subscribeToLiveUpdates(() => {}, () => {})
    assert.equal(writes.length, 0)
    stopCloud()
    const stopLocal = create('localhost').subscribeToLiveUpdates(() => {}, () => {})
    assert.equal(writes[0].visible, true)
    activityDocument.visibilityState = 'hidden'
    activityDocument.dispatchEvent(new Event('visibilitychange'))
    assert.equal(writes[1].visible, false)
    stopLocal()
    assert.equal(writes.length, 2)
  })

  it('sync-only events update freshness without replacing the accepted work model', async () => {
    const { local, streams } = harness(async () => json(overview()))
    const shown: WorkModel[] = []
    const connectionStates: string[] = []
    const stop = local.subscribeToLiveUpdates(model => shown.push(model), value => connectionStates.push(value.sync?.state ?? ''))
    streams[0].emit('work-view-overview', overview())
    streams[0].emit('sync_status', { sync: { configured: true, state: 'offline', mode: 'polling', observedAt: 100_000,
      checkedAt: 99_000, message: 'Download unavailable.', download: { lastSuccessAt: 99_000 }, projection: { remaining: null },
      completeness: { pushQuarantine: 0, pullQuarantine: 0, excludedNative: 0, scope: 'eligible' } } })
    assert.equal(shown.length, 1)
    assert.equal(connectionStates.at(-1), 'offline')
    assert.equal((await local.loadWorkModel()).requests[0].contentFingerprint, FIRST)
    stop()
  })

  it('repeated cached sync evidence cannot renew freshness while events keep arriving', () => {
    const originalNow = performance.now
    let now = 0
    performance.now = () => now
    const states: string[] = []
    const { local, streams } = harness(async () => json(overview()))
    const stop = local.subscribeToLiveUpdates(() => {}, value => states.push(value.sync?.state ?? ''))
    try {
      const sync = { configured: true, state: 'current', mode: 'polling', observedAt: 100_000, checkedAt: 99_000,
        message: 'Shared records current.', download: { lastSuccessAt: 99_000 }, projection: { remaining: '0' },
        completeness: { pushQuarantine: 0, pullQuarantine: 0, excludedNative: 0, scope: 'eligible' } }
      streams[0].emit('sync_status', { sync })
      assert.equal(states.at(-1), 'current')
      now = 59_001
      streams[0].emit('sync_status', { sync })
      assert.equal(states.at(-1), 'stale')
    } finally { stop(); performance.now = originalNow }
  })

  it('accepts newer stream status after a server clock rollback', () => {
    const { local, streams } = harness(async () => json(overview()))
    const states: string[] = []
    const stop = local.subscribeToLiveUpdates(() => {}, value => states.push(value.sync?.state ?? ''))
    const sync = { configured: true, state: 'offline', mode: 'polling', observedAt: 100_000, checkedAt: 99_000,
      message: 'Download failed.', download: { lastSuccessAt: 99_000 }, projection: { remaining: '0' },
      completeness: { pushQuarantine: 0, pullQuarantine: 0, excludedNative: 0, scope: 'eligible' } }
    try {
      streams[0].emit('sync_status', { sync })
      assert.equal(states.at(-1), 'offline')
      streams[0].emit('sync_status', { sync: { ...sync, state: 'current', observedAt: 50_000, checkedAt: 49_000,
        download: { lastSuccessAt: 49_000 }, message: 'Current.' } })
      assert.equal(states.at(-1), 'current')
    } finally { stop() }
  })

  it('late HTTP status metadata cannot overwrite a newer sync-only event', async () => {
    const held = deferred<Response>()
    const { local, streams } = harness(async () => held.promise)
    const reading = local.loadWorkModel()
    const stop = local.subscribeToLiveUpdates(() => {}, () => {})
    const sync = { configured: true, state: 'offline', mode: 'polling', observedAt: 100_000, checkedAt: 99_000,
      message: 'Download failed.', download: { lastSuccessAt: 99_000 }, projection: { remaining: '0' },
      completeness: { pushQuarantine: 0, pullQuarantine: 0, excludedNative: 0, scope: 'eligible' } }
    streams[0].emit('sync_status', { sync })
    const older = overview()
    older.sync = { ...sync, state: 'current', message: 'Old successful check.' } as NonNullable<WorkViewOverview['sync']>
    held.resolve(json(older))
    assert.equal((await reading).connection.sync?.state, 'offline')
    stop()
  })
  it('joins the first overview event instead of duplicating its initial GET', async () => {
    let fetches = 0
    const { local, streams, urls } = harness(async () => { fetches++; return json(overview()) })
    const shown: WorkModel[] = []
    const stop = local.subscribeToLiveUpdates((model) => shown.push(model), () => {})
    const first = local.loadWorkModel()
    const second = local.loadWorkModel()
    assert.equal(fetches, 0)
    streams[0].emit('work-view-overview', overview())
    assert.equal((await first).requests[0].contentFingerprint, FIRST)
    assert.equal((await second).requests[0].detailLoaded, false)
    assert.equal(fetches, 0)
    assert.equal(shown.length, 1)
    assert.deepEqual(urls, ['/api/work-view/events?view=overview'])
    stop()
  })

  it('falls back once to the overview endpoint when the initial stream fails', async () => {
    const urls: string[] = []
    const { local, streams } = harness(async (url) => { urls.push(String(url)); return json(overview()) })
    const stop = local.subscribeToLiveUpdates(() => {}, () => {})
    const first = local.loadWorkModel()
    streams[0].onerror?.()
    assert.equal((await first).requests.length, 1)
    assert.deepEqual(urls, ['/api/work-view/overview'])
    stop()
  })

  it('uses a bounded HTTP fallback when an open stream never sends a first snapshot', async () => {
    let fetches = 0
    const { local } = harness(async () => { fetches++; return json(overview()) }, 5)
    const stop = local.subscribeToLiveUpdates(() => {}, () => {})
    await local.loadWorkModel()
    assert.equal(fetches, 1)
    stop()
  })

  it('accepts an old worker full snapshot and falls back from an unknown overview route', async () => {
    const snapshot = JSON.parse(readFileSync(new URL('../../test-fixtures/work-view-snapshot.trimmed.json', import.meta.url), 'utf8'))
    const calls: string[] = []
    const { local } = harness(async (url) => { calls.push(String(url)); return String(url).endsWith('/overview') ? json({}, 404) : json(snapshot) })
    const result = await local.loadWorkModel()
    assert.ok(result.requests.length > 0)
    assert.deepEqual(calls, ['/api/work-view/overview', '/api/work-view'])
  })

  it('expands omitted wire-only detail arrays without inventing loaded evidence', async () => {
    const compact = overview()
    for (const key of ['workstreams', 'granular', 'conversations', 'prompts', 'story', 'evidence', 'terminal', 'followUps'] as const) delete compact.model.requests[0][key]
    compact.model.requests[0].review = { mode: 'shared', hash: null, available: false }
    const { local } = harness(async () => json(compact))
    const request = (await local.loadWorkModel()).requests[0]
    assert.equal(request.detailLoaded, false)
    assert.deepEqual(request.granular, [])
    assert.deepEqual(request.workstreams, [])
    assert.deepEqual(request.terminal, [])
    assert.deepEqual(request.followUps, [])
    assert.deepEqual(request.review, { mode: 'shared', hash: null, available: false, conflict: false, pending: false, legacy: false })
    assert.equal(request.contentFingerprint, FIRST)
  })

  it('rejects stopped bootstrap reads and ignores late events from the old stream', async () => {
    const { local, streams } = harness(async () => json(overview()))
    const shown: WorkModel[] = []
    const stop = local.subscribeToLiveUpdates((model) => shown.push(model), () => {})
    const first = local.loadWorkModel()
    stop()
    await assert.rejects(first, { name: 'AbortError' })
    streams[0].emit('work-view-overview', overview())
    assert.equal(shown.length, 0)
    const nextStop = local.subscribeToLiveUpdates((model) => shown.push(model), () => {})
    const next = local.loadWorkModel()
    streams[1].emit('work-view-overview', overview(SECOND))
    assert.equal((await next).requests[0].contentFingerprint, SECOND)
    nextStop()
  })

  it('a new event wins over an older overview response still in flight', async () => {
    const held = deferred<Response>()
    const { local, streams } = harness(async () => held.promise)
    const reading = local.loadWorkModel()
    const stop = local.subscribeToLiveUpdates(() => {}, () => {})
    streams[0].emit('work-view-overview', overview(SECOND))
    held.resolve(json(overview(FIRST)))
    assert.equal((await reading).requests[0].contentFingerprint, SECOND)
    stop()
  })

  it('fetches complete detail once per content version and preserves current summary fields', async () => {
    const calls: string[] = []
    const full = { ...SAMPLE.requests[0], id: 'request-a', contentFingerprint: FIRST, detailRevision: FIRST, detailLoaded: true }
    const { local } = harness(async (url) => {
      calls.push(String(url))
      return String(url).includes('/requests/') ? json({ version: 1, revision: FIRST, request: full }) : json(overview())
    })
    await local.loadWorkModel()
    const first = await local.loadRequestDetail!('request-a', FIRST)
    const second = await local.loadRequestDetail!('request-a', FIRST)
    assert.deepEqual(first.granular, full.granular)
    assert.equal(first.detailLoaded, true)
    assert.equal(second.contentFingerprint, FIRST)
    assert.equal(calls.filter((url) => url.includes('/requests/')).length, 1)
    assert.match(calls[1], /fingerprint=aaaaaaaa/)
  })

  it('accepts a changed overview from a detail conflict and retries only its current fingerprint', async () => {
    let details = 0
    const shown: MappedWorkModel[] = []
    const full = { ...SAMPLE.requests[0], id: 'request-a', contentFingerprint: SECOND, detailRevision: SECOND, detailLoaded: true }
    const { local, streams } = harness(async (url) => {
      if (String(url).includes('/requests/')) {
        details++
        if (details === 1) return json({ error: 'changed', overview: overview(SECOND) }, 409)
        assert.match(String(url), /fingerprint=bbbbbbbb/)
        return json({ version: 1, revision: SECOND, request: full })
      }
      return json(overview())
    })
    const stop = local.subscribeToLiveUpdates((model) => shown.push(model), () => {})
    streams[0].emit('work-view-overview', overview())
    const result = await local.loadRequestDetail!('request-a', FIRST)
    assert.equal(result.contentFingerprint, SECOND)
    assert.equal(shown.at(-1)?.requests[0].contentFingerprint, SECOND)
    assert.equal(details, 2)
    stop()
  })

  it('a late detail conflict cannot replace a newer event and retries the current fingerprint', async () => {
    const held = deferred<Response>()
    const calls: string[] = []
    const shown: string[] = []
    const { local, streams } = harness(async (url) => {
      calls.push(String(url))
      return calls.length === 1 ? held.promise : json({ version: 1, revision: THIRD, request: fullRequest(THIRD) })
    })
    const stop = local.subscribeToLiveUpdates((model) => shown.push(model.requests[0].contentFingerprint!), () => {})
    streams[0].emit('work-view-overview', overview())
    const reading = local.loadRequestDetail!('request-a', FIRST)
    streams[0].emit('work-view-overview', overview(THIRD))
    held.resolve(json({ error: 'changed', overview: overview(SECOND) }, 409))
    assert.equal((await reading).contentFingerprint, THIRD)
    assert.deepEqual(shown, [FIRST, THIRD])
    assert.match(calls[1], /fingerprint=cccccccc/)
    stop()
  })

  it('a late detail conflict cannot replace a newer HTTP model', async () => {
    const held = deferred<Response>()
    let details = 0
    const shown: string[] = []
    const { local, streams } = harness(async (url) => {
      if (!String(url).includes('/requests/')) return json(overview(THIRD))
      return ++details === 1 ? held.promise : json({ version: 1, revision: THIRD, request: fullRequest(THIRD) })
    })
    const stop = local.subscribeToLiveUpdates((model) => shown.push(model.requests[0].contentFingerprint!), () => {})
    streams[0].emit('work-view-overview', overview())
    await local.loadWorkModel()
    const reading = local.loadRequestDetail!('request-a', FIRST)
    assert.equal((await local.loadWorkModel()).requests[0].contentFingerprint, THIRD)
    held.resolve(json({ error: 'changed', overview: overview(SECOND) }, 409))
    assert.equal((await reading).contentFingerprint, THIRD)
    assert.deepEqual(shown, [FIRST])
    stop()
  })

  it('a late detail conflict cannot replace a newly accepted save model', async () => {
    const held = deferred<Response>()
    let details = 0
    const { local, streams } = harness(async (_url, init) => {
      if (init?.method === 'POST') return json(snapshot(THIRD))
      return ++details === 1 ? held.promise : json({ version: 1, revision: THIRD, request: fullRequest(THIRD) })
    })
    const stop = local.subscribeToLiveUpdates(() => {}, () => {})
    streams[0].emit('work-view-overview', overview())
    const reading = local.loadRequestDetail!('request-a', FIRST)
    await local.saveRuleChange({ action: 'turn-off', ruleId: 'rule-a' })
    held.resolve(json({ error: 'changed', overview: overview(SECOND) }, 409))
    assert.equal((await reading).contentFingerprint, THIRD)
    stop()
  })

  it('a cancelled detail conflict cannot publish even when fetch ignores cancellation', async () => {
    const held = deferred<Response>()
    let calls = 0
    const shown: string[] = []
    const { local, streams } = harness(async () => { calls++; return held.promise })
    const stop = local.subscribeToLiveUpdates((model) => shown.push(model.requests[0].contentFingerprint!), () => {})
    streams[0].emit('work-view-overview', overview())
    const controller = new AbortController()
    const reading = local.loadRequestDetail!('request-a', FIRST, { signal: controller.signal })
    controller.abort()
    held.resolve(json({ error: 'changed', overview: overview(SECOND) }, 409))
    await assert.rejects(reading, { name: 'AbortError' })
    assert.deepEqual(shown, [FIRST])
    assert.equal(calls, 1)
    stop()
  })

  it('a superseded selection cannot publish a late conflict even without cancellation', async () => {
    const held = deferred<Response>()
    const shown: string[] = []
    const initial = overview()
    initial.model.requests.push({ ...initial.model.requests[0], id: 'request-b' })
    const { local, streams } = harness(async (url) => String(url).includes('request-a')
      ? held.promise : json({ version: 1, revision: FIRST, request: fullRequest(FIRST, 'request-b') }))
    const stop = local.subscribeToLiveUpdates((model) => shown.push(model.requests[0].contentFingerprint!), () => {})
    streams[0].emit('work-view-overview', initial)
    const previous = local.loadRequestDetail!('request-a', FIRST)
    assert.equal((await local.loadRequestDetail!('request-b', FIRST)).id, 'request-b')
    held.resolve(json({ error: 'changed', overview: overview(SECOND) }, 409))
    await assert.rejects(previous, { name: 'AbortError' })
    assert.deepEqual(shown, [FIRST])
    stop()
  })

  it('a superseded deletion refresh cannot mutate the accepted model', async () => {
    const held = deferred<Response>()
    const shown: string[] = []
    const initial = overview()
    initial.model.requests.push({ ...initial.model.requests[0], id: 'request-b' })
    const { local, streams } = harness(async (url) => {
      if (String(url).includes('request-a')) return json({}, 404)
      if (String(url).includes('request-b')) return json({ version: 1, revision: FIRST, request: fullRequest(FIRST, 'request-b') })
      return held.promise
    })
    const stop = local.subscribeToLiveUpdates((model) => shown.push(model.requests[0].contentFingerprint!), () => {})
    streams[0].emit('work-view-overview', initial)
    const previous = local.loadRequestDetail!('request-a', FIRST)
    await settle()
    await local.loadRequestDetail!('request-b', FIRST)
    held.resolve(json(overview(SECOND)))
    await assert.rejects(previous, { name: 'AbortError' })
    assert.deepEqual(shown, [FIRST])
    stop()
  })

  for (const status of [200, 409]) {
    it(`a late ${status} save response cannot replace a newer model used by detail reads`, async () => {
      const held = deferred<Response>()
      const { local, streams } = harness(async (_url, init) => init?.method === 'POST'
        ? held.promise : json({ version: 1, revision: THIRD, request: fullRequest(THIRD) }))
      const stop = local.subscribeToLiveUpdates(() => {}, () => {})
      streams[0].emit('work-view-overview', overview())
      const saving = local.saveRuleChange({ action: 'turn-off', ruleId: 'rule-a' })
      streams[0].emit('work-view-overview', overview(THIRD))
      held.resolve(status === 200 ? json(snapshot(SECOND)) : json({ error: 'changed', snapshot: snapshot(SECOND) }, status))
      if (status === 200) assert.equal((await saving).model.requests[0].contentFingerprint, THIRD)
      else await assert.rejects(saving, (error: unknown) => error instanceof SaveRefusedError && error.model.requests[0].contentFingerprint === THIRD)
      assert.equal((await local.loadRequestDetail!('request-a', THIRD)).contentFingerprint, THIRD)
      stop()
    })
  }

  it('a focus save keeps its own receipt when a newer live model arrives', async () => {
    const held = deferred<Response>()
    const saved = snapshot(SECOND)
    saved.focusAreas = [{ focusAreaId: 'area-a', name: 'Saved area', goal: null, status: 'suggested',
      priorityRank: 1, ownerRank: null, source: 'seed', mergedInto: null, evidence: null, decidedBy: 'owner-restore', savedAt: null }]
    const newer = structuredClone(saved)
    newer.focusAreas = saved.focusAreas.map(area => ({ ...area, status: 'done' as const }))
    const { local, streams } = harness(async (_url, init) => init?.method === 'POST' ? held.promise : json(newer))
    const shown: WorkModel[] = []
    const stop = local.subscribeToLiveUpdates(model => shown.push(model), () => {})
    try {
      streams[0].emit('work-view', saved)
      const saving = local.saveFocusChange({ action: 'restore-suggestion', focusAreaId: 'area-a' })
      streams[0].emit('work-view', newer)
      held.resolve(json(saved))
      const receipt = await saving
      assert.equal(receipt.focusAreas[0].status, 'suggested', 'Undo must use the state its own write saved')
      assert.equal(shown.at(-1)?.focusAreas[0].status, 'done', 'the newer live decision remains on screen')
    } finally { stop() }
  })

  it('a late review response cannot replace a newer model used by detail reads', async () => {
    const held = deferred<Response>()
    const { local, streams } = harness(async (_url, init) => init?.method === 'POST'
      ? held.promise : json({ version: 1, revision: THIRD, request: fullRequest(THIRD) }))
    const stop = local.subscribeToLiveUpdates(() => {}, () => {})
    streams[0].emit('work-view-overview', overview())
    const saving = local.setRequestChecked('request-a', FIRST, true)
    streams[0].emit('work-view-overview', overview(THIRD))
    held.resolve(json(snapshot(SECOND)))
    const result = await saving
    assert.equal('model' in result && result.model.requests[0].contentFingerprint, THIRD)
    assert.equal((await local.loadRequestDetail!('request-a', THIRD)).contentFingerprint, THIRD)
    stop()
  })

  it('a newer save model wins over an older overview response', async () => {
    const held = deferred<Response>()
    const { local } = harness(async (_url, init) => init?.method === 'POST' ? json(snapshot(THIRD)) : held.promise)
    const reading = local.loadWorkModel()
    assert.equal((await local.saveRuleChange({ action: 'turn-off', ruleId: 'rule-a' })).model.requests[0].contentFingerprint, THIRD)
    held.resolve(json(overview(SECOND)))
    assert.equal((await reading).requests[0].contentFingerprint, THIRD)
  })

  it('does not display a detail response superseded by a newer event', async () => {
    const held = deferred<Response>()
    const { local, streams } = harness(async () => held.promise)
    const stop = local.subscribeToLiveUpdates(() => {}, () => {})
    streams[0].emit('work-view-overview', overview())
    const reading = local.loadRequestDetail!('request-a', FIRST)
    streams[0].emit('work-view-overview', overview(SECOND))
    held.resolve(json({ version: 1, revision: FIRST, request: { ...SAMPLE.requests[0], id: 'request-a', contentFingerprint: FIRST, detailLoaded: true } }))
    await assert.rejects(reading, /changed while its detail was loading/)
    stop()
  })

  it('does not display a successful detail response after its request was deleted', async () => {
    const held = deferred<Response>()
    const { local, streams } = harness(async () => held.promise)
    const stop = local.subscribeToLiveUpdates(() => {}, () => {})
    streams[0].emit('work-view-overview', overview())
    const reading = local.loadRequestDetail!('request-a', FIRST)
    const empty = overview()
    empty.model.requests = []
    streams[0].emit('work-view-overview', empty)
    held.resolve(json({ version: 1, revision: FIRST, request: fullRequest() }))
    await assert.rejects(reading, /no longer in your work/)
    stop()
  })

  it('cancels detail fetching when its drawer closes', async () => {
    const { local } = harness(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const controller = new AbortController()
    const reading = local.loadRequestDetail!('request-a', FIRST, { signal: controller.signal })
    controller.abort()
    await assert.rejects(reading, { name: 'AbortError' })
  })

  it('refreshes the compact model when a selected request was deleted', async () => {
    const empty = overview()
    empty.model = { ...empty.model, requests: [] }
    const shown: WorkModel[] = []
    const { local } = harness(async (url) => String(url).includes('/requests/') ? json({}, 404) : json(empty))
    const stop = local.subscribeToLiveUpdates((model) => shown.push(model), () => {})
    await assert.rejects(local.loadRequestDetail!('request-a', FIRST), /no longer available/)
    assert.equal(shown.at(-1)?.requests.length, 0)
    stop()
  })

  it('uses server aging events without a redundant healthy-stream GET', async () => {
    const original = globalThis.setInterval
    let age: (() => void) | undefined
    globalThis.setInterval = ((callback: () => void, milliseconds: number) => {
      if (milliseconds === 60_000) age = callback
      return original(() => {}, 1_000_000)
    }) as typeof setInterval
    const next = overview()
    next.model.requests[0].runningFor = '2 hours'
    let gets = 0
    const { local, streams } = harness(async () => { gets++; return json(next) })
    const shown: WorkModel[] = []
    let stop: (() => void) | undefined
    try {
      stop = local.subscribeToLiveUpdates((model) => shown.push(model), () => {})
    } finally { globalThis.setInterval = original }
    try {
      streams[0].emit('work-view-overview', overview())
      age?.()
      await settle()
      assert.equal(gets, 0)
      streams[0].emit('work-view-overview', next)
      assert.equal(shown.at(-1)?.requests[0].runningFor, '2 hours')
    } finally { stop?.() }
  })

  it('retains a bounded HTTP fallback while the compact stream is unhealthy', async () => {
    const original = globalThis.setInterval
    const originalNow = performance.now
    let now = 0
    performance.now = () => now
    let age: (() => void) | undefined
    globalThis.setInterval = ((callback: () => void, milliseconds: number) => {
      if (milliseconds === 60_000) age = callback
      return original(() => {}, 1_000_000)
    }) as typeof setInterval
    let gets = 0
    const { local, streams } = harness(async () => { gets++; return json(overview(SECOND)) })
    const shown: WorkModel[] = []
    let stop: (() => void) | undefined
    try { stop = local.subscribeToLiveUpdates((model) => shown.push(model), () => {}) }
    finally { globalThis.setInterval = original }
    try {
      streams[0].emit('work-view-overview', overview())
      streams[0].onerror?.()
      age?.()
      await settle()
      assert.equal(gets, 1)
      assert.equal(shown.at(-1)?.requests[0].contentFingerprint, SECOND)
      assert.equal(shown.at(-1)?.connection.isLive, false)
      now += 60_000
      age?.()
      await settle()
      assert.equal(gets, 1)
      now += 60_000
      age?.()
      await settle()
      assert.equal(gets, 2)
    } finally { stop?.(); performance.now = originalNow }
  })
})

describe('a hidden cloud tab', () => {
  class FakePage extends EventTarget {
    visibilityState = 'visible'
    listeners = 0
    override addEventListener(...args: Parameters<EventTarget['addEventListener']>) { this.listeners++; super.addEventListener(...args) }
    override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) { this.listeners--; super.removeEventListener(...args) }
    show(state: 'visible' | 'hidden') { this.visibilityState = state; this.dispatchEvent(new Event('visibilitychange')) }
  }
  /** Simulated time: every timer the source starts, and performance.now(), follow `tick`. */
  function simulatedClock(t: TestContext) {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() })
    const originalNow = performance.now
    performance.now = () => Date.now()
    return {
      async minutes(count: number) { for (let minute = 0; minute < count; minute++) { t.mock.timers.tick(60_000); await settle() } },
      tick: (ms: number) => t.mock.timers.tick(ms),
      restore: () => { performance.now = originalNow },
    }
  }

  it('closes its stream, makes no request for 10 minutes, and reconnects when shown', async (t) => {
    const clock = simulatedClock(t)
    const page = new FakePage()
    const fetched: string[] = []
    const { local, streams, urls } = harness(async (url) => { fetched.push(String(url)); return json(overview(SECOND)) }, 100, { hostname: 'work.cmem.ai', visibility: page })
    const shown: WorkModel[] = []
    const stop = local.subscribeToLiveUpdates((model) => shown.push(model), () => {})
    try {
      streams[0].emit('work-view-overview', overview())
      page.show('hidden')
      assert.equal(streams[0].closed, true)
      // Unhealthy without its stream, the page would otherwise fall back to an HTTP read every two minutes.
      await clock.minutes(10)
      assert.deepEqual(fetched, [])
      assert.equal(streams.length, 1)
      page.show('visible')
      assert.equal(streams.length, 2)
      assert.equal(streams[1].closed, false)
      assert.equal(urls[1], '/api/work-view/events?view=overview')
      // The worker sends the current overview as every new stream's first event, so showing reads nothing over HTTP.
      await settle()
      assert.deepEqual(fetched, [])
      streams[1].emit('work-view-overview', overview(SECOND))
      assert.equal(shown.at(-1)?.requests[0].contentFingerprint, SECOND)
      // A second "shown" while the stream is open opens nothing more.
      page.show('visible')
      assert.equal(streams.length, 2)
    } finally { stop(); clock.restore() }
    assert.equal(page.listeners, 0)
  })

  it('does not reopen a stream that dropped just before the tab was hidden', async (t) => {
    const clock = simulatedClock(t)
    const page = new FakePage()
    const { local, streams } = harness(async () => json(overview()), 100, { hostname: 'work.cmem.ai', visibility: page })
    const stop = local.subscribeToLiveUpdates(() => {}, () => {})
    try {
      streams[0].readyState = 2
      streams[0].onerror?.()
      page.show('hidden')
      await clock.minutes(10)
      assert.equal(streams.length, 1)
    } finally { stop(); clock.restore() }
  })

  it('opens no stream while it starts hidden, and connects when first shown', async (t) => {
    const clock = simulatedClock(t)
    const page = new FakePage()
    page.visibilityState = 'hidden'
    const { local, streams } = harness(async () => json(overview()), 100, { hostname: 'work.cmem.ai', visibility: page })
    const stop = local.subscribeToLiveUpdates(() => {}, () => {})
    try {
      await clock.minutes(10)
      assert.equal(streams.length, 0)
      page.show('visible')
      assert.equal(streams.length, 1)
    } finally { stop(); clock.restore() }
  })

  it('recovers from the gate 503 while a woken machine boots, without a reload', async (t) => {
    const clock = simulatedClock(t)
    const page = new FakePage()
    const fetched: string[] = []
    const { local, streams } = harness(async (url) => { fetched.push(String(url)); return json({ error: 'Your viewer is starting' }, 503) }, 100, { hostname: 'work.cmem.ai', visibility: page })
    const shown: WorkModel[] = []
    const connections: boolean[] = []
    const stop = local.subscribeToLiveUpdates((model) => shown.push(model), (connection) => connections.push(connection.isLive))
    try {
      streams[0].emit('work-view-overview', overview())
      page.show('hidden')
      await clock.minutes(10)
      page.show('visible')
      await settle()
      // The gate answers the stream with an HTTP error, which ends an EventSource for good.
      streams[1].readyState = 2
      streams[1].onerror?.()
      assert.equal(shown.at(-1)?.requests[0].contentFingerprint, FIRST)
      clock.tick(1000)
      assert.equal(streams.length, 3)
      streams[2].emit('work-view-overview', overview(SECOND))
      assert.equal(shown.at(-1)?.requests[0].contentFingerprint, SECOND)
      assert.equal(connections.at(-1), true)
      assert.deepEqual(fetched, [])
    } finally { stop(); clock.restore() }
  })

  it('changes nothing on this computer: the stream stays open and the fallback read still runs', async (t) => {
    const clock = simulatedClock(t)
    const page = new FakePage()
    const fetched: string[] = []
    const { local, streams } = harness(async (url) => { fetched.push(String(url)); return json(overview(SECOND)) }, 100, { hostname: 'localhost', visibility: page })
    const stop = local.subscribeToLiveUpdates(() => {}, () => {})
    try {
      streams[0].emit('work-view-overview', overview())
      streams[0].onerror?.()
      page.show('hidden')
      assert.equal(page.listeners, 0)
      assert.equal(streams[0].closed, false)
      await clock.minutes(10)
      assert.equal(streams.length, 1)
      assert.equal(streams[0].closed, false)
      assert.equal(fetched.length, 5)
    } finally { stop(); clock.restore() }
  })
})

describe('continuing a conversation from this computer', () => {
  const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
  const CONTINUATION_MEMBERS = ['loadConversationContinuation', 'continueConversation', 'stopConversationContinuation', 'subscribeToConversationContinuations', 'openConversationInApp'] as const
  const target = { canContinue: true, recordedFolder: '/work/example/worktree', runsInFolder: '/work/example', recordedFolderIsGone: true, opensInAppNamed: 'Claude' }
  // Text that would read as a flag or a shell command if it were ever an argument. It travels in the JSON body, as typed.
  const ownerMessage = '--resume other "; rm -rf ~'
  const running = { exchangeId: 7, platform: 'claude', conversationSessionId: SESSION, state: 'running', ownerMessage, startedAtEpochMs: 1_000, ranInFolder: '/work/example' }
  const notice = { exchangeId: 7, platform: 'claude', conversationSessionId: SESSION, state: 'replied' }
  async function rejectionMessage(call: Promise<unknown>): Promise<string> {
    try { await call } catch (error) { return error instanceof Error ? error.message : String(error) }
    throw new Error('The call resolved; a rejection was expected.')
  }

  it('reads, sends and stops through the three conversation routes', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const { local } = harness(async (url, init) => {
      calls.push({ url: String(url), init })
      if (init?.method !== 'POST') return json({ target, exchanges: [running] })
      return json({ exchange: running }, String(url).endsWith('/continue') ? 202 : 200)
    })
    assert.deepEqual(await local.loadConversationContinuation!('claude', SESSION), { target, exchanges: [running] })
    assert.deepEqual(await local.continueConversation!('claude', SESSION, ownerMessage), running)
    assert.deepEqual(await local.stopConversationContinuation!('claude', SESSION), running)
    assert.deepEqual(calls.map(({ url, init }) => ({ url, method: init?.method ?? 'GET', headers: init?.headers, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })), [
      { url: `/api/work-view/conversations/continuation?platform=claude&conversationSessionId=${SESSION}`, method: 'GET', headers: undefined, body: undefined },
      { url: '/api/work-view/conversations/continue', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { platform: 'claude', conversationSessionId: SESSION, ownerMessage } },
      { url: '/api/work-view/conversations/stop', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { platform: 'claude', conversationSessionId: SESSION } },
    ])
    assert.equal(calls[0].init?.cache, 'no-store')
  })

  it('opens a conversation in its app through the open-in-app route, and resolves with what the CLI printed as it opened it', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const printedText = `Opening session ${SESSION} in Claude Desktop`
    const answers = [json({ printedText }), json({ printedText: null })]
    const { local } = harness(async (url, init) => { calls.push({ url: String(url), init }); return answers.shift()! })
    assert.deepEqual(await local.openConversationInApp!('claude', SESSION), { printedText })
    assert.deepEqual(await local.openConversationInApp!('claude', SESSION), { printedText: null })
    const openCall = { url: '/api/work-view/conversations/open-in-app', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { platform: 'claude', conversationSessionId: SESSION } }
    assert.deepEqual(calls.map(({ url, init }) => ({ url, method: init?.method, headers: init?.headers, body: JSON.parse(String(init?.body)) })), [openCall, openCall])
  })

  it('asks the worker to stop the open when the page is unloaded while the open still runs, and not before or after', async () => {
    const pageUnload = fakePageUnload()
    const opening = deferred<Response>()
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const { local } = harness(async (url, init) => {
      calls.push({ url: String(url), init })
      return String(url).endsWith('/open-in-app') ? opening.promise : json({})
    }, 100, { pageUnload })
    pageUnload.hide()
    assert.equal(calls.length, 0, 'nothing to stop before an open')

    const opened = local.openConversationInApp!('claude', SESSION)
    // A reload or a closed tab while the worker's command still runs: the worker cannot see this request go away.
    pageUnload.hide()
    const body = { platform: 'claude', conversationSessionId: SESSION }
    assert.deepEqual(calls.map(({ url, init }) => ({ url, method: init?.method, keepalive: init?.keepalive, headers: init?.headers, body: JSON.parse(String(init?.body)) })), [
      { url: '/api/work-view/conversations/open-in-app', method: 'POST', keepalive: undefined, headers: { 'Content-Type': 'application/json' }, body },
      { url: '/api/work-view/conversations/open-in-app/stop', method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body },
    ])
    const stopped = 'Claude Code could not open this conversation in the Claude app: the page that asked went away, so it was stopped.'
    opening.resolve(json({ error: stopped }, 409))
    assert.equal(await rejectionMessage(opened), stopped)
    assert.equal(pageUnload.listenerCount(), 0)
    pageUnload.hide()
    assert.equal(calls.length, 2, 'nothing to stop once the open has ended')
  })

  it('rejects an open that did not happen with the worker\'s sentence, whole, and an answer it cannot read with a plain one', async () => {
    const noDocumentedWay = 'Codex has no documented way to open a conversation in its app. Copy the resume command instead.'
    // What the worker answers when Claude Code did not open the app: a sentence, then everything the CLI printed.
    const didNotOpen = `Claude Code could not open this conversation in the Claude app. Claude Code exited with code 1.\n\n${'x'.repeat(200_000)}`
    const answers = [json({ error: noDocumentedWay }, 409), json({ error: didNotOpen }, 409), json([]), json({ error: 'Continuing a conversation is unavailable on this worker.' }, 503)]
    const { local } = harness(async () => answers.shift()!)
    assert.equal(await rejectionMessage(local.openConversationInApp!('codex', SESSION)), noDocumentedWay)
    const whole = await rejectionMessage(local.openConversationInApp!('claude', SESSION))
    assert.equal(whole.length, didNotOpen.length)
    assert.equal(whole, didNotOpen)
    assert.equal(await rejectionMessage(local.openConversationInApp!('claude', SESSION)), 'The worker answered 200, but this page cannot read its answer.')
    assert.equal(await rejectionMessage(local.openConversationInApp!('claude', SESSION)), 'Continuing a conversation is unavailable on this worker.')
  })

  it('rejects an open with a plain sentence when the worker cannot be reached', async () => {
    const { local } = harness(async () => { throw new TypeError('fetch failed') })
    assert.equal(await rejectionMessage(local.openConversationInApp!('claude', SESSION)), 'Could not open this conversation in its app: the worker could not be reached (fetch failed).')
  })

  it('rejects a refusal with the worker\'s own sentence', async () => {
    const stillRunning = 'This conversation is still answering your last message from here. Wait for its reply, or stop it, before you send another.'
    const nothingRunning = 'Nothing sent from here is running in this conversation.'
    const answers = [json({ error: stillRunning }, 409), json({ error: nothingRunning }, 409)]
    const { local } = harness(async () => answers.shift()!)
    assert.equal(await rejectionMessage(local.continueConversation!('claude', SESSION, 'And the word before that?')), stillRunning)
    assert.equal(await rejectionMessage(local.stopConversationContinuation!('claude', SESSION)), nothingRunning)
  })

  it('turns an HTML error page, a failed request check, a lost worker and an unreadable answer into plain sentences', async () => {
    const answers: Array<() => Promise<Response>> = [
      // Express's own page for a body over the worker's 5 MB JSON limit.
      async () => new Response('<!DOCTYPE html><html><body><pre>PayloadTooLargeError: request entity too large</pre></body></html>', { status: 413, headers: { 'Content-Type': 'text/html' } }),
      async () => json({ error: 'ValidationError', issues: [{ path: ['ownerMessage'], message: 'Too small: expected string to have >=1 characters', code: 'too_small' }] }, 400),
      async () => { throw new TypeError('fetch failed') },
      async () => json({ accepted: true }, 202),
      async () => new Response('<html><body>Bad gateway</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
    ]
    const { local } = harness(() => answers.shift()!())
    const sentences = [
      await rejectionMessage(local.continueConversation!('claude', SESSION, 'x'.repeat(6_000_000))),
      await rejectionMessage(local.continueConversation!('claude', SESSION, ' ')),
      await rejectionMessage(local.continueConversation!('claude', SESSION, 'Which word?')),
      await rejectionMessage(local.continueConversation!('claude', SESSION, 'Which word?')),
      await rejectionMessage(local.loadConversationContinuation!('claude', SESSION)),
    ]
    assert.deepEqual(sentences, [
      'Could not send your message: it is too large for the worker to take.',
      'Could not send your message: the worker could not read the request (ownerMessage: Too small: expected string to have >=1 characters).',
      'Could not send your message: the worker could not be reached (fetch failed).',
      'The worker answered 202, but this page cannot read its answer.',
      'Could not read this conversation: the worker answered 502.',
    ])
    for (const sentence of sentences) assert.doesNotMatch(sentence, /</, 'no HTML reaches the row')
  })

  it('tells subscribers each notice with its four fields only, and skips a frame it cannot read', () => {
    let fetches = 0
    const { local, streams } = harness(async () => { fetches++; return json(overview()) })
    const heard: ConversationContinuationEvent[] = []
    const stopLive = local.subscribeToLiveUpdates(() => {}, () => {})
    const unsubscribe = local.subscribeToConversationContinuations!((event) => { heard.push(event) })
    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (message: string) => { warnings.push(message) }
    try {
      streams[0].onopen?.()
      streams[0].emit('conversation-continuation', { ...notice, ownerMessage: 'never on the stream' })
      streams[0].emit('conversation-continuation', { ...notice, state: 'paused' })
      streams[0].handlers.get('conversation-continuation')?.({ data: '<html>secret prompt</html>' })
      assert.deepEqual(heard, [notice])
      assert.equal(warnings.length, 2, 'each skipped frame is reported')
      for (const warning of warnings) {
        assert.match(warning, /conversation-continuation/)
        assert.doesNotMatch(warning, /secret|paused/, 'a warning names the event type only')
      }
      unsubscribe()
      streams[0].emit('conversation-continuation', notice)
      assert.deepEqual(heard, [notice])
      assert.equal(fetches, 0, 'a notice asks nothing of the worker: the row it concerns reads')
    } finally { console.warn = originalWarn; stopLive() }
  })

  it('tells subscribers each time the live stream opens again, and sends or reads nothing itself', () => {
    let fetches = 0
    const { local, streams } = harness(async () => { fetches++; return json(overview()) })
    const heard: ConversationContinuationEvent[] = []
    const unsubscribe = local.subscribeToConversationContinuations!((event) => { heard.push(event) })
    let stopLive = local.subscribeToLiveUpdates(() => {}, () => {})
    try {
      streams[0].onopen?.()
      assert.deepEqual(heard, [], 'the first open has missed nothing: a row reads its conversation when it opens')
      // The worker restarted: the browser reconnects the same stream by itself.
      streams[0].onerror?.()
      streams[0].onopen?.()
      assert.deepEqual(heard, ['live-updates-reconnected'])
      // The page stopped and started its live updates: a new stream, and notices sent in between are lost.
      stopLive()
      streams[0].onopen?.()
      stopLive = local.subscribeToLiveUpdates(() => {}, () => {})
      streams[1].onopen?.()
      assert.deepEqual(heard, ['live-updates-reconnected', 'live-updates-reconnected'], 'a stopped stream tells nothing')
      // An outage cannot send a message again or start a turn: the source made no request of its own.
      assert.equal(fetches, 0)
    } finally { unsubscribe(); stopLive() }
  })

  it('tells every subscriber a notice when one before it throws, and reports the throw as that listener\'s own error', (t) => {
    const { local, streams } = harness(async () => json(overview()))
    const consoleWarn = t.mock.method(console, 'warn', () => {})
    const consoleError = t.mock.method(console, 'error', () => {})
    const listenerError = new Error('the first row could not draw its reply')
    const heardBySecondRow: ConversationContinuationEvent[] = []
    const stopLive = local.subscribeToLiveUpdates(() => {}, () => {})
    const unsubscribeFirstRow = local.subscribeToConversationContinuations!(() => { throw listenerError })
    const unsubscribeSecondRow = local.subscribeToConversationContinuations!((event) => { heardBySecondRow.push(event) })
    try {
      streams[0].emit('conversation-continuation', notice)
      // Missing this 'replied' notice would leave the second row on 'Working…' until the stream reopens.
      assert.deepEqual(heardBySecondRow, [notice], 'the row after a throwing one still hears the notice')
      assert.deepEqual(consoleWarn.mock.calls.map((call) => call.arguments), [], 'a readable frame is never reported as unreadable')
      assert.equal(consoleError.mock.callCount(), 1)
      const [message, reported] = consoleError.mock.calls[0].arguments
      assert.match(String(message), /conversation-continuation listener threw/)
      assert.equal(reported, listenerError, 'the listener\'s own error is reported, with its stack')
      // A frame that really is unreadable is still skipped with its warning, and reaches no listener.
      streams[0].handlers.get('conversation-continuation')?.({ data: '<html>secret prompt</html>' })
      assert.deepEqual(consoleWarn.mock.calls.map((call) => call.arguments), [['[work-view] Ignoring a conversation-continuation frame that is not JSON']])
      assert.deepEqual(heardBySecondRow, [notice])
      assert.equal(consoleError.mock.callCount(), 1)
    } finally { unsubscribeFirstRow(); unsubscribeSecondRow(); stopLive() }
  })

  it('tells every subscriber the stream reopened when one before it throws, and reports the throw as that listener\'s own error', (t) => {
    const { local, streams } = harness(async () => json(overview()))
    const consoleWarn = t.mock.method(console, 'warn', () => {})
    const consoleError = t.mock.method(console, 'error', () => {})
    const listenerError = new Error('the first row could not read its conversation again')
    const heardBySecondRow: ConversationContinuationEvent[] = []
    const stopLive = local.subscribeToLiveUpdates(() => {}, () => {})
    const unsubscribeFirstRow = local.subscribeToConversationContinuations!(() => { throw listenerError })
    const unsubscribeSecondRow = local.subscribeToConversationContinuations!((event) => { heardBySecondRow.push(event) })
    try {
      streams[0].onopen?.()
      streams[0].onerror?.()
      assert.doesNotThrow(() => streams[0].onopen?.(), 'a listener\'s throw does not escape the stream\'s open handler')
      // A row that misses this, while it shows 'Working…', would stay that way until the stream reopens again.
      assert.deepEqual(heardBySecondRow, ['live-updates-reconnected'], 'the row after a throwing one still hears the stream reopened')
      assert.equal(consoleWarn.mock.callCount(), 0, 'nothing is reported as an unreadable frame')
      assert.equal(consoleError.mock.callCount(), 1)
      const [message, reported] = consoleError.mock.calls[0].arguments
      assert.match(String(message), /conversation-continuation listener threw/)
      assert.equal(reported, listenerError, 'the listener\'s own error is reported, with its stack')
    } finally { unsubscribeFirstRow(); unsubscribeSecondRow(); stopLive() }
  })

  it('exists only on the page this computer\'s worker serves', () => {
    const fetcher = async () => json(overview())
    const onThisComputer = harness(fetcher).local
    const cloudServed = harness(fetcher, 100, { hostname: 'work.cmem.ai' }).local
    for (const member of CONTINUATION_MEMBERS) {
      assert.equal(typeof onThisComputer[member], 'function', member)
      assert.equal(member in cloudServed, false, `a cloud-served page has ${member}`)
      assert.equal(member in sampleSource, false, `the sample source has ${member}`)
    }
  })
})
