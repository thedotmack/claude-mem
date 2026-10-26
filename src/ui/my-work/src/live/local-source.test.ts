import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test, type TestContext } from 'node:test'
import { createLocalSource } from './local-source.ts'
import type { WorkModel } from './work-data-source.ts'
import type { WorkViewSnapshot } from './work-view-api-types.ts'

const fixture = JSON.parse(readFileSync(new URL('../../test-fixtures/work-view-snapshot.trimmed.json', import.meta.url), 'utf8')) as WorkViewSnapshot
const snapshot = (label = 'first'): WorkViewSnapshot => ({ ...structuredClone(fixture), story: { story: { narrative: label, writtenAt: null } } })
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const pending = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function transport(t: TestContext) {
  class FakeEventSource {
    static CLOSED = 2
    static instances: FakeEventSource[] = []
    readyState = 1
    onopen: (() => void) | null = null
    onerror: (() => void) | null = null
    listeners = new Map<string, ((event: { data: string }) => void)[]>()
    constructor(_url: string) { FakeEventSource.instances.push(this) }
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
    }
    emit(type: string, value: unknown) { this.listeners.get(type)?.forEach((listener) => listener({ data: JSON.stringify(value) })) }
    close() { this.readyState = 2 }
    fail() { this.readyState = 2; this.onerror?.() }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'EventSource')
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, writable: true, value: FakeEventSource })
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'EventSource', descriptor)
    else Reflect.deleteProperty(globalThis, 'EventSource')
  })
  const source = createLocalSource()
  const models: WorkModel[] = []
  const connections: string[] = []
  const stop = source.subscribeToLiveUpdates((model) => models.push(model), (connection) => connections.push(connection.state))
  t.after(stop)
  const stream = FakeEventSource.instances.at(-1)!
  return { source, models, connections, stream, stop, streams: FakeEventSource.instances }
}

test('story-only changes reach subscribers and unchanged snapshots do not repeat', (t) => {
  const { stream, models } = transport(t)
  stream.emit('work-view', snapshot())
  stream.emit('work-view', snapshot())
  stream.emit('work-view', snapshot('The next chapter'))
  assert.equal(models.length, 2)
  assert.equal(models[1].buildStory?.recap, 'The next chapter')
})

test('a fresh snapshot wins over an older in-flight HTTP read', async (t) => {
  const { source, stream, models } = transport(t)
  const read = pending<Response>()
  t.mock.method(globalThis, 'fetch', () => read.promise)
  const loading = source.loadWorkModel()
  stream.emit('work-view', snapshot('newer event'))
  read.resolve(response(snapshot('older read')))
  assert.equal((await loading).buildStory?.recap, 'newer event')
  assert.equal(models.at(-1)?.buildStory?.recap, 'newer event')
})

test('a heartbeat during an HTTP read does not discard that read', async (t) => {
  const { source, stream } = transport(t)
  stream.emit('work-view', snapshot('existing'))
  const read = pending<Response>()
  t.mock.method(globalThis, 'fetch', () => read.promise)
  const loading = source.loadWorkModel()
  stream.emit('heartbeat', { source: snapshot().source })
  read.resolve(response(snapshot('newer HTTP')))
  assert.equal((await loading).buildStory?.recap, 'newer HTTP')
})

test('a slow save re-reads after an intervening event instead of rolling it back', async (t) => {
  const { source, stream } = transport(t)
  const saved = pending<Response>()
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', (url: string) => {
    requests.push(url)
    return url.endsWith('/rules') ? saved.promise : Promise.resolve(response(snapshot('saved and current')))
  })
  stream.emit('work-view', snapshot())
  const saving = source.saveRuleChange({ action: 'turn-on', ruleId: 'example' })
  stream.emit('work-view', snapshot('newer event'))
  saved.resolve(response(snapshot('old save response')))
  const result = await saving
  assert.equal(result.savedModel.buildStory?.recap, 'old save response')
  assert.equal(result.model.buildStory?.recap, 'saved and current')
  assert.equal(result.refreshError, null)
  assert.deepEqual(requests, ['/api/work-view/rules', '/api/work-view'])
})

