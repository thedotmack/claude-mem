// The one My Work store: live reads and saves that can't overwrite newer work, the URL as the place, saved
// display preferences, and one save at a time with receipts for the version saved.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SaveRefusedError, type FocusChange, type Request } from '../data.ts'
import { focusChangeVersion } from '../../../../shared/focus-change-version.ts'
import type { OwnerRule } from '../data-rules.ts'
import type { ConnectionStatus } from '../live/connection-status.ts'
import { sampleSource } from '../live/sample-source.ts'
import type { UsageReport } from '../live/usage.ts'
import type { RuleSaveResult, WorkDataSource, WorkModel } from '../live/work-data-source.ts'
import { createBoundStore } from './create-store.ts'
import { FOCUS_THREAD_VIEWS, WORK_FILTERS, WORK_LIST_VIEWS, type StoreEnvironment } from './store-types.ts'

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
    refreshWork: () => Promise.resolve({ state: 'idle' }),
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
  it('forwards clicked review and suggestion versions with their durable receipts', async () => {
    const { store } = testStore()
    const calls: unknown[][] = []
    const receipt = { scope: 'shared' as const, state: 'queued' as const }
    const { source } = fakeSource({
      setRequestChecked: async (...args) => { calls.push(args); return { outcome: 'saved', model: LOCAL_MODEL, save: receipt } },
      answerRequestSuggestion: async (...args) => { calls.push(args); return { model: LOCAL_MODEL, save: receipt } },
    })
    const stop = store.getState().startWorkSource(source)
    const result = await store.getState().setRequestChecked('request-a', true, 'evidence', null)
    assert.deepEqual(calls[0], ['request-a', 'evidence', true, null])
    assert.deepEqual(result.outcome === 'saved' && result.save, receipt)
    const suggestion = { conversationKey: 'c', requestId: 'r', requestTitle: 'Related', evidence: 'Same work', expectedSuggestionHash: 'read-hash' }
    assert.deepEqual((await store.getState().answerRequestSuggestion(suggestion, 'not-this')).save, receipt)
    assert.deepEqual(calls[1], [suggestion, 'not-this'])
    stop()
  })

  it('loads only compact request detail and keeps the full-source compatibility path', async () => {
    const { store } = testStore()
    const full = LOCAL_MODEL.requests[0]
    const compact = { ...full, detailLoaded: false, detailRevision: 'recorded-version' }
    const controller = new AbortController()
    const calls: unknown[][] = []
    const { source } = fakeSource({ loadRequestDetail: async (...args) => { calls.push(args); return full } })
    const stop = store.getState().startWorkSource(source)
    assert.equal(await store.getState().loadRequestDetail(full), full)
    assert.equal(calls.length, 0)
    assert.equal(await store.getState().loadRequestDetail(compact, { signal: controller.signal }), full)
    assert.deepEqual(calls, [[full.id, 'recorded-version', { signal: controller.signal }]])
    stop()
  })

  it('announces the first request arriving after a loaded empty model', () => {
    const { store } = testStore()
    const { source, feed } = fakeSource()
    const stop = store.getState().startWorkSource(source)
    try {
      feed.onModel({ ...LOCAL_MODEL, requests: [] })
      const request = { ...LOCAL_MODEL.requests[0], closed: false }
      feed.onModel({ ...LOCAL_MODEL, requests: [request] })
      assert.deepEqual([...store.getState().work.freshlyUpdatedIds], [request.id])
      assert.deepEqual(store.getState().work.recentChanges.map(change => change.kind), ['new'])
    } finally { stop() }
  })

  it('drops a recent change once its request is no longer in the model', async () => {
    const { store } = testStore()
    const { source, feed } = fakeSource()
    store.getState().startWorkSource(source)
    feed.onModel(withRequests(1))
    feed.onModel(withRequests(2))
    const added = LOCAL_MODEL.requests[1].id
    assert.deepEqual(store.getState().work.recentChanges.map((change) => change.requestId), [added])
    // The new request is folded away (say, grouped into an overall request) and nothing else changes.
    feed.onModel(withRequests(1))
    assert.deepEqual(store.getState().work.recentChanges, [])
  })

  it('starts a manual refresh through the active source', async () => {
    const { store } = testStore()
    let refreshes = 0
    const { source } = fakeSource({ refreshWork: async () => { refreshes++; return { state: 'running' } } })
    store.getState().startWorkSource(source)
    assert.deepEqual(await store.getState().refreshWork(), { state: 'running' })
    assert.equal(refreshes, 1)
  })

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
  it('updates sync-only evidence without replacing the loaded work', () => {
    const { store } = testStore()
    const { source, feed } = fakeSource()
    const stop = store.getState().startWorkSource(source)
    feed.onModel(LOCAL_MODEL)
    const loaded = store.getState().work.load
    feed.onConnection({ ...LOCAL_MODEL.connection, sync: {
      state: 'offline', label: 'Cloud sync unavailable', detail: 'Download failed.', tone: 'warning', isCurrent: false,
    } })
    assert.equal(store.getState().work.connection?.sync?.state, 'offline')
    assert.equal(store.getState().work.load, loaded)
    stop()
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

describe('usage counts', () => {
  it('counts the page opening once, then a switch, and not another open', () => {
    const { store, usage } = testStore()
    store.getState().reportOpen()
    store.getState().reportOpen()
    store.getState().setListView('agents')
    store.getState().reportOpen()
    assert.deepEqual(usage, [{ event: 'opened', view: 'work' }])
    store.getState().goToPage('rules')
    assert.deepEqual(usage, [
      { event: 'opened', view: 'work' },
      { event: 'switched', view: 'rules', previousView: 'work' },
    ])
    store.getState().showUrl()
    assert.equal(usage.length, 2)
  })
})

describe('where the person is', () => {
  it('opens a deferred installation in setup and returns to My Work when complete', () => {
    const { store, urls } = testStore({ href: 'http://localhost/?view=rules' })
    store.getState().startSetup()
    assert.equal(store.getState().view.page, 'setup')
    assert.equal(new URL(urls.at(-1)!.href).searchParams.get('setup'), '1')
    store.getState().finishSetup()
    assert.equal(store.getState().view.page, 'app')
    assert.equal(store.getState().view.section, 'work')
    assert.equal(new URL(urls.at(-1)!.href).searchParams.has('setup'), false)
  })
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
    first.getState().setListView('agents')
    first.getState().setFilter('done')
    first.getState().goToPage('rules')
    const saved = JSON.parse(storage.items.get('claude-mem:my-work:preferences')!)
    assert.deepEqual(saved.state, { listView: 'agents', focusThreadView: 'threads', filter: 'done', focusArrangement: 'priority', doneColumnOpen: false })
    const next = testStore({ storage }).store.getState().view
    assert.deepEqual([next.listView, next.filter, next.section], ['agents', 'done', 'work'])
  })

  it('starts on Open, with what rests in Done out of the way: the filter is not Done and the board\'s Done column is folded', () => {
    const view = testStore().store.getState().view
    assert.deepEqual([view.filter, view.doneColumnOpen], ['open', false])
    assert.equal(WORK_FILTERS[0], 'open')
  })

  for (const [retired, now] of [['all', 'open'], ['shipped', 'done'], ['closed', 'done']] as const) {
    it(`reads a saved ${retired} filter as ${now}`, () => {
      const storage = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { listView: 'agents', filter: retired } }) })
      const view = testStore({ storage }).store.getState().view
      assert.deepEqual([view.listView, view.filter, view.doneColumnOpen], ['agents', now, false])
    })
  }

  it('keeps the board\'s Done column open across a reload once the person opens it, and folded again once they fold it', () => {
    const storage = memoryStorage()
    testStore({ storage }).store.getState().setDoneColumnOpen(true)
    const next = testStore({ storage }).store
    assert.equal(next.getState().view.doneColumnOpen, true)
    next.getState().setDoneColumnOpen(false)
    assert.equal(testStore({ storage }).store.getState().view.doneColumnOpen, false)
    const odd = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { doneColumnOpen: 'yes' } }) })
    assert.equal(testStore({ storage: odd }).store.getState().view.doneColumnOpen, false)
  })

  it('keeps the board inside a focus across a reload, and rows until the person chooses', () => {
    const storage = memoryStorage()
    const first = testStore({ storage }).store
    assert.equal(first.getState().view.focusThreadView, 'threads')
    first.getState().setFocusThreadView('board')
    assert.equal(testStore({ storage }).store.getState().view.focusThreadView, 'board')
    first.getState().setFocusThreadView('cards')
    assert.equal(testStore({ storage }).store.getState().view.focusThreadView, 'cards')
    for (const unknown of ['list', 'table', '', 3, null]) {
      const odd = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { focusThreadView: unknown } }) })
      assert.equal(testStore({ storage: odd }).store.getState().view.focusThreadView, 'threads')
    }
  })

  it('offers Threads, Board and Cards inside a focus, and Threads first at the top level with Cards beside it', () => {
    assert.deepEqual([...FOCUS_THREAD_VIEWS], ['threads', 'board', 'cards'])
    assert.deepEqual(WORK_LIST_VIEWS.slice(0, 2), ['threads', 'cards'])
    assert.equal(testStore().store.getState().view.listView, 'threads')
  })

  it('keeps the top level on Cards across a reload once the person picks it', () => {
    const storage = memoryStorage()
    testStore({ storage }).store.getState().setListView('cards')
    assert.equal(JSON.parse(storage.items.get('claude-mem:my-work:preferences')!).state.listView, 'cards')
    assert.equal(testStore({ storage }).store.getState().view.listView, 'cards')
  })

  it('reads a Cards view saved before the thread list as Cards, since the focus cards it showed are back', () => {
    const storage = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { listView: 'cards', filter: 'working', sort: 'started' } }) })
    const view = testStore({ storage }).store.getState().view
    assert.deepEqual([view.listView, view.focusThreadView, view.filter], ['cards', 'threads', 'working'])
  })

  for (const unknown of ['grid', 'kanban', '', 7, null]) {
    it(`reads a saved top-level view of ${JSON.stringify(unknown)} as Threads`, () => {
      const storage = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { listView: unknown, filter: 'working' } }) })
      const view = testStore({ storage }).store.getState().view
      assert.deepEqual([view.listView, view.filter], ['threads', 'working'])
    })
  }

  it('reads a Board saved for every request as the focus list with the board inside each focus, never a blank top level', () => {
    const storage = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { listView: 'board', filter: 'working' } }) })
    const view = testStore({ storage }).store.getState().view
    assert.deepEqual([view.listView, view.focusThreadView, view.filter], ['threads', 'board', 'working'])
    assert.ok(!(WORK_LIST_VIEWS as readonly string[]).includes('board'))
    // A choice made inside a focus since then is the one kept.
    const later = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { listView: 'board', focusThreadView: 'threads' } }) })
    assert.deepEqual([testStore({ storage: later }).store.getState().view.listView, testStore({ storage: later }).store.getState().view.focusThreadView], ['threads', 'threads'])
  })

  it('leaves unknown saved values at their defaults, drops the team view, and starts the theme from ?theme=', () => {
    const storage = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { dark: false, listView: 'team', filter: 'mine', sort: 7, focusArtwork: 'animated' } }) })
    const view = testStore({ storage, href: 'http://localhost/?theme=dark' }).store.getState().view
    assert.deepEqual([view.dark, view.listView, view.filter], [true, 'threads', 'open'])
  })

  it('reads a saved List view, which is gone, as the thread list', () => {
    const storage = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { listView: 'list', filter: 'working', sort: 'started' } }) })
    const view = testStore({ storage }).store.getState().view
    assert.deepEqual([view.listView, view.filter], ['threads', 'working'])
  })

  it('reads preferences saved while the retired artwork setting existed, and stops saving it', () => {
    const storage = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { listView: 'agents', filter: 'working', focusArtwork: 'compact' } }) })
    const first = testStore({ storage }).store
    assert.deepEqual([first.getState().view.listView, first.getState().view.filter], ['agents', 'working'])
    first.getState().setFilter('done')
    assert.deepEqual(JSON.parse(storage.items.get('claude-mem:my-work:preferences')!).state, { listView: 'agents', focusThreadView: 'threads', filter: 'done', focusArrangement: 'priority', doneColumnOpen: false })
  })

  it('keeps the focus list arranged by initiative across a reload, and by priority until the owner chooses', () => {
    const storage = memoryStorage()
    const first = testStore({ storage }).store
    assert.equal(first.getState().view.focusArrangement, 'priority')
    first.getState().setFocusArrangement('initiative')
    assert.equal(testStore({ storage }).store.getState().view.focusArrangement, 'initiative')
  })

  it('reads an arrangement saved as "project", before it was renamed, as by initiative', () => {
    const storage = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { listView: 'threads', focusArrangement: 'project' } }) })
    assert.equal(testStore({ storage }).store.getState().view.focusArrangement, 'initiative')
  })

  for (const unknown of ['status', '', 7, null]) {
    it(`reads a saved arrangement of ${JSON.stringify(unknown)} as by priority`, () => {
      const storage = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { listView: 'agents', focusArrangement: unknown } }) })
      const view = testStore({ storage }).store.getState().view
      assert.deepEqual([view.listView, view.focusArrangement], ['agents', 'priority'])
    })
  }
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
  it('keeps and places a suggested focus as one change, and one Undo hands it back and restores the order', async () => {
    const { store } = testStore()
    const stop = store.getState().startWorkSource(sampleSource)
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const areas = () => { const load = store.getState().work.load; assert.equal(load.state, 'loaded'); return load.state === 'loaded' ? load.model.focusAreas : [] }
      const kept = () => areas().filter((area) => area.status === 'kept' && !area.mergedInto).map((area) => area.id)
      const before = kept()
      const suggested = areas().find((area) => area.status === 'suggested' && !area.mergedInto && area.source !== 'owner')!
      const placed = [before[0], suggested.id, ...before.slice(1)]
      assert.equal(await store.getState().applyFocusChange({ action: 'reorder', focusAreaIds: placed }, {
        text: 'Kept and placed', undo: [{ action: 'restore-suggestion', focusAreaId: suggested.id }, { action: 'reorder', focusAreaIds: before }],
      }), true)
      assert.deepEqual(kept(), placed)
      assert.equal(store.getState().focus.history.length, 1)
      assert.equal(await store.getState().undoLastFocusChange(), true)
      assert.deepEqual(kept(), before)
      assert.deepEqual([areas().find((area) => area.id === suggested.id)!.status, store.getState().focus.history.length], ['suggested', 0])
    } finally { stop() }
  })

  it('keeps a later focus edit when Undo refers to an older saved version', async () => {
    const { store } = testStore()
    const area = LOCAL_MODEL.focusAreas[0]
    const saved = { ...LOCAL_MODEL, focusAreas: [{ ...area, name: 'Saved name' }] }
    const sent: string[] = []
    const { source, feed } = fakeSource({ saveFocusChange: async change => { sent.push(change.action); return saved } })
    const stop = store.getState().startWorkSource(source)
    try {
      feed.onModel({ ...LOCAL_MODEL, focusAreas: [area] })
      await store.getState().applyFocusChange({ action: 'rename', focusAreaId: area.id, name: 'Saved name' }, {
        text: 'Renamed', undo: [{ action: 'rename', focusAreaId: area.id, name: area.name }],
      })
      feed.onModel({ ...saved, focusAreas: [{ ...area, name: 'Newer edit from another tab' }] })
      assert.equal(await store.getState().undoLastFocusChange(), false)
      assert.deepEqual(sent, ['rename'])
      assert.match(store.getState().focus.error ?? '', /changed since your edit/)
      assert.equal(store.getState().focus.history.length, 1)
    } finally { stop() }
  })

  it('refuses an old request placement Undo after the request moves again', async () => {
    const { store } = testStore()
    const request = LOCAL_MODEL.requests[0]
    const saved = { ...LOCAL_MODEL, requests: [{ ...request, focusAreaId: 'area-b' }] }
    const sent: string[] = []
    const { source, feed } = fakeSource({ saveFocusChange: async change => { sent.push(change.action); return saved } })
    const stop = store.getState().startWorkSource(source)
    try {
      feed.onModel({ ...LOCAL_MODEL, requests: [{ ...request, focusAreaId: 'area-a' }] })
      await store.getState().applyFocusChange({ action: 'move-request', requestId: request.id, focusAreaId: 'area-b' }, {
        text: 'Moved', undo: [{ action: 'move-request', requestId: request.id, focusAreaId: 'area-a' }],
      })
      feed.onModel({ ...saved, requests: [{ ...request, focusAreaId: 'area-c' }] })
      assert.equal(await store.getState().undoLastFocusChange(), false)
      assert.deepEqual(sent, ['move-request'])
    } finally { stop() }
  })

  it('refuses an old order Undo after another area is kept', async () => {
    const { store } = testStore()
    const area = { ...LOCAL_MODEL.focusAreas[0], status: 'kept' as const, mergedInto: null }
    const saved = { ...LOCAL_MODEL, focusAreas: [area] }
    const sent: string[] = []
    const { source, feed } = fakeSource({ saveFocusChange: async change => { sent.push(change.action); return saved } })
    const stop = store.getState().startWorkSource(source)
    try {
      feed.onModel(saved)
      await store.getState().applyFocusChange({ action: 'reorder', focusAreaIds: [area.id] }, {
        text: 'Reordered', undo: [{ action: 'reorder', focusAreaIds: [area.id] }],
      })
      feed.onModel({ ...saved, focusAreas: [area, { ...area, id: 'new-area' }] })
      assert.equal(await store.getState().undoLastFocusChange(), false)
      assert.deepEqual(sent, ['reorder'])
    } finally { stop() }
  })

  it('refuses an old notes Undo after newer notes were saved elsewhere, and allows it after an unrelated rename', async () => {
    const { store } = testStore()
    const area = { ...LOCAL_MODEL.focusAreas[0], notes: 'Mine' }
    const saved = { ...LOCAL_MODEL, focusAreas: [area] }
    const sent: FocusChange[] = []
    const { source, feed } = fakeSource({ saveFocusChange: async change => { sent.push(change); return saved } })
    const stop = store.getState().startWorkSource(source)
    try {
      feed.onModel({ ...LOCAL_MODEL, focusAreas: [{ ...area, notes: 'Before' }] })
      await store.getState().applyFocusChange({ action: 'edit-notes', focusAreaId: area.id, notes: 'Mine' }, {
        text: 'Changed the notes', undo: [{ action: 'edit-notes', focusAreaId: area.id, notes: 'Before' }],
      })
      feed.onModel({ ...saved, focusAreas: [{ ...area, notes: 'Newer, from another tab' }] })
      assert.equal(await store.getState().undoLastFocusChange(), false)
      assert.deepEqual(sent.map(change => change.notes), ['Mine'])
      feed.onModel({ ...saved, focusAreas: [{ ...area, name: 'Renamed in another tab' }] })
      assert.equal(await store.getState().undoLastFocusChange(), true)
      assert.deepEqual(sent.map(change => change.notes), ['Mine', 'Before'])
    } finally { stop() }
  })

  it('runs one change at a time, keeps it for Undo, and undoes it', async () => {
    const { store } = testStore()
    const area = LOCAL_MODEL.focusAreas[0]
    const sent: string[] = []
    const changes: FocusChange[] = []
    const gate = deferred<WorkModel>()
    const { source, feed } = fakeSource({ saveFocusChange: (change) => { sent.push(change.action); changes.push(change); return sent.length === 1 ? gate.promise : Promise.resolve(LOCAL_MODEL) } })
    store.getState().startWorkSource(source)
    feed.onModel(LOCAL_MODEL)
    const first = store.getState().applyFocusChange({ action: 'keep', focusAreaId: area.id }, { text: 'Kept A', undo: [{ action: 'restore-suggestion', focusAreaId: area.id }] })
    assert.equal(await store.getState().applyFocusChange({ action: 'dismiss', focusAreaId: area.id }, null), false)
    gate.resolve(LOCAL_MODEL)
    assert.equal(await first, true)
    assert.equal(store.getState().focus.history.at(-1)?.text, 'Kept A')
    assert.equal(await store.getState().undoLastFocusChange(), true)
    assert.deepEqual(sent, ['keep', 'restore-suggestion'])
    assert.equal(changes[1].expectedVersion, focusChangeVersion(changes[1], LOCAL_MODEL.focusAreas, LOCAL_MODEL.requests))
    assert.equal(store.getState().focus.history.length, 0)
  })

  it('allows Undo after unrelated activity and continues only unfinished merge steps', async () => {
    const { store } = testStore()
    const area = { ...LOCAL_MODEL.focusAreas[0], source: 'seed' as const, status: 'kept' as const }
    const merged = { ...LOCAL_MODEL, focusAreas: [{ ...area, mergedInto: 'target' }] }
    const restored = { ...LOCAL_MODEL, focusAreas: [{ ...area, mergedInto: null, status: 'suggested' as const }] }
    const sent: string[] = []
    const { source, feed } = fakeSource({ saveFocusChange: async change => {
      sent.push(change.action)
      if (sent.length === 1) return merged
      if (sent.length === 2) return restored
      if (sent.length === 3) throw new Error('Save failed')
      return { ...restored, focusAreas: [area] }
    } })
    const stop = store.getState().startWorkSource(source)
    try {
      feed.onModel({ ...LOCAL_MODEL, focusAreas: [area] })
      await store.getState().applyFocusChange({ action: 'merge', focusAreaId: area.id, intoFocusAreaId: 'target' }, {
        text: 'Merged', undo: [{ action: 'restore-suggestion', focusAreaId: area.id }, { action: 'keep', focusAreaId: area.id }],
      })
      feed.onModel({ ...merged, focusAreas: [{ ...merged.focusAreas[0], latestAt: 'Now', timesAsked: 100 }, { ...area, id: 'unrelated', name: 'Another area' }] })
      assert.equal(await store.getState().undoLastFocusChange(), false)
      assert.deepEqual(sent, ['merge', 'restore-suggestion', 'keep'])
      assert.equal(await store.getState().undoLastFocusChange(), true)
      assert.deepEqual(sent, ['merge', 'restore-suggestion', 'keep', 'keep'])
      assert.equal(store.getState().focus.history.length, 0)
    } finally { stop() }
  })

  it('stops a merge Undo if a newer decision arrives between its writes', async () => {
    const { store } = testStore()
    const area = { ...LOCAL_MODEL.focusAreas[0], source: 'seed' as const, status: 'kept' as const }
    const merged = { ...LOCAL_MODEL, focusAreas: [{ ...area, mergedInto: 'target' }] }
    const restored = { ...LOCAL_MODEL, focusAreas: [{ ...area, mergedInto: null, status: 'suggested' as const }] }
    const newer = { ...LOCAL_MODEL, focusAreas: [{ ...area, mergedInto: null, status: 'done' as const }] }
    const gate = deferred<WorkModel>()
    const sent: string[] = []
    const { source, feed } = fakeSource({
      loadWorkModel: async () => newer,
      saveFocusChange: async change => { sent.push(change.action); return sent.length === 1 ? merged : gate.promise },
    })
    const stop = store.getState().startWorkSource(source)
    try {
      feed.onModel({ ...LOCAL_MODEL, focusAreas: [area] })
      await store.getState().applyFocusChange({ action: 'merge', focusAreaId: area.id, intoFocusAreaId: 'target' }, {
        text: 'Merged', undo: [{ action: 'restore-suggestion', focusAreaId: area.id }, { action: 'keep', focusAreaId: area.id }],
      })
      const undo = store.getState().undoLastFocusChange()
      feed.onModel(newer)
      gate.resolve(restored)
      assert.equal(await undo, false)
      assert.deepEqual(sent, ['merge', 'restore-suggestion'])
      assert.match(store.getState().focus.error ?? '', /changed since your edit/)
    } finally { stop() }
  })
})

