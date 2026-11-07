// The one My Work store: live reads and saves that can't overwrite newer work, the URL as the place, saved
// display preferences, and one save at a time with receipts for the version saved.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SaveRefusedError } from '../data.ts'
import type { OwnerRule } from '../data-rules.ts'
import type { ConnectionStatus } from '../live/connection-status.ts'
import { sampleSource } from '../live/sample-source.ts'
import type { UsageReport } from '../live/usage.ts'
import type { RuleSaveResult, WorkDataSource, WorkModel } from '../live/work-data-source.ts'
import { createBoundStore } from './create-store.ts'
import type { StoreEnvironment } from './store-types.ts'

const SAMPLE_MODEL = await sampleSource.loadWorkModel()
const LOCAL_MODEL: WorkModel = { ...SAMPLE_MODEL, sourceKind: 'local' }
const withRequests = (count: number): WorkModel => ({ ...LOCAL_MODEL, requests: LOCAL_MODEL.requests.slice(0, count) })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** A source whose reads and saves answer when the test says so, with its live feed in the test's hands. */
function fakeSource(overrides: Partial<WorkDataSource> = {}) {
  const feed = { onModel: (_model: WorkModel) => {}, onConnection: (_connection: ConnectionStatus) => {}, stopped: false }
  const reads: ReturnType<typeof deferred<WorkModel>>[] = []
  const source: WorkDataSource = {
    sourceKind: 'local',
    loadWorkModel: () => { const read = deferred<WorkModel>(); reads.push(read); return read.promise },
    subscribeToLiveUpdates: (onModel, onConnection) => { feed.onModel = onModel; feed.onConnection = onConnection; return () => { feed.stopped = true } },
    setRequestChecked: () => Promise.reject(new Error('not used')),
    saveRuleChange: () => Promise.reject(new Error('not used')),
    saveFocusChange: () => Promise.reject(new Error('not used')),
    markAgentFinished: () => Promise.reject(new Error('not used')),
    loadRulesInClaudeCode: () => Promise.reject(new Error('not used')),
    ...overrides,
  }
  return { source, feed, reads }
}

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) }, removeItem: (key: string) => { items.delete(key) }, items }
}