test('a slow review save also keeps the newer model', async (t) => {
  const { source, stream } = transport(t)
  const saved = pending<Response>()
  t.mock.method(globalThis, 'fetch', (url: string) => url.endsWith('/review') ? saved.promise : Promise.resolve(response(snapshot('checked and current'))))
  const saving = source.setRequestChecked('example', 'a'.repeat(64), true)
  stream.emit('work-view', snapshot('newer event'))
  saved.resolve(response(snapshot('old review response')))
  const result = await saving
  assert.equal(result.outcome, 'saved')
  assert.equal('model' in result && result.model.buildStory?.recap, 'checked and current')
  assert.equal(result.outcome === 'saved' && result.savedModel.buildStory?.recap, 'old review response')
})

test('a saved rule receipt keeps version B while the display advances to C', async (t) => {
  const { source, stream } = transport(t)
  const ruleSnapshot = (text: string): WorkViewSnapshot => ({
    ...snapshot(text),
    ruleScopes: [{ id: 'everywhere', tier: 'everywhere', name: 'Everywhere' }],
    rules: [{
      ruleId: 'example', scopeId: 'everywhere', scopeTier: 'everywhere', scopeName: 'Everywhere',
      when: '', then: text, setBy: 'owner', status: 'on', kind: 'directive', source: 'you',
      timesSeen: 1, latestAt: null, quotes: [], replacedBy: null, replacedAt: null, savedAt: null,
    }],
  })
  const saved = pending<Response>()
  t.mock.method(globalThis, 'fetch', (url: string) => url.endsWith('/rules')
    ? saved.promise : Promise.resolve(response(ruleSnapshot('C: another tab changed it'))))
  stream.emit('work-view', ruleSnapshot('A: original rule'))
  const saving = source.saveRuleChange({ action: 'edit', ruleId: 'example', rule: { scopeTier: 'everywhere', scopeName: 'Everywhere', when: '', then: 'B: my change' } })
  stream.emit('work-view', ruleSnapshot('C: another tab changed it'))
  saved.resolve(response(ruleSnapshot('B: my change')))
  const result = await saving
  assert.equal(result.savedModel.rules[0].then, 'B: my change')
  assert.equal(result.model.rules[0].then, 'C: another tab changed it')
  assert.notDeepEqual(result.savedModel.rules[0], result.model.rules[0])
})

test('a confirmed save survives failed refresh and keeps the newer cached model', async (t) => {
  const { source, stream } = transport(t)
  const saved = pending<Response>()
  const fetched: string[] = []
  t.mock.method(globalThis, 'fetch', (url: string) => {
    fetched.push(url)
    return url.endsWith('/rules') ? saved.promise : Promise.reject(new Error('refresh disconnected'))
  })
  stream.emit('work-view', snapshot('A: original'))
  const saving = source.saveRuleChange({ action: 'turn-on', ruleId: 'example' })
  stream.emit('work-view', snapshot('C: current work'))
  saved.resolve(response(snapshot('B: confirmed save')))
  const result = await saving
  assert.equal(result.savedModel.buildStory?.recap, 'B: confirmed save')
  assert.equal(result.model.buildStory?.recap, 'C: current work')
  assert.match(result.refreshError ?? '', /refresh disconnected/)
  assert.deepEqual(fetched, ['/api/work-view/rules', '/api/work-view'])
  // A later read that loses to another event must still find C in the transport cache, not B.
  const nextRead = pending<Response>()
  t.mock.method(globalThis, 'fetch', () => nextRead.promise)
  const reading = source.loadWorkModel()
  stream.emit('work-view', snapshot('C: current work'))
  nextRead.resolve(response(snapshot('old read')))
  assert.equal((await reading).buildStory?.recap, 'C: current work')
})

test('a review saved before a failed refresh still reports saved', async (t) => {
  const { source, stream } = transport(t)
  const saved = pending<Response>()
  t.mock.method(globalThis, 'fetch', (url: string) => url.endsWith('/review')
    ? saved.promise : Promise.reject(new Error('review refresh disconnected')))
  const saving = source.setRequestChecked('example', 'a'.repeat(64), true)
  stream.emit('work-view', snapshot('C: current work'))
  saved.resolve(response(snapshot('B: confirmed review')))
  const result = await saving
  assert.equal(result.outcome, 'saved')
  if (result.outcome !== 'saved') assert.fail('A successful review POST must stay successful')
  assert.equal(result.savedModel.buildStory?.recap, 'B: confirmed review')
  assert.equal(result.model.buildStory?.recap, 'C: current work')
  assert.match(result.refreshError ?? '', /review refresh disconnected/)
})

