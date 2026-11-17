// The one My Work store: live reads and saves that can't overwrite newer work, the URL as the place, saved
// display preferences, and one save at a time with receipts for the version saved.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SaveRefusedError, type FocusChange } from '../data.ts'
import { focusChangeVersion } from '../../../../shared/focus-change-version.ts'
import type { OwnerRule } from '../data-rules.ts'
import type { ConnectionStatus } from '../live/connection-status.ts'
import { sampleSource } from '../live/sample-source.ts'
import type { UsageReport } from '../live/usage.ts'
import type { RuleSaveResult, WorkDataSource, WorkModel } from '../live/work-data-source.ts'
import { createBoundStore } from './create-store.ts'
import { OLDEST_MIGRATED_PREFERENCES_VERSION, PREFERENCES_STORAGE_KEY, PREFERENCES_VERSION } from './preferences.ts'
import { themeChoiceInUse } from './slices/view-slice.ts'
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
  const scrolls = { toTop: 0 }
  const environment: StoreEnvironment = {
    href: () => href,
    writeUrl: (url, replace) => { href = url.href; urls.push({ href: url.href, replace }) },
    storage: options.storage ?? memoryStorage(),
    reportsUsage: true,
    sendUsage: (report) => { if (report) usage.push(report) },
    scrollToTop: () => { scrolls.toTop++ },
  }
  const store = createBoundStore(environment)
  return { store, urls, usage, scrolls, setHref: (next: string) => { href = next } }
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

  it('hands a conversation row the active source only when it can continue a conversation from this page', () => {
    const { store } = testStore()
    const { source } = fakeSource({
      loadConversationContinuation: () => Promise.reject(new Error('not used')),
      continueConversation: () => Promise.reject(new Error('not used')),
      stopConversationContinuation: () => Promise.reject(new Error('not used')),
      subscribeToConversationContinuations: () => () => {},
    })
    const stopLocal = store.getState().startWorkSource(source)
    assert.equal(store.getState().conversationContinuationSource(), source)
    stopLocal()
    const stopSample = store.getState().startWorkSource(sampleSource)
    assert.equal(store.getState().conversationContinuationSource(), null, 'sample data cannot run a CLI on this computer')
    stopSample()
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
    assert.match(store.getState().work.readAfterSaveFailure ?? '', /worker restarting/)
    const load = store.getState().work.load
    assert.equal(load.state === 'loaded' && load.model.requests.length, 4)
  })

  it('the next read that succeeds clears a failed read after a save (Try again on the notice)', async () => {
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
    assert.ok(store.getState().work.readAfterSaveFailure)
    const retrying = store.getState().retryWorkRead()
    reads[2].resolve(withRequests(4))
    await retrying
    assert.equal(store.getState().work.readAfterSaveFailure, null)
  })

  it('a newer model from the live feed clears the notice that a save’s follow-up read failed', async () => {
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
    assert.ok(store.getState().work.readAfterSaveFailure)
    feed.onModel(withRequests(5))
    assert.equal(store.getState().work.readAfterSaveFailure, null, 'the screen shows the worker’s newer work, so it is not behind')
    const load = store.getState().work.load
    assert.equal(load.state === 'loaded' && load.model.requests.length, 5)
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
    store.getState().setListView('list')
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

  it('Reply opens the drawer on its reply box; the address is the plain drawer, and a later open is plain (G2)', () => {
    const { store, urls } = testStore()
    const [first, second] = LOCAL_MODEL.requests
    store.getState().openRequestDrawer(first, { reply: true })
    assert.equal(store.getState().view.openRequest?.replyAsked, true)
    assert.equal(urls.at(-1)?.href, `http://localhost/?request=${first.id}`)
    store.getState().openRequestDrawer(second)
    assert.equal(store.getState().view.openRequest?.replyAsked, undefined)
  })

  it('the home anchors have their own addresses; asking for one scrolls there, Back does not', () => {
    const { store, urls, scrolls } = testStore({ href: 'http://localhost/?view=rules' })
    store.getState().goToHome('all-requests')
    assert.deepEqual(urls.at(-1), { href: 'http://localhost/#all-requests', replace: false })
    assert.deepEqual([store.getState().view.section, store.getState().view.homeAnchor, store.getState().view.homeAnchorRequest], ['work', 'all-requests', { anchor: 'all-requests', sequence: 1 }])
    store.getState().goToHome('focus-areas')
    assert.equal(urls.at(-1)?.href, 'http://localhost/#focus-areas')
    assert.deepEqual(store.getState().view.homeAnchorRequest, { anchor: 'focus-areas', sequence: 2 })
    store.getState().openRequestDrawer(LOCAL_MODEL.requests[0])
    assert.equal(urls.at(-1)?.href, `http://localhost/?request=${LOCAL_MODEL.requests[0].id}#focus-areas`, 'the drawer opens over the same place')
    store.getState().goToFocus('fa-sync')
    assert.equal(urls.at(-1)?.href, 'http://localhost/?focus=fa-sync', 'leaving home drops the anchor')
    assert.deepEqual([store.getState().view.homeAnchor, store.getState().view.homeAnchorRequest], [null, null], 'and the ask')
    store.getState().selectFocus(null)
    assert.deepEqual([urls.at(-1)?.href, scrolls.toTop], ['http://localhost/', 1], 'Focus overview is the top of home')
    assert.equal(store.getState().view.homeAnchorRequest, null, 'the top of home is not an anchor ask')
    store.getState().goToHome('focus-areas')
    assert.deepEqual(store.getState().view.homeAnchorRequest, { anchor: 'focus-areas', sequence: 3 }, 'a new ask never reuses an old number')
  })

  it('an old "All N" ask does not open the whole board again after the person left home (quality review L5)', () => {
    const { store } = testStore()
    store.getState().goToHome('focus-areas')
    assert.deepEqual(store.getState().view.homeAnchorRequest, { anchor: 'focus-areas', sequence: 1 })
    store.getState().goToFocus('fa-sync')
    store.getState().selectFocus(null)
    assert.equal(store.getState().view.homeAnchorRequest, null, 'Focus overview draws the board with its priority areas')
    for (const leave of [() => store.getState().goToPage('rules'), () => store.getState().selectFocus({ kind: 'suggested' }), () => store.getState().selectFocus({ kind: 'past-focus' })]) {
      store.getState().goToHome('focus-areas')
      leave()
      assert.equal(store.getState().view.homeAnchorRequest, null)
    }
  })

  it('Back or Forward to another place ends an anchor ask; to the same anchor it keeps it', () => {
    const { store, setHref } = testStore()
    store.getState().goToHome('focus-areas')
    const ask = store.getState().view.homeAnchorRequest
    setHref('http://localhost/#focus-areas')
    store.getState().showUrl()
    assert.equal(store.getState().view.homeAnchorRequest, ask, 'the same place: the board keeps every area')
    for (const elsewhere of ['http://localhost/?focus=fa-sync', 'http://localhost/', 'http://localhost/#all-requests', 'http://localhost/?view=rules']) {
      store.getState().goToHome('focus-areas')
      setHref(elsewhere)
      store.getState().showUrl()
      assert.equal(store.getState().view.homeAnchorRequest, null, elsewhere)
    }
  })

  it('an address with a home anchor scrolls there once; other fragments and other pages carry none', () => {
    assert.deepEqual(testStore({ href: 'http://localhost/#focus-areas' }).store.getState().view.homeAnchorRequest, { anchor: 'focus-areas', sequence: 1 })
    assert.equal(testStore({ href: 'http://localhost/#focus-areas' }).store.getState().view.homeAnchor, 'focus-areas')
    assert.equal(testStore({ href: 'http://localhost/#somewhere' }).store.getState().view.homeAnchor, null)
    assert.equal(testStore({ href: 'http://localhost/?view=rules#all-requests' }).store.getState().view.homeAnchor, null)
    assert.equal(testStore({ href: 'http://localhost/?focus=fa-sync#all-requests' }).store.getState().view.homeAnchorRequest, null)
    const { store, setHref } = testStore({ href: 'http://localhost/?view=rules' })
    setHref('http://localhost/#all-requests')
    store.getState().showUrl()
    assert.deepEqual([store.getState().view.homeAnchor, store.getState().view.homeAnchorRequest], ['all-requests', null], 'Back restores the scroll itself')
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
    first.getState().setFocusArtwork('compact')
    first.getState().goToPage('rules')
    const saved = JSON.parse(storage.items.get('claude-mem:my-work:preferences')!)
    assert.deepEqual(saved.state, { listView: 'list', filter: 'closed', sort: 'attention', focusArtwork: 'compact', theme: 'system' })
    const next = testStore({ storage }).store.getState().view
    assert.deepEqual([next.listView, next.filter, next.focusArtwork, next.section], ['list', 'closed', 'compact', 'work'])
  })

  it('leaves unknown saved values at their defaults, drops the team view, and starts the theme from ?theme=', () => {
    const storage = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { dark: false, theme: 'sepia', listView: 'team', filter: 'mine', sort: 7, focusArtwork: 'animated' } }) })
    const view = testStore({ storage, href: 'http://localhost/?theme=dark' }).store.getState().view
    assert.deepEqual([themeChoiceInUse(view), view.listView, view.filter, view.sort, view.focusArtwork], ['dark', 'cards', 'all', 'attention', 'compact'])
    assert.equal(themeChoiceInUse(testStore({ storage }).store.getState().view), 'system', 'an unknown saved theme falls back to the system')
    assert.equal(themeChoiceInUse(testStore({ storage, href: 'http://localhost/?theme=sepia' }).store.getState().view), 'system', 'an unknown ?theme= is ignored')
  })

  it('drops preferences saved by a version it cannot migrate, as the pre-paint script does', () => {
    for (const version of [OLDEST_MIGRATED_PREFERENCES_VERSION - 1, PREFERENCES_VERSION + 1]) {
      const storage = memoryStorage({ [PREFERENCES_STORAGE_KEY]: JSON.stringify({ version, state: { theme: 'dark', listView: 'list' } }) })
      const view = testStore({ storage }).store.getState().view
      assert.deepEqual([view.theme, view.listView], ['system', 'cards'], `version ${version}`)
    }
  })

  it('opens Compact for a browser whose version-1 save held the old default, Full; a choice of Full after that stays Full', () => {
    // 15.19.0 saved 'full' on every visit, as if chosen (persist writes after every state change). Its other choices stay.
    const storage = memoryStorage({ [PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 1, state: { listView: 'list', filter: 'working', sort: 'started', focusArtwork: 'full', theme: 'dark' } }) })
    const first = testStore({ storage }).store
    const view = first.getState().view
    assert.deepEqual([view.focusArtwork, view.listView, view.filter, view.sort, view.theme], ['compact', 'list', 'working', 'started', 'dark'])
    assert.equal(JSON.parse(storage.items.get(PREFERENCES_STORAGE_KEY)!).version, PREFERENCES_VERSION, 'the migrated choices are saved in this version')
    first.getState().setFocusArtwork('full')
    for (const reload of [1, 2]) assert.equal(testStore({ storage }).store.getState().view.focusArtwork, 'full', `a chosen Full survives reload ${reload}`)
    // A version-1 save that chose Off or Compact keeps it: only the old default is not a choice.
    const off = memoryStorage({ [PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 1, state: { focusArtwork: 'off' } }) })
    assert.equal(testStore({ storage: off }).store.getState().view.focusArtwork, 'off')
  })

  it('G8: the theme is one saved choice; ?theme= wins for the visit, and choosing one in the menu saves it and drops ?theme=', () => {
    const storage = memoryStorage()
    const saved = () => JSON.parse(storage.items.get('claude-mem:my-work:preferences')!).state.theme
    const first = testStore({ storage })
    assert.equal(themeChoiceInUse(first.store.getState().view), 'system', 'nothing saved: follow the system')
    first.store.getState().setTheme('dark')
    assert.equal(saved(), 'dark')
    assert.deepEqual(first.urls, [], 'no ?theme= in the address, so nothing to rewrite')
    assert.equal(themeChoiceInUse(testStore({ storage }).store.getState().view), 'dark', 'the saved choice comes back next visit')
    const visit = testStore({ storage, href: 'http://localhost/?view=rules&theme=light' })
    assert.equal(themeChoiceInUse(visit.store.getState().view), 'light', 'the address wins over the saved choice')
    // persist saves the preferences on every state change, so the claim holds only if it survives unrelated ones.
    visit.store.getState().setFilter('working')
    visit.store.getState().setShowSpec(true)
    visit.store.getState().goToPage('work')
    assert.equal(saved(), 'dark', 'an address theme is never saved, even after other changes are')
    assert.equal(JSON.parse(storage.items.get('claude-mem:my-work:preferences')!).state.filter, 'working', 'the other change was saved')
    assert.equal(themeChoiceInUse(visit.store.getState().view), 'light', 'the address still wins for the rest of this visit')
    assert.equal(themeChoiceInUse(testStore({ storage }).store.getState().view), 'dark', 'the next plain visit has the person’s own choice')
    visit.store.getState().setTheme('system')
    assert.deepEqual(visit.urls.at(-1), { href: 'http://localhost/', replace: true })
    assert.equal(saved(), 'system')
    assert.equal(themeChoiceInUse(visit.store.getState().view), 'system', 'a choice in the menu replaces the address theme')
  })

  it('keeps existing preferences when artwork density is absent and remembers turning artwork off', () => {
    const storage = memoryStorage({ 'claude-mem:my-work:preferences': JSON.stringify({ version: 1, state: { listView: 'list', filter: 'working', sort: 'started' } }) })
    const first = testStore({ storage }).store
    // No saved density: the board's default, compact rows (page-01); the other saved choices stay.
    assert.deepEqual([first.getState().view.listView, first.getState().view.focusArtwork], ['list', 'compact'])
    first.getState().setFocusArtwork('off')
    const next = testStore({ storage }).store.getState().view
    assert.deepEqual([next.listView, next.filter, next.sort, next.focusArtwork], ['list', 'working', 'started', 'off'])
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