function testStore(options: { href?: string; storage?: ReturnType<typeof memoryStorage> } = {}) {
  let href = options.href ?? 'http://localhost/'
  const urls: { href: string; replace: boolean }[] = []
  const usage: UsageReport[] = []
  const environment: StoreEnvironment = {
    href: () => href,
    writeUrl: (url, replace) => { href = url.href; urls.push({ href: url.href, replace }) },
    prefersDark: false,
    storage: options.storage ?? memoryStorage(),
    reportsUsage: true,
    sendUsage: (report) => { if (report) usage.push(report) },
    scrollToTop: () => {},
  }
  const store = createBoundStore(environment)
  return { store, urls, usage, setHref: (next: string) => { href = next } }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('reading work', () => {
  it('shows the first read, and a live model that arrived during the read wins over it', async () => {
    const { store } = testStore()
    const { source, feed, reads } = fakeSource()
    store.getState().startWorkSource(source)
    assert.equal(store.getState().work.load.state, 'loading')
    feed.onModel(withRequests(2))
    reads[0].resolve(withRequests(1))
    await settle()
    const load = store.getState().work.load
    assert.equal(load.state === 'loaded' && load.model.requests.length, 2)
  })

  it('says why a first read failed, and Retry reads again', async () => {
    const { store } = testStore()
    const { source, reads } = fakeSource()
    store.getState().startWorkSource(source)
    reads[0].reject(new Error('worker down'))
    await settle()
    assert.deepEqual(store.getState().work.load, { state: 'failed', error: 'worker down' })
    const retry = store.getState().retryWorkRead()
    assert.equal(store.getState().work.load.state, 'loading')
    reads[1].resolve(withRequests(1))
    await retry
    assert.equal(store.getState().work.load.state, 'loaded')
  })

  it('a stopped source can no longer change the screen', async () => {
    const { store } = testStore()
    const { source, feed, reads } = fakeSource()
    const stop = store.getState().startWorkSource(source)
    stop()
    assert.equal(feed.stopped, true)
    feed.onModel(withRequests(1))
    reads[0].resolve(withRequests(1))
    await settle()
    assert.equal(store.getState().work.load.state, 'loading')
  })

  it('a heartbeat that changes nothing does not touch the state', async () => {
    const { store } = testStore()
    const { source, feed } = fakeSource()
    store.getState().startWorkSource(source)
    feed.onModel(LOCAL_MODEL)
    const before = store.getState()
    feed.onConnection({ ...LOCAL_MODEL.connection })
    assert.equal(store.getState(), before)
    feed.onConnection({ ...LOCAL_MODEL.connection, label: 'Reconnecting' })
    assert.equal(store.getState().work.connection?.label, 'Reconnecting')
    assert.equal(store.getState().work.load, before.work.load)
  })
})

describe('saving work', () => {
  const ruleSaveSource = (saves: ReturnType<typeof deferred<RuleSaveResult>>[]) => fakeSource({
    saveRuleChange: () => { const save = deferred<RuleSaveResult>(); saves.push(save); return save.promise },
  })

  it('shows what the save answered when nothing newer arrived meanwhile', async () => {
    const { store } = testStore()
    const saves: ReturnType<typeof deferred<RuleSaveResult>>[] = []
    const { source, feed } = ruleSaveSource(saves)
    store.getState().startWorkSource(source)
    feed.onModel(withRequests(1))
    const saving = store.getState().saveRuleChange({ action: 'turn-off', ruleId: 'x' })
    saves[0].resolve({ model: withRequests(3), savedRuleId: null })
    await saving
    const load = store.getState().work.load
    assert.equal(load.state === 'loaded' && load.model.requests.length, 3)
  })

  it('reads the current work instead when a live model arrived while the save was in flight', async () => {
    const { store } = testStore()
    const saves: ReturnType<typeof deferred<RuleSaveResult>>[] = []
    const { source, feed, reads } = ruleSaveSource(saves)
    store.getState().startWorkSource(source)
    feed.onModel(withRequests(1))
    const saving = store.getState().saveRuleChange({ action: 'turn-off', ruleId: 'x' })
    feed.onModel(withRequests(4))
    saves[0].resolve({ model: withRequests(3), savedRuleId: null })
    await settle()
    reads[1].resolve(withRequests(5))
    const result = await saving
    assert.equal(result.model.requests.length, 3, 'the caller still gets the save\'s own answer as its receipt')
    const load = store.getState().work.load
    assert.equal(load.state === 'loaded' && load.model.requests.length, 5)
  })

  it('a save that went through stays saved when reading after it fails', async () => {
    const { store } = testStore()
    const saves: ReturnType<typeof deferred<RuleSaveResult>>[] = []
    const { source, feed, reads } = ruleSaveSource(saves)
    store.getState().startWorkSource(source)
    feed.onModel(withRequests(1))
    const saving = store.getState().saveRuleChange({ action: 'turn-off', ruleId: 'x' })
    feed.onModel(withRequests(4))
    saves[0].resolve({ model: withRequests(3), savedRuleId: null })
    await settle()
    reads[1].reject(new Error('worker restarting'))
    await saving
    assert.match(store.getState().work.refreshError ?? '', /^Saved\. .*worker restarting/)
    const load = store.getState().work.load
    assert.equal(load.state === 'loaded' && load.model.requests.length, 4)
  })

  it('a refusal shows the snapshot the worker refused against, then rejects with the reason', async () => {
    const { store } = testStore()
    const { source, feed } = fakeSource({ saveFocusChange: () => Promise.reject(new SaveRefusedError('Area changed', withRequests(2))) })
    store.getState().startWorkSource(source)
    feed.onModel(withRequests(1))
    await assert.rejects(store.getState().saveFocusChange({ action: 'keep', focusAreaId: 'a' }), /Area changed/)
    const load = store.getState().work.load
    assert.equal(load.state === 'loaded' && load.model.requests.length, 2)
  })
})

describe('where the person is', () => {
  it('reads its place from the URL and writes each move to it', () => {
    const { store, urls, usage } = testStore({ href: 'http://localhost/?source=sample&view=rules' })
    assert.equal(store.getState().view.section, 'rules')
    store.getState().goToFocus('fa-sync')
    assert.deepEqual(urls.at(-1), { href: 'http://localhost/?source=sample&focus=fa-sync', replace: false })
    store.getState().goToPage('rules')
    assert.equal(urls.at(-1)?.href, 'http://localhost/?source=sample&view=rules')
    assert.deepEqual(usage, [{ event: 'switched', view: 'work', previousView: 'rules' }, { event: 'switched', view: 'rules', previousView: 'work' }])
  })

  it('Back shows what the URL now says', () => {
    const { store, setHref } = testStore()
    store.getState().goToPage('rules')
    setHref('http://localhost/?focus=fa-sync')
    store.getState().showUrl()
    assert.equal(store.getState().view.section, 'work')
    assert.equal(store.getState().view.focusChoice, 'fa-sync')
  })

  it('a drawer reopened from the URL follows the request, and closes for good when it leaves the feed', () => {
    const { store, urls } = testStore()
    const { source, feed } = fakeSource()
    const [first] = LOCAL_MODEL.requests
    store.getState().openRequestDrawer(first)
    assert.equal(urls.at(-1)?.href, `http://localhost/?request=${first.id}`)
    store.getState().startWorkSource(source)
    feed.onModel(LOCAL_MODEL)
    assert.equal(store.getState().view.openRequest?.fromLiveFeed, true)
    feed.onModel({ ...LOCAL_MODEL, requests: LOCAL_MODEL.requests.slice(1) })
    assert.equal(store.getState().view.openRequest, null)
    assert.deepEqual(urls.at(-1), { href: 'http://localhost/', replace: true })
    feed.onModel(LOCAL_MODEL)
    assert.equal(store.getState().view.openRequest, null, 'it never reopens by itself')
  })

  it('opening a focus area closes the drawer', () => {
    const { store } = testStore()
    store.getState().openRequestDrawer(LOCAL_MODEL.requests[0])
    store.getState().goToFocus('fa-sync')
    assert.equal(store.getState().view.openRequest, null)
  })
})

describe('display preferences', () => {
  it('saves only how the person likes to see My Work, and reads it back next visit', () => {
    const storage = memoryStorage()
    const first = testStore({ storage }).store
    first.getState().setListView('list')
    first.getState().setFilter('closed')
    first.getState().goToPage('rules')
    const saved = JSON.parse(storage.items.get('claude-mem:my-work:preferences')!)
    assert.deepEqual(saved.state, { listView: 'list', filter: 'closed', sort: 'attention' })
    const next = testStore({ storage }).store.getState().view
    assert.deepEqual([next.listView, next.filter, next.section], ['list', 'closed', 'work'])
  })

  it('leaves unknown saved values at their defaults, drops the team view, and starts the theme from ?theme=', () => {
    const storage = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { dark: false, listView: 'team', filter: 'mine', sort: 7 } }) })
    const view = testStore({ storage, href: 'http://localhost/?theme=dark' }).store.getState().view
    assert.deepEqual([view.dark, view.listView, view.filter, view.sort], [true, 'cards', 'all', 'attention'])
  })
})