test('the own-save SSE followed by failed refresh does not make Add look failed', async (t) => {
  const { source, stream } = transport(t)
  const saved = pending<Response>()
  let posts = 0
  t.mock.method(globalThis, 'fetch', (url: string) => {
    if (url.endsWith('/rules')) { posts++; return saved.promise }
    return Promise.reject(new Error('refresh unavailable'))
  })
  stream.emit('work-view', snapshot('A: before add'))
  const saving = source.saveRuleChange({ action: 'add', rule: { scopeTier: 'everywhere', scopeName: 'Everywhere', when: '', then: 'Added once' } })
  stream.emit('work-view', snapshot('B: added once'))
  saved.resolve(response(snapshot('B: added once')))
  const result = await saving
  assert.equal(result.savedModel.buildStory?.recap, 'B: added once')
  assert.equal(result.model.buildStory?.recap, 'B: added once')
  assert.match(result.refreshError ?? '', /refresh unavailable/)
  assert.equal(posts, 1)
})

test('a rejected mutation POST still rejects without a follow-up read', async (t) => {
  const { source } = transport(t)
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', (url: string) => {
    requests.push(url)
    return Promise.resolve(response({ error: 'Local work is unavailable.' }, 503))
  })
  await assert.rejects(source.saveRuleChange({ action: 'approve', ruleId: 'example' }), /was not saved: Local work is unavailable/)
  assert.deepEqual(requests, ['/api/work-view/rules'])
})

test('a successful rule POST forwards the confirmed rule ID', async (t) => {
  const { source } = transport(t)
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(response({ ...snapshot('confirmed add'), savedRuleId: 'created-rule' })))
  const result = await source.saveRuleChange({ action: 'add', rule: { scopeTier: 'everywhere', scopeName: 'Everywhere', when: '', then: 'My rule' } })
  assert.equal(result.savedRuleId, 'created-rule')
  assert.equal(result.savedModel.buildStory?.recap, 'confirmed add')
  assert.equal(result.model.buildStory?.recap, 'confirmed add')
  assert.equal(result.refreshError, null)
})

test('cleanup blocks queued callbacks and cancels stream reopening', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { stream, streams, models, connections, stop } = transport(t)
  stream.fail()
  stream.fail()
  stop()
  const connectionCount = connections.length
  stream.emit('work-view', snapshot())
  stream.emit('heartbeat', { source: snapshot().source })
  stream.onopen?.()
  stream.fail()
  t.mock.timers.tick(60_001)
  assert.equal(streams.length, 1)
  assert.equal(models.length, 0)
  assert.equal(connections.length, connectionCount)
})

test('a permanently closed stream gets exactly one replacement and ignores old events', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { stream, streams, models } = transport(t)
  stream.fail()
  stream.fail()
  t.mock.timers.tick(1000)
  assert.equal(streams.length, 2)
  streams[1].emit('work-view', snapshot('reconnected'))
  stream.emit('work-view', snapshot('obsolete'))
  assert.equal(models.length, 1)
  assert.equal(models[0].buildStory?.recap, 'reconnected')
})

test('a resubscription delivers its first snapshot even when the prior subscription saw it', (t) => {
  const { source, stream, streams, stop } = transport(t)
  stream.emit('work-view', snapshot())
  stop()
  const received: WorkModel[] = []
  const stopAgain = source.subscribeToLiveUpdates((model) => received.push(model), () => {})
  t.after(stopAgain)
  streams.at(-1)!.emit('work-view', snapshot())
  stream.emit('work-view', snapshot('from disposed subscription'))
  assert.equal(received.length, 1)
  assert.equal(received[0].buildStory?.recap, 'first')
})

test('separate source instances do not share cached work or connection evidence', async (t) => {
  const { stream } = transport(t)
  stream.emit('work-view', snapshot('source one'))
  const second = createLocalSource()
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(response(snapshot('source two'))))
  const loaded = await second.loadWorkModel()
  assert.equal(loaded.buildStory?.recap, 'source two')
  assert.equal(loaded.connection.isLive, false)
})

test('an invalid HTTP snapshot rejects before entering the live cache', async (t) => {
  const { source } = transport(t)
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(response({ error: 'no model' })))
  await assert.rejects(source.loadWorkModel(), /not a work snapshot/)
})
