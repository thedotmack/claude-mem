import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Request } from '../data.ts'
import { getConnectionStatus } from '../live/connection-status.ts'
import type { WorkDataSource, WorkModel } from '../live/work-data-source.ts'
import { createWorkStore } from './work-store.ts'

const model = (title: string, fingerprint = title): WorkModel => ({
  sourceKind: 'local', requests: [{ id: 'one', title, contentFingerprint: fingerprint } as Request],
  connection: getConnectionStatus({ now: 0 }),
} as WorkModel)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function sourceHarness() {
  const loads: ReturnType<typeof deferred<WorkModel>>[] = []
  const streams: { model: (model: WorkModel) => void; closed: boolean }[] = []
  const source = {
    sourceKind: 'local' as const,
    loadWorkModel: () => { const load = deferred<WorkModel>(); loads.push(load); return load.promise },
    subscribeToLiveUpdates: (onModel: (model: WorkModel) => void) => {
      const stream = { model: onModel, closed: false }
      streams.push(stream)
      return () => { stream.closed = true }
    },
    setRequestChecked: async () => ({ outcome: 'unavailable' as const, serverMessage: 'unused' }),
    saveRuleChange: async () => ({ model: model('unused'), savedModel: model('unused'), refreshError: null }),
    loadRulesInClaudeCode: async () => ({ model: model('unused'), savedModel: model('unused'), refreshError: null }),
    markAgentFinished: async () => ({ model: model('unused'), savedModel: model('unused'), refreshError: null }),
  } satisfies WorkDataSource
  return { source, loads, streams }
}

const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const title = (store: ReturnType<typeof createWorkStore>) => {
  const load = store.getState().load
  return load.state === 'loaded' ? load.model.requests[0].title : load.state
}

describe('work model Zustand store', () => {
  it('keeps the streamed model when a slower initial read or failure arrives', async () => {
    for (const fail of [false, true]) {
      const store = createWorkStore()
      const harness = sourceHarness()
      const stop = store.getState().start(harness.source)
      harness.streams[0].model(model('new'))
      if (fail) harness.loads[0].reject(new Error('offline'))
      else harness.loads[0].resolve(model('old'))
      await flush()
      assert.equal(title(store), 'new')
      assert.equal(store.getState().refreshing, false)
      stop()
    }
  })

  it('ignores disposed streams and reads across StrictMode remounts and source changes', async () => {
    const store = createWorkStore()
    const first = sourceHarness()
    const stopFirst = store.getState().start(first.source)
    stopFirst()
    const stopSecond = store.getState().start(first.source)
    first.streams[0].model(model('zombie event'))
    first.loads[0].resolve(model('zombie read'))
    first.loads[1].resolve(model('current'))
    await flush()
    assert.equal(title(store), 'current')
    assert.equal(first.streams[0].closed, true)
    const other = sourceHarness()
    const stopOther = store.getState().start(other.source)
    assert.equal(store.getState().load.state, 'loading')
    first.streams[1].model(model('wrong source'))
    other.loads[0].resolve(model('other source'))
    await flush()
    assert.equal(title(store), 'other source')
    stopSecond() // An old cleanup cannot close the replacement.
    assert.equal(other.streams[0].closed, false)
    stopOther()
  })

  it('retries a failed load and retains shown work on later refresh errors', async () => {
    const store = createWorkStore()
    const harness = sourceHarness()
    const stop = store.getState().start(harness.source)
    harness.loads[0].reject(new Error('offline'))
    await flush()
    assert.deepEqual(store.getState().load, { state: 'failed', error: 'offline' })
    const retry = store.getState().refresh()
    assert.equal(store.getState().load.state, 'loading')
    harness.loads[1].resolve(model('back online'))
    await retry
    const refresh = store.getState().refresh()
    harness.loads[2].reject(new Error('disconnected'))
    await refresh
    assert.equal(title(store), 'back online')
    assert.equal(store.getState().refreshError, 'disconnected')
    stop()
  })

  it('isolates heartbeat notifications from the model and expires update highlights', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    context.after(() => context.mock.timers.reset())
    const store = createWorkStore()
    store.getState().receiveModel(model('first'))
    const beforeHeartbeat = store.getState().load
    store.getState().receiveConnection(getConnectionStatus({ now: 10, reconnecting: true }))
    assert.equal(store.getState().load, beforeHeartbeat)
    store.getState().receiveModel(model('changed'))
    assert.equal(store.getState().freshlyUpdatedIds.has('one'), true)
    context.mock.timers.tick(4000)
    assert.equal(store.getState().freshlyUpdatedIds.size, 0)
  })
})