describe('My Rules saves', () => {
  const rule: OwnerRule = {
    id: 'rule', scopeId: 'everywhere', setBy: 'learned', when: '', then: 'Use real data.', quotes: [],
    timesSeen: 2, latestAt: 'Today', latestDaysAgo: 0, source: 'request-progress', status: 'suggested', records: [],
  }
  const modelWith = (rules: OwnerRule[]): WorkModel => ({ ...LOCAL_MODEL, rules })

  it('runs one save at a time and keeps the receipt for the version saved', async () => {
    const { store } = testStore()
    const saves: ReturnType<typeof deferred<RuleSaveResult>>[] = []
    const { source, feed } = fakeSource({ saveRuleChange: () => { const save = deferred<RuleSaveResult>(); saves.push(save); return save.promise } })
    store.getState().startWorkSource(source)
    feed.onModel(modelWith([rule]))
    const describe = () => ({ decision: { ruleId: 'rule', decision: 'approved' as const }, change: { text: 'Approved', ruleId: 'rule', undo: { action: 'restore-suggestion' as const, ruleId: 'rule' } } })
    const first = store.getState().runRuleSave({ action: 'approve', ruleId: 'rule' }, describe)
    assert.equal(await store.getState().runRuleSave({ action: 'approve', ruleId: 'rule' }, describe), null)
    assert.equal(saves.length, 1)
    const approved = { ...rule, setBy: 'approved' as const, status: 'on' as const }
    saves[0].resolve({ model: modelWith([approved]), savedRuleId: 'rule' })
    await first
    const { rules } = store.getState()
    assert.equal(rules.saving, false)
    assert.equal(rules.savedDecisions.rule.decision, 'approved')
    assert.deepEqual(rules.changedIds, ['rule'])
    assert.equal(rules.history.at(-1)?.text, 'Approved')
  })

  it('refuses Undo once the rule changed since the save, and undoes it while it has not', async () => {
    const { store } = testStore()
    const approved = { ...rule, setBy: 'approved' as const, status: 'on' as const }
    const answers = [modelWith([approved]), modelWith([rule])]
    const { source, feed } = fakeSource({ saveRuleChange: async () => ({ model: answers.shift()!, savedRuleId: 'rule' }) })
    store.getState().startWorkSource(source)
    feed.onModel(modelWith([rule]))
    await store.getState().runRuleSave({ action: 'approve', ruleId: 'rule' }, () => ({ decision: { ruleId: 'rule', decision: 'approved' }, change: { text: 'Approved', ruleId: 'rule', undo: { action: 'restore-suggestion', ruleId: 'rule' } } }))
    feed.onModel(modelWith([{ ...approved, then: 'A newer edit.' }]))
    await store.getState().undoLastRuleChange()
    assert.match(store.getState().rules.saveError ?? '', /changed since your edit/)
    assert.equal(store.getState().rules.history.length, 1)
    feed.onModel(modelWith([approved]))
    await store.getState().undoLastRuleChange()
    assert.equal(store.getState().rules.history.length, 0)
    assert.equal(store.getState().rules.savedDecisions.rule, undefined)
  })
})

describe('My Focus saves', () => {
  it('runs one change at a time, keeps it for Undo, and undoes it', async () => {
    const { store } = testStore()
    const sent: string[] = []
    const gate = deferred<WorkModel>()
    const { source, feed } = fakeSource({ saveFocusChange: (change) => { sent.push(change.action); return sent.length === 1 ? gate.promise : Promise.resolve(LOCAL_MODEL) } })
    store.getState().startWorkSource(source)
    feed.onModel(LOCAL_MODEL)
    const first = store.getState().applyFocusChange({ action: 'keep', focusAreaId: 'a' }, { text: 'Kept A', undo: [{ action: 'restore-suggestion', focusAreaId: 'a' }] })
    assert.equal(await store.getState().applyFocusChange({ action: 'dismiss', focusAreaId: 'a' }, null), false)
    gate.resolve(LOCAL_MODEL)
    assert.equal(await first, true)
    assert.equal(store.getState().focus.history.at(-1)?.text, 'Kept A')
    assert.equal(await store.getState().undoLastFocusChange(), true)
    assert.deepEqual(sent, ['keep', 'restore-suggestion'])
    assert.equal(store.getState().focus.history.length, 0)
  })
})
