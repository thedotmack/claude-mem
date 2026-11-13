// The active source's model: fixtures in sample mode, real records otherwise (spec §12). Every page reads it from
// here; live requests change only through their data source, never in the browser.
import { SAMPLE_REQUESTS, SaveRefusedError, assertConsistentRequest, type Request } from '../../data.ts'
import { keptSentAnswers } from '../../live/answer-line.ts'
import { freshlyUpdatedRequestIds, mergeRecentChanges, requestChanges } from '../../live/update-queue.ts'
import type { OwnerRunStart, WorkDataSource, WorkModel } from '../../live/work-data-source.ts'
import type { SliceCreator } from '../create-store.ts'
import type { WorkSlice } from '../store-types.ts'

/** How long a changed request's card shows "Just updated". */
const FRESHLY_UPDATED_FOR_MS = 4000
/** The sample demo: the wireframe agent finishes this long after the page opens, so the status flip can be seen. */
const SAMPLE_DEMO_FLIP_AFTER_MS = 7000

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

export const createWorkSlice: SliceCreator<WorkSlice> = (set, get) => {
  let source: WorkDataSource | null = null
  /** Each start opens a new session; a stopped session's feed, reads and saves can no longer change the screen. */
  let session = 0
  /** Counts shown models, so a read can tell a newer live model arrived while it was in flight. */
  let modelsShown = 0
  let freshTimer: ReturnType<typeof setTimeout> | undefined

  /** Clicks whose start is still on its way to the worker, so a double click sends one. */
  const ownerRunsStarting = new Set<string>()
  const clickToken = () => globalThis.crypto.randomUUID()

  /** Sends one click to the source: at most one request per `key` at a time, each with its own token. */
  const startOwnerRun = async (key: string, what: string, start: (source: WorkDataSource, token: string) => Promise<OwnerRunStart> | undefined): Promise<OwnerRunStart> => {
    const startOn = activeSource(what)
    if (ownerRunsStarting.has(key)) return { outcome: 'duplicate' }
    ownerRunsStarting.add(key)
    try {
      const started = start(startOn, clickToken())
      if (!started) return { outcome: 'refused', reason: 'This viewer cannot do that here.' }
      return await started
    } finally { ownerRunsStarting.delete(key) }
  }

  /** Keeps `work.focusPlan` on the plan the model says is ready: read once per plan, dropped when the model has none ready. */
  let planReading: string | null = null
  const followFocusPlan = (model: WorkModel) => {
    const summary = model.focusPlan
    const readyAt = summary?.state === 'ready' ? summary.generatedAt : null
    const shown = get().work.focusPlan
    if (!readyAt) { if (shown) set((state) => { state.work.focusPlan = null }); return }
    if (shown?.generatedAt === readyAt || planReading === readyAt || !source?.loadFocusPlan) return
    planReading = readyAt
    const thisSession = session
    void source.loadFocusPlan().then((plan) => {
      if (session !== thisSession || plan?.state !== 'ready') return
      // The model can move on while the plan is read: only the plan it names as ready now is shown.
      const load = get().work.load
      const current = load.state === 'loaded' ? load.model.focusPlan : null
      if (current?.state !== 'ready' || current.generatedAt !== plan.generatedAt) return
      set((state) => { state.work.focusPlan = plan })
    }).catch(() => { /* The summary still shows the plan is ready; the next model tries the read again. */ })
      .finally(() => { if (planReading === readyAt) planReading = null })
  }

  const showModel = (model: WorkModel) => {
    const previous = get().work.load
    const changedIds = previous.state === 'loaded' ? new Set(freshlyUpdatedRequestIds(previous.model.requests, model.requests)) : new Set<string>()
    const changes = previous.state === 'loaded' ? requestChanges(previous.model.requests, model.requests, Date.now()) : []
    // A state move is an update too, even where the source carries no fingerprint (the sample).
    for (const change of changes) changedIds.add(change.requestId)
    modelsShown++
    set((state) => {
      state.work.load = { state: 'loaded', model }
      state.work.connection = model.connection
      if (changedIds.size > 0) state.work.freshlyUpdatedIds = changedIds
      // A change whose request left the model (grouped into an overall request, or removed) would open nothing.
      const present = new Set(model.requests.map((request) => request.id))
      const kept = mergeRecentChanges(state.work.recentChanges, changes).filter((change) => present.has(change.requestId))
      if (kept.length !== state.work.recentChanges.length || changes.length > 0) state.work.recentChanges = kept
      state.work.sentAnswers = keptSentAnswers(state.work.sentAnswers, model.requests)
    })
    if (changedIds.size > 0) {
      clearTimeout(freshTimer)
      freshTimer = setTimeout(() => set((state) => { state.work.freshlyUpdatedIds = new Set() }), FRESHLY_UPDATED_FOR_MS)
    }
    get().reconcileOpenRequest()
    followFocusPlan(model)
  }

  const activeSource = (what: string) => {
    if (!source) throw new Error(`No data source to ${what}`)
    return source
  }

  /** Reads the model. A live model that arrived during the read is newer and wins; a failure never replaces shown work. */
  const read = async () => {
    const reading = activeSource('read work from')
    const thisSession = session
    const shownBefore = modelsShown
    try {
      const model = await reading.loadWorkModel()
      if (session === thisSession && modelsShown === shownBefore) showModel(model)
    } catch (error) {
      if (session !== thisSession || get().work.load.state === 'loaded') return
      set((state) => { state.work.load = { state: 'failed', error: messageOf(error) } })
    }
  }

  /**
   * Shows what a confirmed save answered. When a live model arrived while the save was in flight, that answer may be
   * older than the screen, so the current model is read instead. A failed read leaves the save standing and says so.
   */
  const showSaved = async (saved: WorkModel, shownBeforeSave: number) => {
    if (modelsShown === shownBeforeSave) {
      showModel(saved)
      set((state) => { state.work.refreshError = null })
      return
    }
    const thisSession = session
    const shownBeforeRead = modelsShown
    try {
      const model = await activeSource('read work from').loadWorkModel()
      if (session !== thisSession) return
      if (modelsShown === shownBeforeRead) showModel(model)
      set((state) => { state.work.refreshError = null })
    } catch (error) {
      if (session !== thisSession) return
      set((state) => { state.work.refreshError = `Saved. Reading the latest work after it failed: ${messageOf(error)}` })
    }
  }

  /** Runs one save through the active source. A refusal that carries the worker's snapshot shows it, then rethrows. */
  const saving = async <T>(what: string, save: (source: WorkDataSource) => Promise<T>, savedModel: (result: T) => WorkModel | null): Promise<T> => {
    const saveTo = activeSource(what)
    const thisSession = session
    const shownBefore = modelsShown
    let result: T
    try {
      result = await save(saveTo)
    } catch (error) {
      if (error instanceof SaveRefusedError && session === thisSession) showModel(error.model)
      throw error
    }
    const model = savedModel(result)
    if (model && session === thisSession) await showSaved(model, shownBefore)
    return result
  }

  return {
    work: { load: { state: 'loading' }, connection: null, freshlyUpdatedIds: new Set(), recentChanges: [], sourceKind: null, refreshError: null, focusPlan: null, sentAnswers: {} },

    startWorkSource: (nextSource) => {
      const thisSession = ++session
      source = nextSource
      set((state) => { state.work.sourceKind = nextSource.sourceKind })
      const current = () => session === thisSession
      const unsubscribe = nextSource.subscribeToLiveUpdates(
        (model) => { if (current()) get().receiveWorkModel(model) },
        (connection) => { if (current()) get().receiveConnection(connection) },
      )
      void read()
      return () => {
        unsubscribe()
        if (!current()) return
        session++
        clearTimeout(freshTimer)
      }
    },

    retryWorkRead: async () => {
      if (get().work.load.state === 'failed') set((state) => { state.work.load = { state: 'loading' } })
      await read()
    },

    loadRequestDetail: (request, options) => {
      const reading = activeSource('read request detail from')
      if (request.detailLoaded !== false || !reading.loadRequestDetail) return Promise.resolve(request)
      return reading.loadRequestDetail(request.id, request.detailRevision ?? request.contentFingerprint, options)
    },

    receiveWorkModel: showModel,

    // A heartbeat that changes nothing re-renders nothing.
    receiveConnection: (connection) => {
      const shown = get().work.connection
      const sameSync = shown?.sync?.state === connection.sync?.state && shown?.sync?.label === connection.sync?.label
        && shown?.sync?.detail === connection.sync?.detail && shown?.sync?.tone === connection.sync?.tone
      if (shown && sameSync && shown.state === connection.state && shown.label === connection.label && shown.detail === connection.detail && shown.tooltip === connection.tooltip) return
      set((state) => { state.work.connection = connection })
    },

    setRequestChecked: (requestId, checked, expectedFingerprint, expectedReviewHash) =>
      // Sample fixtures carry no fingerprint and the sample source ignores it; the local source refuses an empty one.
      saving('save the check to', (to) => to.setRequestChecked(requestId, expectedFingerprint ?? '', checked, expectedReviewHash), (result) => 'model' in result ? result.model : null),

    answerRequestSuggestion: (suggestion, action) => saving('answer the suggestion in', (to) => {
      if (!to.answerRequestSuggestion) throw new Error('Request suggestions are unavailable in this viewer.')
      return to.answerRequestSuggestion(suggestion, action)
    }, (result) => result.model),

    saveRuleChange: (change) => saving('save the rule change to', (to) => to.saveRuleChange(change), (result) => result.model),

    saveFocusChange: (change) => saving('save the focus change to', (to) => to.saveFocusChange(change), (model) => model),

    markAgentFinished: async (agentId) => { await saving('save the agent to', (to) => to.markAgentFinished(agentId), (model) => model) },

    loadRulesInClaudeCode: async () => { await saving('load the rules from', (to) => to.loadRulesInClaudeCode(), (model) => model) },

    refreshWork: () => activeSource('start a refresh on').refreshWork(),

    answerRequest: async (requestId, text) => {
      const started = await startOwnerRun(`answer:${requestId}`, 'send the answer through', (to, token) => to.answerRequest?.(requestId, text, token))
      if (started.outcome === 'started') set((state) => { state.work.sentAnswers = { ...state.work.sentAnswers, [requestId]: text } })
      return started
    },

    generateStage: (requestId, formatId) => startOwnerRun(`stage:${requestId}:${formatId}`, 'make the stage on', (to, token) => to.generateStage?.(requestId, formatId, token)),

    setAutoStageFormat: async (formatId) => {
      await saving('save the automatic stage setting to', (to) => {
        if (!to.setAutoStageFormat) throw new Error('Automatic stages are unavailable in this viewer.')
        return to.setAutoStageFormat(formatId)
      }, (model) => model)
    },

    planFocus: (focusAreaId) => startOwnerRun('plan', 'plan focus areas on', (to, token) => to.planFocus?.(focusAreaId, token)),

    setFocusIcon: async (focusAreaId, upload) => {
      await saving('save the icon to', (to) => {
        if (!to.setFocusIcon) throw new Error('Focus icons are unavailable in this viewer.')
        return to.setFocusIcon(focusAreaId, upload)
      }, (model) => model)
    },

    generateFocusIcon: (focusAreaId, direction) => startOwnerRun(`icon:${focusAreaId}`, 'generate the icon on', (to, token) => to.generateFocusIcon?.(focusAreaId, token, direction)),

    updateSampleRequest: (id, change) => {
      const load = get().work.load
      if (load.state !== 'loaded') throw new Error(`Sample request ${id} changed before the work model loaded`)
      if (load.model.sourceKind !== 'sample') throw new Error(`updateSampleRequest edits sample data only; ${load.model.sourceKind} requests change through their data source`)
      const index = SAMPLE_REQUESTS.findIndex((request) => request.id === id)
      if (index < 0) throw new Error(`No request ${id}`)
      SAMPLE_REQUESTS[index] = assertConsistentRequest(change(SAMPLE_REQUESTS[index]))
      showModel({ ...load.model, requests: [...SAMPLE_REQUESTS] })
    },

    /**
     * Wireframe demo, sample mode only: the wireframe agent finishes while you watch, so the status flip can be seen.
     * Every field moves together: last task done, 100% reviewed, Reviewing, and the next move is yours.
     */
    playSampleDemo: () => {
      const timer = setTimeout(() => get().updateSampleRequest('r1', (request: Request) => ({
        ...request,
        state: 'needs-check', stage: 'Reviewing',
        progress: { ...request.progress, percent: 100, readings: 4, reviewedAt: '2:04 pm', history: [30, 55, 70, 100] },
        estimate: null,
        next: { who: 'human', need: 'review', text: 'Check the wireframe against the spec' },
        workstreams: request.workstreams.map((stream) => ({ ...stream, tasks: stream.tasks.map((task) => ({ ...task, done: true })) })),
        granular: [{ kind: 'work', text: 'Wireframe: My Rules screens done', at: '2:03 pm' }, ...request.granular],
        story: request.story.map((step) => ({ ...step, status: 'complete' })),
       
      })), SAMPLE_DEMO_FLIP_AFTER_MS)
      return () => clearTimeout(timer)
    },
  }
}