describe('one-click owner runs', () => {
  const loaded = async (overrides: Partial<WorkDataSource>) => {
    const { store } = testStore()
    const { source, feed, reads } = fakeSource(overrides)
    store.getState().startWorkSource(source)
    reads[0].resolve(LOCAL_MODEL)
    await settle()
    return { store, feed }
  }

  it('sends each click once with a token of its own, and a double click sends one', async () => {
    const sent: { requestId: string; text: string; token: string }[] = []
    const start = deferred<{ outcome: 'started' }>()
    const { store } = await loaded({ answerRequest: (requestId, text, token) => { sent.push({ requestId, text, token }); return start.promise } })
    const first = store.getState().answerRequest('r5', 'Linear.')
    assert.deepEqual(await store.getState().answerRequest('r5', 'Linear.'), { outcome: 'duplicate' })
    start.resolve({ outcome: 'started' })
    assert.deepEqual(await first, { outcome: 'started' })
    await store.getState().answerRequest('r5', 'Linear, again.')
    assert.equal(sent.length, 2)
    assert.notEqual(sent[0].token, sent[1].token)
    assert.match(sent[0].token, /^[A-Za-z0-9_-]{8,64}$/)
  })

  it('keeps the answer it sent until the delivery went through, so a failed one can be copied', async () => {
    const { store, feed } = await loaded({ answerRequest: async (_requestId, text) => text === 'Refuse me.' ? { outcome: 'refused', reason: 'Codex is not installed on this computer.' } : { outcome: 'started' } })
    const withAnswer = (answer: Request['answer']): WorkModel => ({ ...LOCAL_MODEL, requests: LOCAL_MODEL.requests.map((request) => request.id === 'r5' ? { ...request, answer } : request) })
    await store.getState().answerRequest('r5', 'Refuse me.')
    assert.deepEqual(store.getState().work.sentAnswers, {})
    await store.getState().answerRequest('r5', 'Linear.')
    assert.deepEqual(store.getState().work.sentAnswers, { r5: 'Linear.' })
    feed.onModel(withAnswer({ state: 'answering' }))
    feed.onModel(withAnswer({ state: 'failed', error: 'The tool exited 1' }))
    assert.deepEqual(store.getState().work.sentAnswers, { r5: 'Linear.' })
    feed.onModel(withAnswer({ state: 'delivered' }))
    assert.deepEqual(store.getState().work.sentAnswers, {})
    await store.getState().answerRequest('r5', 'Seasonal.')
    feed.onModel({ ...LOCAL_MODEL, requests: LOCAL_MODEL.requests.filter((request) => request.id !== 'r5') })
    assert.deepEqual(store.getState().work.sentAnswers, {})
  })

  it('passes a refusal through for the fallback, and says so when the source cannot do it', async () => {
    const { store } = await loaded({ answerRequest: async () => ({ outcome: 'refused', reason: 'Codex is not installed on this computer.' }) })
    assert.deepEqual(await store.getState().answerRequest('r5', 'Linear.'), { outcome: 'refused', reason: 'Codex is not installed on this computer.' })
    assert.equal((await store.getState().generateStage('r3', 'deck')).outcome, 'refused')
  })

  it('starts a stage and a plan through the source, and shows the model a saved automatic choice answered', async () => {
    const calls: unknown[] = []
    const { store } = await loaded({
      generateStage: async (requestId, formatId, token) => { calls.push(['stage', requestId, formatId, typeof token]); return { outcome: 'started' } },
      planFocus: async (focusAreaId, token) => { calls.push(['plan', focusAreaId, typeof token]); return { outcome: 'started' } },
      setAutoStageFormat: async (formatId) => { calls.push(['auto', formatId]); return { ...LOCAL_MODEL, autoStageFormat: formatId } },
    })
    await store.getState().generateStage('r3', 'deck')
    await store.getState().planFocus(null)
    await store.getState().setAutoStageFormat('brief')
    assert.deepEqual(calls, [['stage', 'r3', 'deck', 'string'], ['plan', null, 'string'], ['auto', 'brief']])
    const load = store.getState().work.load
    assert.equal(load.state === 'loaded' && load.model.autoStageFormat, 'brief')
  })

  it('saves and removes a focus icon through the source and shows the model it answered, and generates one per click', async () => {
    const calls: unknown[] = []
    const withIcon = (icon?: string) => ({ ...LOCAL_MODEL, focusAreas: LOCAL_MODEL.focusAreas.map((area, index) => index === 0 && icon ? { ...area, icon } : area) })
    const start = deferred<{ outcome: 'started' }>()
    const { store } = await loaded({
      setFocusIcon: async (focusAreaId, upload) => { calls.push(['icon', focusAreaId, upload]); return withIcon(upload ? '0123456789ab' : undefined) },
      generateFocusIcon: (focusAreaId, token, direction) => { calls.push(['generate', focusAreaId, typeof token, direction]); return start.promise },
    })
    const areaId = LOCAL_MODEL.focusAreas[0].id
    const shownIcon = () => { const load = store.getState().work.load; return load.state === 'loaded' ? load.model.focusAreas[0].icon : 'not loaded' }
    await store.getState().setFocusIcon(areaId, { format: 'webp', data: 'UklGRg==' })
    assert.equal(shownIcon(), '0123456789ab')
    await store.getState().setFocusIcon(areaId, null)
    assert.equal(shownIcon(), undefined)
    const first = store.getState().generateFocusIcon(areaId)
    assert.deepEqual(await store.getState().generateFocusIcon(areaId), { outcome: 'duplicate' })
    start.resolve({ outcome: 'started' })
    assert.deepEqual(await first, { outcome: 'started' })
    assert.deepEqual(await store.getState().generateFocusIcon(areaId, 'a paper airplane'), { outcome: 'started' })
    assert.deepEqual(calls, [['icon', areaId, { format: 'webp', data: 'UklGRg==' }], ['icon', areaId, null], ['generate', areaId, 'string', undefined], ['generate', areaId, 'string', 'a paper airplane']])
  })

  it('says why an icon was not saved (a read-only preview refuses every write), and that a viewer cannot do it', async () => {
    const { store } = await loaded({ setFocusIcon: async () => { throw new Error('The icon was not saved: This preview is read-only.') } })
    await assert.rejects(store.getState().setFocusIcon('fa-viewer', null), /This preview is read-only/)
    const bare = await loaded({})
    await assert.rejects(bare.store.getState().setFocusIcon('fa-viewer', null), /unavailable in this viewer/)
    assert.equal((await bare.store.getState().generateFocusIcon('fa-viewer')).outcome, 'refused')
  })

  it('reads a plan\'s proposals once when the model says it is ready, and drops them when it is not', async () => {
    const plan = { state: 'ready' as const, focusAreaId: null, startedAt: 'a', generatedAt: 'b', error: null, skipped: [], proposals: [{ kind: 'goal' as const, focusAreaId: 'fa-viewer', goal: 'g', reason: 'r' }] }
    let reads = 0
    const { store, feed } = await loaded({ loadFocusPlan: async () => { reads++; return plan } })
    const summary = { state: 'ready' as const, focusAreaId: null, startedAt: 'a', generatedAt: 'b', error: null, proposals: 1 }
    feed.onModel({ ...LOCAL_MODEL, focusPlan: { ...summary, state: 'planning', generatedAt: null, proposals: 0 } })
    await settle()
    assert.equal(store.getState().work.focusPlan, null)
    feed.onModel({ ...LOCAL_MODEL, focusPlan: summary })
    feed.onModel({ ...withRequests(2), focusPlan: summary })
    await settle()
    assert.deepEqual(store.getState().work.focusPlan, plan)
    assert.equal(reads, 1)
    feed.onModel({ ...LOCAL_MODEL, focusPlan: { ...summary, state: 'failed', generatedAt: null, error: 'Claude Code: quota', proposals: 0 } })
    await settle()
    assert.equal(store.getState().work.focusPlan, null)
  })

  it('never shows a plan whose read finishes after the model has moved on to another plan', async () => {
    const plan = (generatedAt: string, goal: string) => ({ state: 'ready' as const, focusAreaId: null, startedAt: 'a', generatedAt, error: null, skipped: [], proposals: [{ kind: 'goal' as const, focusAreaId: 'fa-viewer', goal, reason: 'r' }] })
    const summary = { state: 'ready' as const, focusAreaId: null, startedAt: 'a', generatedAt: 'first', error: null, proposals: 1 }
    const reads = [deferred<ReturnType<typeof plan>>(), deferred<ReturnType<typeof plan>>()]
    let started = 0
    const { store, feed } = await loaded({ loadFocusPlan: () => reads[started++].promise })
    feed.onModel({ ...LOCAL_MODEL, focusPlan: summary })
    feed.onModel({ ...LOCAL_MODEL, focusPlan: { ...summary, state: 'planning', generatedAt: null, proposals: 0 } })
    reads[0].resolve(plan('first', 'old goal'))
    await settle()
    assert.equal(store.getState().work.focusPlan, null)

    feed.onModel({ ...LOCAL_MODEL, focusPlan: { ...summary, generatedAt: 'second' } })
    reads[1].resolve(plan('second', 'new goal'))
    await settle()
    assert.deepEqual(store.getState().work.focusPlan, plan('second', 'new goal'))
  })
})

