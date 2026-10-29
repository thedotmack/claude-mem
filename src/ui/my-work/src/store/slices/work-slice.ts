// The active source's model: fixtures in sample mode, real records otherwise (spec §12). Every page reads it from
// here; live requests change only through their data source, never in the browser.
import { SAMPLE_REQUESTS, SaveRefusedError, assertConsistentRequest, type Request } from '../../data.ts'
import { freshlyUpdatedRequestIds } from '../../live/update-queue.ts'
import type { WorkDataSource, WorkModel } from '../../live/work-data-source.ts'
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

  const showModel = (model: WorkModel) => {
    const previous = get().work.load
    const changedIds = previous.state === 'loaded' ? new Set(freshlyUpdatedRequestIds(previous.model.requests, model.requests)) : new Set<string>()
    modelsShown++
    set((state) => {
      state.work.load = { state: 'loaded', model }
      state.work.connection = model.connection
      if (changedIds.size > 0) state.work.freshlyUpdatedIds = changedIds
    })
    if (changedIds.size > 0) {
      clearTimeout(freshTimer)
      freshTimer = setTimeout(() => set((state) => { state.work.freshlyUpdatedIds = new Set() }), FRESHLY_UPDATED_FOR_MS)
    }
    get().reconcileOpenRequest()
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
    work: { load: { state: 'loading' }, connection: null, freshlyUpdatedIds: new Set(), sourceKind: null, refreshError: null },

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

    receiveWorkModel: showModel,

    // A heartbeat that changes nothing re-renders nothing.
    receiveConnection: (connection) => {
      const shown = get().work.connection
      if (shown && shown.state === connection.state && shown.label === connection.label && shown.detail === connection.detail && shown.tooltip === connection.tooltip) return
      set((state) => { state.work.connection = connection })
    },

    setRequestChecked: (requestId, checked, expectedFingerprint) =>
      // Sample fixtures carry no fingerprint and the sample source ignores it; the local source refuses an empty one.
      saving('save the check to', (to) => to.setRequestChecked(requestId, expectedFingerprint ?? '', checked), (result) => 'model' in result ? result.model : null),

    saveRuleChange: (change) => saving('save the rule change to', (to) => to.saveRuleChange(change), (result) => result.model),

    saveFocusChange: (change) => saving('save the focus change to', (to) => to.saveFocusChange(change), (model) => model),

    markAgentFinished: async (agentId) => { await saving('save the agent to', (to) => to.markAgentFinished(agentId), (model) => model) },

    loadRulesInClaudeCode: async () => { await saving('load the rules from', (to) => to.loadRulesInClaudeCode(), (model) => model) },

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
        next: { who: 'human', text: 'Check the wireframe against the spec' },
        workstreams: request.workstreams.map((stream) => ({ ...stream, tasks: stream.tasks.map((task) => ({ ...task, done: true })) })),
        granular: [{ kind: 'work', text: 'Wireframe: My Rules screens done', at: '2:03 pm' }, ...request.granular],
        story: request.story.map((step) => ({ ...step, status: 'complete' })),
        activityWord: '',
      })), SAMPLE_DEMO_FLIP_AFTER_MS)
      return () => clearTimeout(timer)
    },
  }
}
