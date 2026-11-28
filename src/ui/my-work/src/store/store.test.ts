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
import { activePlace, NO_PAGE_DETAILS, readRoute, REQUESTS_GROUPINGS, themeChoiceInUse, writeRoute } from './slices/view-slice.ts'
import { CARD_GROUPS } from '../live/card-groups.ts'
import { NOT_SORTED_AREA, requestsAreaChoices } from '../live/requests-areas.ts'
import { OTHER_FOCUS_AREA_ID } from '../data.ts'
import type { FocusChangeRecord, StoreEnvironment } from './store-types.ts'
import { MY_WORK_PLACES } from '../../../app-places.ts'
import { WORK_VIEW_SECTIONS } from '../../../../shared/work-view-pages.ts'

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

/** `scrolledTo`: where the person left the entry the store opens on (a reload of it), as the browser keeps it. */
function testStore(options: { href?: string; storage?: ReturnType<typeof memoryStorage>; scrolledTo?: number } = {}) {
  let href = options.href ?? 'http://localhost/'
  const urls: { href: string; replace: boolean }[] = []
  const usage: UsageReport[] = []
  const scrolls = { toTop: 0 }
  // Where the history entry now shown was left scrolled (the browser keeps it by entry, store/index.ts).
  let savedScrollY: number | null = options.scrolledTo ?? null
  const environment: StoreEnvironment = {
    href: () => href,
    writeUrl: (url, replace) => { href = url.href; urls.push({ href: url.href, replace }) },
    storage: options.storage ?? memoryStorage(),
    reportsUsage: true,
    sendUsage: (report) => { if (report) usage.push(report) },
    scrollToTop: () => { scrolls.toTop++ },
    savedScrollY: () => savedScrollY,
  }
  const store = createBoundStore(environment)
  /** Back or Forward to `next`, an entry the person left scrolled to `scrolledTo` (null: no position was saved). */
  const back = (next: string, scrolledTo: number | null = null) => { href = next; savedScrollY = scrolledTo; store.getState().showUrl() }
  return { store, urls, usage, scrolls, back, setHref: (next: string) => { href = next } }
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

  it('Try again answers whether the read worked, and a failed one keeps the shown work', async () => {
    const { store } = testStore()
    const { source, reads } = fakeSource()
    store.getState().startWorkSource(source)
    reads[0].resolve(withRequests(2))
    await settle()
    const failing = store.getState().retryWorkRead()
    reads[1].reject(new Error('worker busy'))
    assert.deepEqual(await failing, { read: false, error: 'worker busy' })
    const load = store.getState().work.load
    assert.equal(load.state === 'loaded' && load.model.requests.length, 2)
    const working = store.getState().retryWorkRead()
    reads[2].resolve(withRequests(3))
    assert.deepEqual(await working, { read: true })
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

  it('every page round-trips through the address: written onto a clean address, it reads back as the same place', () => {
    const hrefs = [
      ...WORK_VIEW_SECTIONS.map((section) => `http://localhost/?view=${section}`),
      'http://localhost/?source=sample&view=requests',
      'http://localhost/?focus=fa-sync',
      'http://localhost/?focus=other',
      'http://localhost/?focus=fa-sync&request=r1',
      'http://localhost/?view=requests&request=r1',
      'http://localhost/?view=find&q=viewer%20sync',
      'http://localhost/?view=find&q=viewer&request=r1',
      ...CARD_GROUPS.map((group) => `http://localhost/?view=requests&status=${group.id}`),
      'http://localhost/?view=requests&status=working&request=r1',
      ...REQUESTS_GROUPINGS.map((by) => `http://localhost/?view=requests&by=${by}`),
      'http://localhost/?view=requests&by=agent&request=r1',
      ...['fa-sync', OTHER_FOCUS_AREA_ID, NOT_SORTED_AREA].map((area) => `http://localhost/?view=requests&area=${area}`),
      'http://localhost/?view=requests&closed=1',
      'http://localhost/?view=requests&q=viewer%20sync',
      'http://localhost/?view=requests&status=idle&area=fa-sync&closed=1&request=r1&q=sync',
    ]
    for (const href of hrefs) {
      const route = readRoute(new URL(href))
      const place = {
        section: route.section, focusChoice: route.focusChoice, openRequest: route.requestId ? { id: route.requestId, fromLiveFeed: null, fallback: null } : null, findQuery: route.findQuery,
        requestsStatus: route.requestsStatus, requestsBy: route.requestsBy, requestsArea: route.requestsArea, requestsClosed: route.requestsClosed, requestsWords: route.requestsWords,
      }
      // Only what writeRoute writes can come back: the clean address keeps just the source, which is not the place's.
      const clean = new URL('http://localhost/')
      const source = new URL(href).searchParams.get('source')
      if (source) clean.searchParams.set('source', source)
      assert.deepEqual(readRoute(writeRoute(clean, place)), route, href)
    }
    // The store writes each page's address on a move to it, and Back to that address shows the same page.
    for (const section of WORK_VIEW_SECTIONS) {
      const { store, urls, back } = testStore({ href: 'http://localhost/?source=sample&focus=fa-sync' })
      store.getState().goToPage(section)
      const written = urls.at(-1)!.href
      assert.equal(readRoute(new URL(written)).section, section, section)
      assert.equal(new URL(written).searchParams.get('source'), 'sample', section)
      store.getState().goToFocus('fa-sync')
      back(written)
      assert.deepEqual([store.getState().view.section, store.getState().view.focusChoice], [section, null], section)
    }
  })

  it('Find work\'s words live in the address on its page only: written in place as they are typed, empty or elsewhere they read as none', () => {
    assert.equal(readRoute(new URL('http://localhost/?view=find&q=viewer')).findQuery, 'viewer')
    assert.equal(readRoute(new URL('http://localhost/?view=find&q=')).findQuery, null, 'empty words are none')
    assert.equal(readRoute(new URL('http://localhost/?view=find')).findQuery, null)
    assert.equal(readRoute(new URL('http://localhost/?view=rules&q=viewer')).findQuery, null, 'on another page the words are no detail of it')
    assert.equal(writeRoute(new URL('http://localhost/?view=rules&q=viewer'), { section: 'rules', openRequest: null, ...NO_PAGE_DETAILS, findQuery: 'viewer' }).searchParams.has('q'), false)
    const { store, urls, back } = testStore({ href: 'http://localhost/?source=sample' })
    store.getState().goToPage('find')
    assert.deepEqual(urls.at(-1), { href: 'http://localhost/?source=sample&view=find', replace: false })
    store.getState().setFindQuery('view')
    store.getState().setFindQuery('viewer')
    assert.deepEqual(urls.slice(-2), [{ href: 'http://localhost/?source=sample&view=find&q=view', replace: true }, { href: 'http://localhost/?source=sample&view=find&q=viewer', replace: true }], 'each word replaces the entry: Back leaves Find work, not one letter')
    assert.equal(store.getState().view.findQuery, 'viewer')
    // A result opened over Find work keeps the words; another page drops them, and Back brings them again.
    store.getState().openRequestDrawer(LOCAL_MODEL.requests[0])
    assert.equal(urls.at(-1)?.href, `http://localhost/?source=sample&view=find&q=viewer&request=${LOCAL_MODEL.requests[0].id}`)
    store.getState().closeRequestDrawer()
    store.getState().goToPage('rules')
    assert.deepEqual([store.getState().view.findQuery, new URL(urls.at(-1)!.href).searchParams.has('q')], [null, false])
    back('http://localhost/?source=sample&view=find&q=viewer')
    assert.deepEqual([store.getState().view.section, store.getState().view.findQuery], ['find', 'viewer'])
    store.getState().setFindQuery('')
    assert.equal(urls.at(-1)?.href, 'http://localhost/?source=sample&view=find', 'clearing the box clears the address')
  })

  it('Requests\' status tab and grouping live in the address on its page only: each round-trips, and a value neither list names, or another page, reads as none', () => {
    // Every status tab and every grouping, written onto a clean address, read back as the same.
    for (const group of CARD_GROUPS) {
      const route = readRoute(new URL(`http://localhost/?view=requests&status=${group.id}`))
      assert.deepEqual([route.section, route.requestsStatus, route.requestsBy], ['requests', group.id, null], group.id)
      const written = writeRoute(new URL('http://localhost/'), { section: 'requests', openRequest: null, ...NO_PAGE_DETAILS, requestsStatus: group.id })
      assert.equal(written.href, `http://localhost/?view=requests&status=${group.id}`)
    }
    for (const by of REQUESTS_GROUPINGS) {
      const written = writeRoute(new URL('http://localhost/'), { section: 'requests', openRequest: null, ...NO_PAGE_DETAILS, requestsBy: by })
      assert.equal(written.href, `http://localhost/?view=requests&by=${by}`)
      assert.deepEqual([readRoute(written).requestsBy, readRoute(written).requestsStatus], [by, null])
    }
    // Unknown values, and either detail on another page, read as none and are not written back.
    assert.equal(readRoute(new URL('http://localhost/?view=requests&status=parked')).requestsStatus, null)
    assert.equal(readRoute(new URL('http://localhost/?view=requests&status=')).requestsStatus, null)
    assert.equal(readRoute(new URL('http://localhost/?view=requests&by=person')).requestsBy, null)
    assert.deepEqual([readRoute(new URL('http://localhost/?view=rules&status=working&by=agent')).requestsStatus, readRoute(new URL('http://localhost/?view=rules&status=working&by=agent')).requestsBy], [null, null])
    assert.deepEqual([readRoute(new URL('http://localhost/?status=working')).requestsStatus, readRoute(new URL('http://localhost/?by=agent')).requestsBy], [null, null])
    // By agent has no status tabs: a status beside it is no detail of it.
    assert.deepEqual([readRoute(new URL('http://localhost/?view=requests&by=agent&status=working')).requestsStatus, readRoute(new URL('http://localhost/?view=requests&by=agent&status=working')).requestsBy], [null, 'agent'])
    const other = writeRoute(new URL('http://localhost/?view=requests&status=working&by=agent'), { section: 'rules', openRequest: null, ...NO_PAGE_DETAILS, requestsStatus: 'working', requestsBy: 'agent' })
    assert.deepEqual([other.searchParams.has('status'), other.searchParams.has('by')], [false, false])
  })

  it('Requests\' area, closed choice and find words live in the address on its list only: each round-trips onto a clean address; empty, unknown, on another page or beside By agent they read as none', () => {
    const onList = (details: Partial<typeof NO_PAGE_DETAILS>) => writeRoute(new URL('http://localhost/'), { section: 'requests', openRequest: null, ...NO_PAGE_DETAILS, ...details })
    // Each area choice: an area's id, Other's and the requests not sorted yet.
    for (const area of [LOCAL_MODEL.focusAreas[0].id, OTHER_FOCUS_AREA_ID, NOT_SORTED_AREA]) {
      const written = onList({ requestsArea: area })
      assert.equal(written.href, `http://localhost/?view=requests&area=${area}`)
      assert.equal(readRoute(written).requestsArea, area)
    }
    const closed = onList({ requestsClosed: true })
    assert.deepEqual([closed.href, readRoute(closed).requestsClosed], ['http://localhost/?view=requests&closed=1', true])
    const words = onList({ requestsWords: 'viewer sync' })
    assert.deepEqual([words.href, readRoute(words).requestsWords], ['http://localhost/?view=requests&q=viewer+sync', 'viewer sync'])
    const all = onList({ requestsStatus: 'idle', requestsArea: OTHER_FOCUS_AREA_ID, requestsClosed: true, requestsWords: 'sync' })
    assert.equal(all.href, 'http://localhost/?view=requests&status=idle&area=other&closed=1&q=sync')
    assert.deepEqual(readRoute(all), { ...readRoute(new URL('http://localhost/?view=requests')), requestsStatus: 'idle', requestsArea: OTHER_FOCUS_AREA_ID, requestsClosed: true, requestsWords: 'sync' })
    // A closed flag that is not the flag, an empty area or empty words read as none.
    for (const flag of ['0', 'yes', 'true', '']) assert.equal(readRoute(new URL(`http://localhost/?view=requests&closed=${flag}`)).requestsClosed, false, flag)
    assert.deepEqual([readRoute(new URL('http://localhost/?view=requests&area=')).requestsArea, readRoute(new URL('http://localhost/?view=requests&q=')).requestsWords], [null, null])
    // On another page, or beside By agent (it has no tabs and no filter), none of them is a detail of it, nor written.
    for (const href of ['http://localhost/?view=rules&area=other&closed=1&q=sync', 'http://localhost/?area=other&closed=1', 'http://localhost/?view=requests&by=agent&area=other&closed=1&q=sync']) {
      const route = readRoute(new URL(href))
      assert.deepEqual([route.requestsArea, route.requestsClosed, route.requestsWords], [null, false, null], href)
    }
    const beside = writeRoute(new URL('http://localhost/'), { section: 'requests', openRequest: null, ...NO_PAGE_DETAILS, requestsBy: 'agent', requestsArea: OTHER_FOCUS_AREA_ID, requestsClosed: true, requestsWords: 'sync', requestsStatus: 'idle' })
    assert.equal(beside.href, 'http://localhost/?view=requests&by=agent')
    const elsewhere = writeRoute(new URL('http://localhost/'), { section: 'rules', openRequest: null, ...NO_PAGE_DETAILS, requestsArea: OTHER_FOCUS_AREA_ID, requestsClosed: true, requestsWords: 'sync' })
    assert.equal(elsewhere.href, 'http://localhost/?view=rules')
  })

  it('once the work is read, an area no request sits in reads as every area, and an address naming what Requests does not apply is rewritten in place', async () => {
    const present = requestsAreaChoices(LOCAL_MODEL.requests, LOCAL_MODEL.focusAreas)
    assert.ok(present.length > 0, 'the sample has requests in an area')
    const read = async (href: string) => {
      const { store, urls } = testStore({ href })
      const { source, reads } = fakeSource()
      store.getState().startWorkSource(source)
      reads[0].resolve(LOCAL_MODEL)
      await settle()
      return { view: store.getState().view, urls }
    }
    // An area merged away, dismissed or never in the work: kept while the work is read, then every area, in place.
    const gone = await read('http://localhost/?source=sample&view=requests&area=fa-not-in-the-work&q=sync')
    assert.deepEqual([gone.view.requestsArea, gone.view.requestsWords, gone.urls], [null, 'sync', [{ href: 'http://localhost/?source=sample&view=requests&q=sync', replace: true }]])
    // An area some request sits in keeps its address.
    const kept = await read(`http://localhost/?source=sample&view=requests&area=${present[0]}`)
    assert.deepEqual([kept.view.requestsArea, kept.urls], [present[0], []])
    // A status (or any list detail) typed beside By agent, and a value no list names, leave the address.
    const typed = await read('http://localhost/?source=sample&view=requests&by=agent&status=idle&closed=1')
    assert.deepEqual([typed.view.requestsBy, typed.view.requestsStatus, typed.urls], ['agent', null, [{ href: 'http://localhost/?source=sample&view=requests&by=agent', replace: true }]])
    const unknown = await read('http://localhost/?source=sample&view=requests&status=parked&closed=yes')
    assert.deepEqual([unknown.view.requestsStatus, unknown.view.requestsClosed, unknown.urls], [null, false, [{ href: 'http://localhost/?source=sample&view=requests', replace: true }]])
    // Another page's address is not Requests' to rewrite.
    assert.deepEqual((await read('http://localhost/?view=rules&status=idle')).urls, [])
  })

  it('on Requests\' list a status tab keeps the area, the closed choice and the words; an area and the closed choice are history entries, each word replaces the entry; By agent drops them and Back brings them back', () => {
    const { store, urls, back } = testStore({ href: 'http://localhost/?source=sample&view=requests' })
    const asked = store.getState().view.scrollAsk?.sequence
    store.getState().showRequests({ area: OTHER_FOCUS_AREA_ID })
    assert.deepEqual(urls.at(-1), { href: 'http://localhost/?source=sample&view=requests&area=other', replace: false })
    store.getState().showRequests({ closed: true })
    assert.deepEqual(urls.at(-1), { href: 'http://localhost/?source=sample&view=requests&area=other&closed=1', replace: false })
    store.getState().setRequestsWords('vie')
    store.getState().setRequestsWords('viewer')
    assert.deepEqual(urls.slice(-2), [
      { href: 'http://localhost/?source=sample&view=requests&area=other&closed=1&q=vie', replace: true },
      { href: 'http://localhost/?source=sample&view=requests&area=other&closed=1&q=viewer', replace: true },
    ], 'each word replaces the entry: Back takes the last choice back, not one letter')
    store.getState().showRequests({ status: 'idle' })
    // A detail joins the address after those already in it.
    const filtered = 'http://localhost/?source=sample&view=requests&area=other&closed=1&q=viewer&status=idle'
    assert.deepEqual(urls.at(-1), { href: filtered, replace: false })
    assert.equal(store.getState().view.scrollAsk?.sequence, asked, 'a tab, an area and the closed choice ask for no scroll')
    // A request opened over the list keeps them; closed, the address is the list's again.
    store.getState().openRequestDrawer(LOCAL_MODEL.requests[0])
    assert.equal(urls.at(-1)?.href, `${filtered}&request=${LOCAL_MODEL.requests[0].id}`)
    store.getState().closeRequestDrawer()
    assert.equal(urls.at(-1)?.href, filtered)
    // Every area again, and the open requests: only those details change.
    store.getState().showRequests({ area: null, closed: false })
    assert.equal(urls.at(-1)?.href, 'http://localhost/?source=sample&view=requests&q=viewer&status=idle')
    // By agent has none of them; Request list opens the list plain; Back brings the filtered list back.
    store.getState().showRequests({ by: 'agent' })
    const { requestsStatus, requestsArea, requestsClosed, requestsWords } = store.getState().view
    assert.deepEqual([urls.at(-1)?.href, requestsStatus, requestsArea, requestsClosed, requestsWords], ['http://localhost/?source=sample&view=requests&by=agent', null, null, false, null])
    store.getState().showRequests({})
    assert.equal(urls.at(-1)?.href, 'http://localhost/?source=sample&view=requests')
    store.getState().goToPage('rules')
    back(filtered, 480)
    const restored = store.getState().view
    assert.deepEqual([restored.section, restored.requestsStatus, restored.requestsArea, restored.requestsClosed, restored.requestsWords, restored.scrollAsk?.target],
      ['requests', 'idle', OTHER_FOCUS_AREA_ID, true, 'viewer', { to: 'position', y: 480 }])
    // The bar's Requests (any page move) opens the list with none of them.
    store.getState().goToPage('requests')
    assert.equal(urls.at(-1)?.href, 'http://localhost/?source=sample&view=requests')
  })

  it('a status tab is a history entry that leaves the window where it is; the bar\'s Requests opens on All; Back brings the tab back', () => {
    const { store, urls, back } = testStore({ href: 'http://localhost/?source=sample&view=rules' })
    store.getState().showRequests({ status: 'working' })
    assert.deepEqual(urls.at(-1), { href: 'http://localhost/?source=sample&view=requests&status=working', replace: false })
    assert.deepEqual(store.getState().view.scrollAsk?.target, { to: 'top' }, 'from another page, Requests opens at its top')
    const asked = store.getState().view.scrollAsk?.sequence
    store.getState().showRequests({ status: 'idle' })
    assert.deepEqual(urls.at(-1), { href: 'http://localhost/?source=sample&view=requests&status=idle', replace: false })
    assert.equal(store.getState().view.scrollAsk?.sequence, asked, 'a tab asks for no scroll')
    // A request opened over a tab keeps it; closed, the address is the tab's again.
    store.getState().openRequestDrawer(LOCAL_MODEL.requests[0])
    assert.equal(urls.at(-1)?.href, `http://localhost/?source=sample&view=requests&status=idle&request=${LOCAL_MODEL.requests[0].id}`)
    store.getState().closeRequestDrawer()
    // By agent drops the tab and opens at its top; the list comes back on All.
    store.getState().showRequests({ by: 'agent' })
    assert.deepEqual([urls.at(-1)?.href, store.getState().view.requestsStatus, store.getState().view.scrollAsk?.target], ['http://localhost/?source=sample&view=requests&by=agent', null, { to: 'top' }])
    store.getState().showRequests({})
    assert.equal(urls.at(-1)?.href, 'http://localhost/?source=sample&view=requests')
    // Back and Forward bring the tab and the grouping back with the place.
    back('http://localhost/?source=sample&view=requests&status=idle', 640)
    assert.deepEqual([store.getState().view.section, store.getState().view.requestsStatus, store.getState().view.requestsBy, store.getState().view.scrollAsk?.target], ['requests', 'idle', null, { to: 'position', y: 640 }])
    back('http://localhost/?source=sample&view=requests&by=agent', 0)
    assert.deepEqual([store.getState().view.requestsStatus, store.getState().view.requestsBy], [null, 'agent'])
    // The bar's Requests (any page move) opens the list on All; another page leaves both details behind.
    store.getState().goToPage('requests')
    assert.deepEqual([urls.at(-1)?.href, store.getState().view.requestsStatus, store.getState().view.requestsBy], ['http://localhost/?source=sample&view=requests', null, null])
    store.getState().showRequests({ status: 'shipped' })
    store.getState().goToFocus('fa-sync')
    assert.deepEqual([store.getState().view.requestsStatus, new URL(urls.at(-1)!.href).searchParams.has('status')], [null, false])
  })

  it('a rule Find work opens lands My Rules at that rule once it has drawn', () => {
    const { store } = testStore({ href: 'http://localhost/?view=find&q=draft' })
    store.getState().goToPage('rules', { elementId: 'rule-no-draft-pr' })
    assert.deepEqual([store.getState().view.section, store.getState().view.scrollAsk?.target], ['rules', { to: 'element', elementId: 'rule-no-draft-pr' }])
  })

  it('old addresses still land: the home anchors, Suggested, Past focus and an area with its request', () => {
    const at = (href: string) => {
      const view = testStore({ href }).store.getState().view
      return { section: view.section, focusChoice: view.focusChoice, request: view.openRequest?.id ?? null, scrollAsk: view.scrollAsk?.target ?? null }
    }
    assert.deepEqual(at('http://localhost/#all-requests'), { section: 'requests', focusChoice: null, request: null, scrollAsk: null })
    assert.deepEqual(at('http://localhost/#focus-areas'), { section: 'focus', focusChoice: null, request: null, scrollAsk: { to: 'element', elementId: 'focus-areas' } })
    assert.deepEqual(at('http://localhost/?view=suggested'), { section: 'suggested', focusChoice: null, request: null, scrollAsk: null })
    assert.deepEqual(at('http://localhost/?view=past-focus'), { section: 'past-focus', focusChoice: null, request: null, scrollAsk: null })
    assert.deepEqual(at('http://localhost/?focus=fa-sync&request=r1'), { section: 'work', focusChoice: 'fa-sync', request: 'r1', scrollAsk: null })
    // An anchor only ever named a place on the home page: with another page or an area, or any other fragment, it is ignored.
    assert.deepEqual(at('http://localhost/?view=rules#all-requests').section, 'rules')
    assert.deepEqual(at('http://localhost/?focus=fa-sync#all-requests'), { section: 'work', focusChoice: 'fa-sync', request: null, scrollAsk: null })
    assert.deepEqual(at('http://localhost/#somewhere'), { section: 'work', focusChoice: null, request: null, scrollAsk: null })
    // The next move writes the page's own address, without the old anchor.
    const { store, urls } = testStore({ href: 'http://localhost/#focus-areas' })
    store.getState().openRequestDrawer(LOCAL_MODEL.requests[0])
    assert.equal(urls.at(-1)?.href, `http://localhost/?view=focus&request=${LOCAL_MODEL.requests[0].id}`, 'the drawer opens over the same page')
  })

  it('each place opens the page its address names, and the bar marks the place each page sits under', () => {
    for (const place of MY_WORK_PLACES) assert.equal(readRoute(new URL(place.address, 'http://localhost/')).section, place.id, place.label)
    const marked = (href: string) => activePlace(readRoute(new URL(href)))
    assert.deepEqual(['/', '/?view=focus', '/?view=suggested', '/?view=past-focus', '/?focus=fa-sync', '/?focus=other', '/?view=requests', '/?view=review-stack', '/?view=rules&tab=dismissed']
      .map((path) => marked(`http://localhost${path}`)), ['work', 'focus', 'focus', 'focus', 'focus', 'focus', 'requests', 'review-stack', 'rules'])
    // Find work, Workspace and Machine and sync are reached from the bar's own links, which mark themselves: no place.
    assert.deepEqual(['/?view=find', '/?view=workspace', '/?view=machine'].map((path) => marked(`http://localhost${path}`)), [null, null, null])
  })

  it('a move scrolls its page once it has drawn: a new page from its top, Focus areas at its board', () => {
    const { store } = testStore({ href: 'http://localhost/?view=rules' })
    assert.equal(store.getState().view.scrollAsk, null, 'an address opened on a page asks for nothing')
    const asked = () => store.getState().view.scrollAsk
    store.getState().goToPage('requests')
    assert.deepEqual(asked(), { sequence: 1, target: { to: 'top' } }, 'Requests is a page of its own (design pass Phase 5)')
    store.getState().goToPage('focus')
    assert.deepEqual(asked(), { sequence: 2, target: { to: 'element', elementId: 'focus-areas' } })
    store.getState().goToFocus('fa-sync')
    assert.deepEqual(asked(), { sequence: 3, target: { to: 'top' } })
    store.getState().goToPage('review-stack')
    assert.deepEqual(asked(), { sequence: 4, target: { to: 'top' } })
    store.getState().goToPage('review-stack')
    assert.deepEqual(asked(), { sequence: 5, target: { to: 'top' } }, 'pressing the place shown again is a new ask: back to its top')
    store.getState().openRequestDrawer(LOCAL_MODEL.requests[0])
    store.getState().closeRequestDrawer()
    assert.equal(asked()?.sequence, 5, 'the drawer opens over the page without scrolling it')
  })

  it('Back and Forward restore the place and where the person left it scrolled', () => {
    const { store, urls, back } = testStore({ href: 'http://localhost/?view=requests' })
    store.getState().goToPage('rules')
    assert.equal(urls.at(-1)?.href, 'http://localhost/?view=rules')
    back('http://localhost/?view=requests', 1840)
    assert.deepEqual([store.getState().view.section, store.getState().view.scrollAsk?.target], ['requests', { to: 'position', y: 1840 }])
    back('http://localhost/?view=rules', 320)
    assert.deepEqual([store.getState().view.section, store.getState().view.scrollAsk?.target], ['rules', { to: 'position', y: 320 }], 'Forward')
    assert.equal(urls.length, 1, 'Back and Forward write no address of their own')
    // An entry with no known position (a link to #main-content made it) leaves the window where it is.
    const before = store.getState().view.scrollAsk
    back('http://localhost/?view=rules#main-content', null)
    assert.equal(store.getState().view.scrollAsk, before)
  })

  it('a reload opens where the person left that entry scrolled, before the page\'s own board', () => {
    assert.deepEqual(testStore({ href: 'http://localhost/?view=requests', scrolledTo: 2400 }).store.getState().view.scrollAsk, { sequence: 1, target: { to: 'position', y: 2400 } })
    assert.deepEqual(testStore({ href: 'http://localhost/?view=rules', scrolledTo: 0 }).store.getState().view.scrollAsk, { sequence: 1, target: { to: 'position', y: 0 } })
    assert.deepEqual(testStore({ href: 'http://localhost/?view=focus' }).store.getState().view.scrollAsk?.target, { to: 'element', elementId: 'focus-areas' }, 'a first visit opens at the board')
    assert.equal(testStore({ href: 'http://localhost/?view=requests' }).store.getState().view.scrollAsk, null, 'Requests opens at its top')
  })

  it('opening a request keeps the page it opens over; closing it goes back to that page\'s address', () => {
    const { store, urls } = testStore({ href: 'http://localhost/?view=requests' })
    const [first] = LOCAL_MODEL.requests
    store.getState().openRequestDrawer(first)
    assert.equal(urls.at(-1)?.href, `http://localhost/?view=requests&request=${first.id}`)
    store.getState().closeRequestDrawer()
    assert.equal(urls.at(-1)?.href, 'http://localhost/?view=requests')
    assert.equal(store.getState().view.section, 'requests')
  })

  it('an area address the work does not show (dismissed, or not in it) becomes the home page\'s address once the work is read', async () => {
    const dismissed = { ...LOCAL_MODEL.focusAreas[0], status: 'dismissed' as const, mergedInto: null }
    const model: WorkModel = { ...LOCAL_MODEL, focusAreas: [dismissed, ...LOCAL_MODEL.focusAreas.slice(1)] }
    for (const focus of [dismissed.id, 'fa-not-in-the-work']) {
      const { store, urls } = testStore({ href: `http://localhost/?source=sample&focus=${focus}` })
      const { source, reads } = fakeSource()
      store.getState().startWorkSource(source)
      assert.equal(store.getState().view.focusChoice, focus, 'kept while the work is read')
      reads[0].resolve(model)
      await settle()
      assert.deepEqual([store.getState().view.focusChoice, urls.at(-1)], [null, { href: 'http://localhost/?source=sample', replace: true }], focus)
      assert.equal(activePlace(store.getState().view), 'work', 'the bar marks the page shown')
    }
    // An area the work shows keeps its address.
    const { store, urls } = testStore({ href: `http://localhost/?focus=${LOCAL_MODEL.focusAreas[1].id}` })
    const { source, reads } = fakeSource()
    store.getState().startWorkSource(source)
    reads[0].resolve(model)
    await settle()
    assert.deepEqual([store.getState().view.focusChoice, urls], [LOCAL_MODEL.focusAreas[1].id, []])
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
  /** The screen these saves are made from (the place useFocusChanges gives a real screen). */
  const TEST_PLACE = 'test-screen'
  const applyHere = (store: ReturnType<typeof testStore>['store'], change: FocusChange, record: FocusChangeRecord | null) =>
    store.getState().applyFocusChange(change, record, { words: record ?? { text: change.action, undo: null }, place: TEST_PLACE })

  it('keeps a later focus edit when Undo refers to an older saved version', async () => {
    const { store } = testStore()
    const area = LOCAL_MODEL.focusAreas[0]
    const saved = { ...LOCAL_MODEL, focusAreas: [{ ...area, name: 'Saved name' }] }
    const sent: string[] = []
    const { source, feed } = fakeSource({ saveFocusChange: async change => { sent.push(change.action); return saved } })
    const stop = store.getState().startWorkSource(source)
    try {
      feed.onModel({ ...LOCAL_MODEL, focusAreas: [area] })
      await applyHere(store, { action: 'rename', focusAreaId: area.id, name: 'Saved name' }, {
        text: 'Renamed', undo: [{ action: 'rename', focusAreaId: area.id, name: area.name }],
      })
      feed.onModel({ ...saved, focusAreas: [{ ...area, name: 'Newer edit from another tab' }] })
      assert.equal(await store.getState().undoLastFocusChange(TEST_PLACE), false)
      assert.deepEqual(sent, ['rename'])
      assert.match(store.getState().focus.failed?.reason ?? '', /changed since your edit/)
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
      await applyHere(store, { action: 'move-request', requestId: request.id, focusAreaId: 'area-b' }, {
        text: 'Moved', undo: [{ action: 'move-request', requestId: request.id, focusAreaId: 'area-a' }],
      })
      feed.onModel({ ...saved, requests: [{ ...request, focusAreaId: 'area-c' }] })
      assert.equal(await store.getState().undoLastFocusChange(TEST_PLACE), false)
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
      await applyHere(store, { action: 'reorder', focusAreaIds: [area.id] }, {
        text: 'Reordered', undo: [{ action: 'reorder', focusAreaIds: [area.id] }],
      })
      feed.onModel({ ...saved, focusAreas: [area, { ...area, id: 'new-area' }] })
      assert.equal(await store.getState().undoLastFocusChange(TEST_PLACE), false)
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
    const first = applyHere(store, { action: 'keep', focusAreaId: area.id }, { text: 'Kept A', undo: [{ action: 'restore-suggestion', focusAreaId: area.id }] })
    assert.equal(await applyHere(store, { action: 'dismiss', focusAreaId: area.id }, null), false)
    gate.resolve(LOCAL_MODEL)
    assert.equal(await first, true)
    assert.equal(store.getState().focus.history.at(-1)?.text, 'Kept A')
    assert.equal(await store.getState().undoLastFocusChange(TEST_PLACE), true)
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
      await applyHere(store, { action: 'merge', focusAreaId: area.id, intoFocusAreaId: 'target' }, {
        text: 'Merged', undo: [{ action: 'restore-suggestion', focusAreaId: area.id }, { action: 'keep', focusAreaId: area.id }],
      })
      feed.onModel({ ...merged, focusAreas: [{ ...merged.focusAreas[0], latestAt: 'Now', timesAsked: 100 }, { ...area, id: 'unrelated', name: 'Another area' }] })
      assert.equal(await store.getState().undoLastFocusChange(TEST_PLACE), false)
      assert.deepEqual(sent, ['merge', 'restore-suggestion', 'keep'])
      assert.equal(await store.getState().undoLastFocusChange(TEST_PLACE), true)
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
      await applyHere(store, { action: 'merge', focusAreaId: area.id, intoFocusAreaId: 'target' }, {
        text: 'Merged', undo: [{ action: 'restore-suggestion', focusAreaId: area.id }, { action: 'keep', focusAreaId: area.id }],
      })
      const undo = store.getState().undoLastFocusChange(TEST_PLACE)
      feed.onModel(newer)
      gate.resolve(restored)
      assert.equal(await undo, false)
      assert.deepEqual(sent, ['merge', 'restore-suggestion'])
      assert.match(store.getState().focus.failed?.reason ?? '', /changed since your edit/)
    } finally { stop() }
  })

  // Phase 6 fix Q-M1: one record of the failed save, with what it was, its words and the screen that made it.
  it('keeps the save that failed with its words and the screen that made it; only that screen forgets it, and the next save replaces it', async () => {
    const { store } = testStore()
    const area = LOCAL_MODEL.focusAreas[0]
    const sent: string[] = []
    const { source, feed } = fakeSource({ saveFocusChange: async change => {
      sent.push(change.action)
      if (sent.length === 1) throw new Error('SQLITE_BUSY: database is locked')
      return LOCAL_MODEL
    } })
    const stop = store.getState().startWorkSource(source)
    try {
      feed.onModel(LOCAL_MODEL)
      const done: FocusChange = { action: 'done', focusAreaId: area.id }
      const words = { text: `Marked “${area.name}” done`, undo: [{ action: 'keep' as const, focusAreaId: area.id }] }
      assert.equal(await store.getState().applyFocusChange(done, words, { words, place: 'focus:a' }), false)
      assert.deepEqual(store.getState().focus.failed, { attempt: { kind: 'change', change: done, record: words }, words, place: 'focus:a', reason: 'SQLITE_BUSY: database is locked' })
      assert.equal(store.getState().focus.history.length, 0)
      // Another screen cannot forget it; its own can.
      store.getState().forgetFailedFocusSave('focus:b')
      assert.equal(store.getState().focus.failed?.place, 'focus:a')
      store.getState().forgetFailedFocusSave('focus:a')
      assert.equal(store.getState().focus.failed, null)
      // A save that works leaves no failure; the history keeps its note.
      assert.equal(await store.getState().applyFocusChange(done, words, { words, place: 'focus:a' }), true)
      assert.equal(store.getState().focus.failed, null)
      assert.deepEqual(sent, ['done', 'done'])
      assert.equal(store.getState().focus.history.at(-1)?.text, words.text)
    } finally { stop() }
  })
})
