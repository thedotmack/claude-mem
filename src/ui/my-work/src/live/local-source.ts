// The claude-mem worker on this computer (localhost:37777). In Vite dev the /api proxy reaches it; served by the
// worker, /api is the same origin. Initial load joins the compact event stream; a bounded HTTP fallback handles
// workers without that stream. Complete request evidence is fetched only when its drawer opens.
// The cloud viewer (claude-mem services/viewer-host) serves this same page from a worker that pulls the owner's
// synced devices, behind a sign-in gate: same API, same origin. Off loopback the source says 'cloud', so the
// page names where its work comes from and where a change is saved.
// The live wiring copies claude-mem v15.0.1 plugin/ui/work-view/app.js:180-261 (`accept`, `refresh`, the
// EventSource handlers, the 1s connection timer and the 60s aging timer). The check copies app.js:125-138 (`saveReview`).
import { notifySharedViewer, sharedViewerOwner } from './shared-viewer-session.ts'
import { ruleVersion } from './rule-actions.ts'
import { getConnectionStatus, type ConnectionStatus } from './connection-status.ts'
import { browserHostname, browserVisibility, isServedFromCloud, type PageVisibility } from './served-from.ts'
import { conflictReason, readReviewResponse, readSaveReceipt, type ReviewResult } from './review-response.ts'
import { toWorkModel } from './to-work-model.ts'
import type { ConversationContinuationEvent, MappedWorkModel, RuleSaveResult, WorkDataSource, WorkModel } from './work-data-source.ts'
import { applySseFrame } from './parse-sse-frame.ts'
import {
  conversationRouteFailureSentence, readConversationContinuationAnswer, readConversationContinuationNotice, readConversationExchangeAnswer,
  readOpenedInAppAnswer, unreachableWorkerSentence, unreadableAnswerSentence,
} from './conversation-continuation.ts'
import { RefreshNotStartedError, SaveRefusedError } from '../data.ts'
import type { Request as WorkRequest } from '../data.ts'
import type { WorkViewSnapshot, WorkViewSource } from './work-view-api-types.ts'
import { expandWorkViewOverview, type WorkViewOverview, type WorkViewOverviewModel, type WorkViewRequestDetail } from './work-view-overview.ts'
import { mergeRequestDetail } from './request-detail-state.ts'
import { isSyncStatus, type SyncStatusForDisplay } from '../../../viewer/utils/sync-presentation.ts'
import { startViewerActivity, type ViewerActivityOptions } from '../../../viewer/utils/viewer-activity.ts'

export interface LocalSourceOptions {
  hostname?: string
  sharedOwner?: string
  fetchImpl?: typeof fetch
  eventSourceFactory?: (url: string) => EventSource
  bootstrapTimeoutMs?: number
  requestTimeoutMs?: number
  activityOptions?: Omit<ViewerActivityOptions, 'fetchImpl' | 'enabled'>
  /** Whether the tab is on screen (default `document`). Only a cloud page reads it; see subscribeToLiveUpdates. */
  visibility?: PageVisibility
  /** Where the browser says the page is being unloaded, with 'pagehide' (default `window`). See openConversationInApp. */
  pageUnload?: PageUnload
}

/** What fires 'pagehide' as this page is unloaded: a reload, a closed tab, or a navigation away. */
export interface PageUnload {
  addEventListener(type: 'pagehide', listener: () => void): void
  removeEventListener(type: 'pagehide', listener: () => void): void
}

/** This page's `window`; undefined outside a browser. */
const browserWindow = () => (globalThis as { window?: PageUnload }).window

/** Separate instances make the actual transport/race behavior testable without shared browser globals. */
export function createLocalSource(options: LocalSourceOptions = {}): WorkDataSource {
  // Looked up per call, not captured here: this module builds `localSource` as it loads, and
  // the local API token wrapper (install-local-api-token) replaces `window.fetch` around then.
  const fetchImpl = options.fetchImpl ?? (((input, init) => fetch(input, init)) as typeof fetch)
  const createEventSource = options.eventSourceFactory ?? ((url: string) => new EventSource(url))
  const bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 10_000
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000

  const WORK_VIEW_URL = '/api/work-view'
  const WORK_VIEW_OVERVIEW_URL = '/api/work-view/overview'
  const WORK_VIEW_EVENTS_URL = '/api/work-view/events'
  const WORK_VIEW_REVIEW_URL = '/api/work-view/review'
  const WORK_VIEW_SUGGESTIONS_URL = '/api/work-view/suggestions'
  const WORK_VIEW_RULES_URL = '/api/work-view/rules'
  const WORK_VIEW_FOCUS_URL = '/api/work-view/focus'
  const WORK_VIEW_LOAD_RULES_URL = '/api/work-view/rules/load-in-claude-code'
  const WORK_VIEW_REFRESH_URL = '/api/work-view/refresh'
  const WORK_VIEW_MARK_AGENT_FINISHED_URL = '/api/work-view/agents/mark-finished'
  const WORK_VIEW_CONVERSATION_CONTINUATION_URL = '/api/work-view/conversations/continuation'
  const WORK_VIEW_CONTINUE_CONVERSATION_URL = '/api/work-view/conversations/continue'
  const WORK_VIEW_STOP_CONVERSATION_CONTINUATION_URL = '/api/work-view/conversations/stop'
  const WORK_VIEW_OPEN_CONVERSATION_IN_APP_URL = '/api/work-view/conversations/open-in-app'
  const WORK_VIEW_STOP_OPENING_CONVERSATION_IN_APP_URL = '/api/work-view/conversations/open-in-app/stop'
  const CONTENT_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
  const CONNECTION_TICK_MS = 1000
  const sharedOwner = options.sharedOwner ?? sharedViewerOwner()
  const SOURCE_KIND = sharedOwner || isServedFromCloud(options.hostname ?? browserHostname() ?? 'localhost') ? 'cloud' : 'local'
  const AGING_TICK_MS = 60_000
  const STALE_FALLBACK_INTERVAL_MS = 120_000
  /** The worker's SSE `retry: 1000`. */
  const STREAM_REOPEN_AFTER_MS = 1000
  // A cloud viewer's machine sleeps only while nothing reaches it, so a hidden cloud tab holds no stream and makes no
  // timed request. The page on this computer never reads visibility: its behaviour does not change.
  const visibility = SOURCE_KIND === 'cloud' ? options.visibility ?? browserVisibility() : undefined
  const pageHidden = () => visibility?.visibilityState === 'hidden'
  const pageUnload = options.pageUnload ?? browserWindow()

  /** The evidence getConnectionStatus reads. Times are performance.now(); see connection-status.ts. */
  const connectionEvidence = {
    transportConnected: false,
    reconnecting: false,
    lastEventAt: null as number | null,
    sourceConnected: null as boolean | null,
    lastSuccessfulCheckAt: null as string | null,
    lastSuccessfulCheckReceivedAt: null as number | null,
    sync: null as SyncStatusForDisplay | null,
    syncReceivedAt: null as number | null,
    activityCheckedAt: null as string | null,
    activityAgeAtReceipt: null as number | null,
    activityReceivedAt: null as number | null,
  }
  /** The newest snapshot accepted, kept so the aging timer can re-map it as time passes. */
  let latestSnapshot: WorkViewSnapshot | null = null
  let latestModel: MappedWorkModel | null = null
  let latestOverviewSignature: string | null = null
  let latestCloudRevision: string | null = null
  let legacyMode = false
  // All accepted models count, including HTTP reads and saves: an older response must not rewind either.
  let modelVersion = 0
  let syncVersion = 0
  let streamGeneration = 0
  let detailSelection = 0
  let lastOverviewReadAt = -Infinity
  let firstEvent: { promise: Promise<WorkModel | null>; resolve: (model: WorkModel | null) => void } | null = null
  let initialRead: Promise<WorkModel> | null = null
  let publishModel: ((model: WorkModel) => void) | null = null
  const activeReads = new Set<AbortController>()
  const detailCache = new Map<string, { fingerprint: string; request: WorkRequest }>()
  const MAX_CACHED_DETAILS = 8
  /** The content of the last model handed to the screens, so an unchanged snapshot or a quiet minute is not sent again. */
  let lastDeliveredSignature: string | null = null
  // Accepted models are immutable. Connection-only wrappers share their content signature,
  // so bootstrap and publication do not serialize the same request list again.
  const modelSignatures = new WeakMap<object, string>()
  function modelSignature(model: MappedWorkModel | WorkViewOverviewModel): string {
    let signature = modelSignatures.get(model)
    if (signature === undefined) {
      signature = JSON.stringify([model.agents, model.devices, model.people, model.requests, model.requestReadErrors, model.unlinkedWorkCount, model.sourceHealth, model.focusAreas, model.otherAsks, model.currentPeriod, model.pastPeriods, model.goalsReadError, model.lastRuns, model.refresh, model.rules, model.ruleScopes, model.rulesLearning, model.rulesFile, model.rulesReadError, model.buildStory, model.sharedState])
      modelSignatures.set(model, signature)
    }
    return signature
  }

  const currentConnectionStatus = (): ConnectionStatus =>
    getConnectionStatus({ ...connectionEvidence, now: performance.now(), wallNow: Date.now(), where: SOURCE_KIND })

  const withConnection = (mapped: MappedWorkModel): WorkModel => {
    const model: WorkModel = { ...mapped, sourceKind: SOURCE_KIND, connection: currentConnectionStatus() }
    modelSignatures.set(model, modelSignature(mapped))
    return model
  }

  /** app.js `health`: only a payload whose source read succeeded counts as a successful check. */
  function recordSourceHealth(source: WorkViewSource | undefined, serverAt?: string) {
    connectionEvidence.sourceConnected = typeof source?.connected === 'boolean' ? source.connected : null
    if (source?.connected === true && typeof source.lastCheckedAt === 'string' && Number.isFinite(Date.parse(source.lastCheckedAt))) {
      connectionEvidence.lastSuccessfulCheckAt = source.lastCheckedAt
      connectionEvidence.lastSuccessfulCheckReceivedAt = performance.now()
    }
    const inspected = source?.activityCheckedAt ? Date.parse(source.activityCheckedAt) : NaN
    const sampled = Date.parse(serverAt ?? source?.lastCheckedAt ?? '')
    connectionEvidence.activityCheckedAt = Number.isFinite(inspected) ? source!.activityCheckedAt! : null
    connectionEvidence.activityAgeAtReceipt = Number.isFinite(inspected) && Number.isFinite(sampled) && sampled >= inspected ? sampled - inspected : null
    connectionEvidence.activityReceivedAt = connectionEvidence.activityAgeAtReceipt === null ? null : performance.now()
  }

  function recordSync(value: unknown, expectedVersion?: number) {
    if (!isSyncStatus(value)) return
    if (expectedVersion !== undefined && expectedVersion !== syncVersion) return
    if (connectionEvidence.sync && JSON.stringify(value) === JSON.stringify(connectionEvidence.sync)) return
    syncVersion++
    connectionEvidence.sync = value
    connectionEvidence.syncReceivedAt = performance.now()
  }

  /** app.js `accept`: an HTTP read that began before a newer event must not renew or overwrite the feed's health evidence. */
  function acceptSnapshot(snapshot: WorkViewSnapshot, fromEvent: boolean, expectedSyncVersion?: number): WorkModel {
    modelVersion++
    latestSnapshot = snapshot
    latestOverviewSignature = null
    latestModel = toWorkModel(snapshot, Date.now())
    if (sharedOwner || fromEvent || connectionEvidence.lastEventAt === null) recordSourceHealth(snapshot.source, snapshot.generatedAt)
    recordSync(snapshot.sync, expectedSyncVersion)
    return withConnection(latestModel)
  }

  function acceptOverview(overview: WorkViewOverview, fromEvent: boolean, expectedSyncVersion?: number): WorkModel {
    modelVersion++
    latestSnapshot = null
    latestCloudRevision = overview.revision
    if (sharedOwner || fromEvent || connectionEvidence.lastEventAt === null) recordSourceHealth(overview.source, overview.generatedAt)
    recordSync(overview.sync, expectedSyncVersion)
    // A transport revision does not include clock-derived labels. Compare the actual
    // compact content, before allocating the full request shapes and empty detail arrays.
    const signature = `overview:${modelSignature(overview.model)}`
    if (latestModel && signature === latestOverviewSignature) return withConnection(latestModel)
    latestOverviewSignature = signature
    latestModel = expandWorkViewOverview(overview)
    modelSignatures.set(latestModel, signature)
    const live = new Map(latestModel.requests.map((request) => [request.id, request.detailRevision ?? request.contentFingerprint ?? '']))
    for (const [id, cached] of detailCache) if (live.get(id) !== cached.fingerprint) detailCache.delete(id)
    return withConnection(latestModel)
  }

  const isOverview = (value: unknown): value is WorkViewOverview => {
    const overview = value as WorkViewOverview | null
    return !!overview && overview.version === 1 && typeof overview.revision === 'string'
      && ['requests', 'requestReadErrors', 'agents', 'devices', 'people', 'focusAreas', 'otherAsks', 'pastPeriods', 'rules', 'ruleScopes']
        .every((key) => Array.isArray((overview.model as unknown as Record<string, unknown> | undefined)?.[key]))
      && overview.model.requests.every((request) => typeof request?.id === 'string' && request.detailLoaded === false
        && typeof request.contentFingerprint === 'string' && CONTENT_FINGERPRINT_PATTERN.test(request.contentFingerprint))
      && typeof overview.model.sourceHealth?.connected === 'boolean'
      && typeof overview.source?.connected === 'boolean'
  }

  const abortError = () => new DOMException('The request was cancelled.', 'AbortError')

  /** The deadline includes reading JSON, and caller cancellation never leaves a pending network read. */
  async function readJson(url: string, signal?: AbortSignal): Promise<{ response: Response; body: unknown }> {
    const controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason ?? abortError())
    if (signal?.aborted) cancel()
    else signal?.addEventListener('abort', cancel, { once: true })
    activeReads.add(controller)
    const timer = setTimeout(() => controller.abort(new DOMException('The worker took too long to respond.', 'TimeoutError')), requestTimeoutMs)
    try {
      const response = await fetchImpl(url, { cache: 'no-store', signal: controller.signal })
      let body: unknown = null
      try { body = await response.json() } catch (error) { if (controller.signal.aborted) throw error }
      if (controller.signal.aborted) throw controller.signal.reason ?? abortError()
      return { response, body }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      activeReads.delete(controller)
    }
  }

  async function readOverview(signal?: AbortSignal, assertOwnership?: () => void): Promise<WorkModel> {
    const versionBeforeRead = modelVersion
    const syncBeforeRead = syncVersion
    lastOverviewReadAt = performance.now()
    let answer = await readJson(legacyMode ? WORK_VIEW_URL : WORK_VIEW_OVERVIEW_URL, signal)
    assertOwnership?.()
    if (!legacyMode && answer.response.status === 404) {
      legacyMode = true
      answer = await readJson(WORK_VIEW_URL, signal)
      assertOwnership?.()
    }
    if (!answer.response.ok) throw new Error(`The worker answered ${answer.response.status} ${answer.response.statusText}`.trim())
    // A newer accepted event, read or save wins over this response.
    if (modelVersion !== versionBeforeRead && latestModel) return withConnection(latestModel)
    if (isOverview(answer.body)) return acceptOverview(answer.body, false, syncBeforeRead)
    if (isWorkViewSnapshot(answer.body)) return acceptSnapshot(answer.body, false, syncBeforeRead)
    throw new Error('The worker returned an unreadable work view.')
  }

  const isWorkViewSnapshot = (value: unknown): value is WorkViewSnapshot => {
    const snapshot = value as WorkViewSnapshot | null
    return !!snapshot && Array.isArray(snapshot.humanRequests) && typeof snapshot.source?.connected === 'boolean'
  }

  /** POSTs to an origin-guarded work-view route that answers with the snapshot after the change. Anything else throws its reason. */
  function writeHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(sharedOwner && latestCloudRevision ? { 'X-Work-Revision': latestCloudRevision } : {}),
    }
  }

  function modelFromSave(value: unknown, newer: MappedWorkModel | null, syncBeforeSave: number): WorkModel | null {
    if (isOverview(value)) return newer ? withConnection(newer) : acceptOverview(value, false, syncBeforeSave)
    if (isWorkViewSnapshot(value)) return newer ? withConnection(newer) : acceptSnapshot(value, false, syncBeforeSave)
    return null
  }

  async function postForWorkModel(url: string, body: unknown, whatWasSaved: string, keepReceipt = false): Promise<RuleSaveResult> {
    const versionBeforeSave = modelVersion
    const syncBeforeSave = syncVersion
    const generation = streamGeneration
    const response = await fetchImpl(url, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(body) })
    let answer: unknown = null
    try { answer = await response.json() } catch { /* A body that isn't JSON leaves only the status to report. */ }
    const newer = latestModel && (modelVersion !== versionBeforeSave || generation !== streamGeneration) ? latestModel : null
    if (!response.ok) {
      const conflict = answer as { error?: unknown; overview?: unknown; snapshot?: unknown } | null
      const reason = conflict?.error
      const message = `${whatWasSaved} was not saved: ${typeof reason === 'string' ? reason : `the worker answered ${response.status}`}`
      const model = modelFromSave(conflict?.overview ?? conflict?.snapshot, newer, syncBeforeSave)
      if (model) {
        lastDeliveredSignature = modelSignature(model)
        throw new SaveRefusedError(message, model)
      }
      throw new Error(message)
    }
    const model = modelFromSave(answer, newer, syncBeforeSave)
    if (!model) throw new Error(`${whatWasSaved} was saved, but the worker sent back something that is not a work snapshot. Reload to see it.`)
    lastDeliveredSignature = modelSignature(model)
    // Undo needs this write's receipt even if a newer model arrived first.
    let receipt = model
    if (keepReceipt && newer) {
      if (isOverview(answer)) receipt = withConnection(expandWorkViewOverview(answer))
      else if (isWorkViewSnapshot(answer)) receipt = withConnection(toWorkModel(answer, Date.now()))
    }
    const { savedRuleId } = answer as { savedRuleId?: unknown }
    const save = readSaveReceipt(answer)
    return { model: receipt, savedRuleId: typeof savedRuleId === 'string' ? savedRuleId : null, ...(save ? { save } : {}) }
  }

  /** Rows showing a continued conversation (subscribeToConversationContinuations), one entry per subscription. */
  const conversationContinuationListeners = new Set<(event: ConversationContinuationEvent) => void>()
  const reviewStackChanges = new EventTarget()
  const notifyReviewStackChanged = () => reviewStackChanges.dispatchEvent(new Event('change'))
  /**
   * Tells every row, even when one before it throws: a row that missed a 'replied' notice or a reopened stream would
   * show 'Working…' until the stream next reopens. The throw is reported as that listener's own error, so it never reads
   * as an unreadable frame (applySseFrame catches what its callback throws) and never escapes the stream's open handler.
   */
  const tellConversationContinuationListeners = (event: ConversationContinuationEvent) => {
    for (const listener of [...conversationContinuationListeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('[work-view] A conversation-continuation listener threw. The other listeners are still told.', error)
      }
    }
  }
  /**
   * Set once the event stream has opened. A notice sent while the stream was closed is lost, so after every open but the
   * first (the browser reconnecting it, or a new stream), each row showing a continued conversation reads it again.
   */
  let eventStreamHasOpened = false

  /**
   * One call to a conversation route, answered as `readAnswer` reads it. Every failure rejects with one plain sentence
   * the row shows as it is (conversation-continuation.ts). No deadline: giving up on a start would not stop the worker
   * from starting the turn, and the read answers from the worker's memory.
   */
  async function callConversationRoute<Answer>(url: string, init: RequestInit, attemptedAction: string, readAnswer: (body: unknown) => Answer | null): Promise<Answer> {
    let response: Response
    try {
      response = await fetchImpl(url, init)
    } catch (error) {
      throw new Error(unreachableWorkerSentence(attemptedAction, error))
    }
    let body: unknown = null
    try { body = await response.json() } catch { /* Not JSON, such as Express's own error page: the status is worded instead. */ }
    if (!response.ok) throw new Error(conversationRouteFailureSentence(response, body, attemptedAction))
    const answer = readAnswer(body)
    if (answer === null) throw new Error(unreadableAnswerSentence(response.status))
    return answer
  }
  const postToConversationRoute = (body: object): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  // Only the page this computer's worker serves can continue a conversation: a cloud-served page has no CLI here.
  const conversationContinuation: Pick<WorkDataSource, 'loadConversationContinuation' | 'continueConversation' | 'stopConversationContinuation'
    | 'subscribeToConversationContinuations' | 'openConversationInApp'> = SOURCE_KIND !== 'local' ? {} : {
    loadConversationContinuation: (platform, conversationSessionId) => callConversationRoute(
      `${WORK_VIEW_CONVERSATION_CONTINUATION_URL}?${new URLSearchParams({ platform, conversationSessionId })}`,
      { cache: 'no-store' }, 'read this conversation', readConversationContinuationAnswer),
    continueConversation: (platform, conversationSessionId, ownerMessage) => callConversationRoute(WORK_VIEW_CONTINUE_CONVERSATION_URL,
      postToConversationRoute({ platform, conversationSessionId, ownerMessage }), 'send your message', readConversationExchangeAnswer),
    stopConversationContinuation: (platform, conversationSessionId) => callConversationRoute(WORK_VIEW_STOP_CONVERSATION_CONTINUATION_URL,
      postToConversationRoute({ platform, conversationSessionId }), 'stop this turn', readConversationExchangeAnswer),
    subscribeToConversationContinuations(listener) {
      // Wrapped, so one function subscribed twice is two subscriptions, and each unsubscribe ends only its own.
      const subscription = (event: ConversationContinuationEvent) => listener(event)
      conversationContinuationListeners.add(subscription)
      return () => { conversationContinuationListeners.delete(subscription) }
    },
    async openConversationInApp(platform, conversationSessionId) {
      // This click's own id (OPEN_IN_APP_CLICK_ID_PATTERN), sent with the open and with its stop, so the worker stops only
      // the open this click started: not one another tab's click started, and not a newer one.
      const clickedOpen = { platform, conversationSessionId, openInAppClickId: crypto.randomUUID() }
      // The worker cannot see this request go away: Bun's node:http, which serves it, gives a POST whose page has gone no
      // sign at all. So when the page is unloaded while the open still runs (a reload, a closed tab), the page asks the
      // worker to stop the open's command. keepalive lets that request outlive the page.
      const stopTheOpenAsThePageGoes = () => {
        fetchImpl(WORK_VIEW_STOP_OPENING_CONVERSATION_IN_APP_URL, { ...postToConversationRoute(clickedOpen), keepalive: true }).catch((error: unknown) => {
          console.error('[work-view] Could not ask the worker to stop opening a conversation in its app as this page closed.', error)
        })
      }
      pageUnload?.addEventListener('pagehide', stopTheOpenAsThePageGoes)
      try {
        return await callConversationRoute(WORK_VIEW_OPEN_CONVERSATION_IN_APP_URL, postToConversationRoute(clickedOpen),
          'open this conversation in its app', readOpenedInAppAnswer)
      } finally {
        pageUnload?.removeEventListener('pagehide', stopTheOpenAsThePageGoes)
      }
    },
  }

  const localSource: WorkDataSource = {
    sourceKind: SOURCE_KIND,
    ...conversationContinuation,
    subscribeToReviewStackChanges(listener) {
      reviewStackChanges.addEventListener('change', listener)
      return () => reviewStackChanges.removeEventListener('change', listener)
    },

    /** app.js `refresh`: when an SSE snapshot arrived while this read was in flight, the event's newer model wins. */
    async loadWorkModel() {
      if (!initialRead) {
        const waiting = firstEvent
        const generation = streamGeneration
        const pending = (async () => {
          let model: WorkModel | null = null
          if (waiting && !sharedOwner) {
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              model = await Promise.race([waiting.promise, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), bootstrapTimeoutMs) })])
            } finally { clearTimeout(timer) }
            if (generation !== streamGeneration) throw abortError()
            if (firstEvent === waiting) firstEvent = null
          }
          model ??= await readOverview()
          lastDeliveredSignature = modelSignature(model)
          return model
        })().finally(() => { if (initialRead === pending) initialRead = null })
        initialRead = pending
      }
      return initialRead
    },

    async loadRequestDetail(requestId, expectedFingerprint, { signal } = {}) {
      const selection = ++detailSelection
      const generation = streamGeneration
      const assertCurrent = () => {
        if (signal?.aborted || selection !== detailSelection || generation !== streamGeneration) throw abortError()
      }
      assertCurrent()
      const cached = detailCache.get(requestId)
      const summary = latestModel?.requests.find((request) => request.id === requestId)
      if (cached && cached.fingerprint === expectedFingerprint
        && (!latestModel || (summary?.detailRevision ?? summary?.contentFingerprint) === cached.fingerprint)) {
        return summary ? mergeRequestDetail(summary, cached.request) : cached.request
      }
      // Sync identifiers may contain thousands of UTF-8 bytes and URL escaping can triple their size.
      // Cloud stores this exact SHA-256 key alongside the full identifier. Local workers keep their route.
      let detailPath = '/api/work-view/requests/' + encodeURIComponent(requestId)
      if (sharedOwner && detailPath.length > 1024) {
        const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestId)))
        const digest = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
        detailPath = '/api/work-view/requests/by-hash/' + digest
      }
      let fingerprint = expectedFingerprint
      for (let attempt = 0; attempt < 2; attempt++) {
        const versionBeforeRead = modelVersion
        const syncBeforeRead = syncVersion
        const query = new URLSearchParams()
        if (fingerprint) query.set('fingerprint', fingerprint)
        const { response, body } = await readJson(`${detailPath}${query.size ? `?${query}` : ''}`, signal)
        assertCurrent()
        if (response.status === 409 && isOverview((body as { overview?: unknown } | null)?.overview)) {
          const overview = (body as { overview: WorkViewOverview }).overview
          const superseded = latestModel !== null && modelVersion !== versionBeforeRead
          const model = superseded && latestModel
            ? withConnection(latestModel) : acceptOverview(overview, false, syncBeforeRead)
          // Only the selected read may update the feed, and only if no newer model arrived in flight.
          if (!superseded) publishModel?.(model)
          const current = model.requests.find((request) => request.id === requestId)
          if (!current) throw new Error('This request is no longer in your work.')
          fingerprint = current.detailRevision ?? current.contentFingerprint
          continue
        }
        if (response.status === 404) {
          // An older worker's full snapshot already supplies detail. A genuinely removed row is absent after refresh.
          const model = await readOverview(signal, assertCurrent)
          assertCurrent()
          publishModel?.(model)
          const current = model.requests.find((request) => request.id === requestId)
          if (current && current.detailLoaded !== false) return current
          throw new Error('This request is no longer available. Refresh your work and try again.')
        }
        if (!response.ok) throw new Error(`Request detail could not be loaded (${response.status}). Try again.`)
        const detail = body as WorkViewRequestDetail | null
        if (detail?.version !== 1 || detail.request?.id !== requestId || detail.request.detailLoaded === false) {
          throw new Error('The worker returned unreadable request detail.')
        }
        const actualFingerprint = detail.request.detailRevision ?? detail.request.contentFingerprint ?? ''
        const current = latestModel?.requests.find((request) => request.id === requestId)
        if (latestModel && !current) throw new Error('This request is no longer in your work.')
        if ((fingerprint && actualFingerprint !== fingerprint) || (current && (current.detailRevision ?? current.contentFingerprint) !== actualFingerprint)) {
          throw new Error('This request changed while its detail was loading. Try again.')
        }
        assertCurrent()
        detailCache.delete(requestId)
        detailCache.set(requestId, { fingerprint: actualFingerprint, request: detail.request })
        while (detailCache.size > MAX_CACHED_DETAILS) detailCache.delete(detailCache.keys().next().value!)
        return current ? mergeRequestDetail(current, detail.request) : detail.request
      }
      throw new Error('This request changed while its detail was loading. Try again.')
    },

    /**
     * app.js `saveReview`: POST the version on screen. 409 → read the latest model (the worker refused a stale or
     * incomplete version); 200 → the worker's snapshot after the save; 503 → the worker's reason. Anything else throws.
     */
    async setRequestChecked(requestId, expectedFingerprint, checked, expectedReviewHash): Promise<ReviewResult> {
      if (!CONTENT_FINGERPRINT_PATTERN.test(expectedFingerprint)) throw new Error(`Can't check ${requestId}: its recorded version (content fingerprint) is missing`)
      const versionBeforeSave = modelVersion
      const syncBeforeSave = syncVersion
      const generation = streamGeneration
      const response = await fetchImpl(WORK_VIEW_REVIEW_URL, {
        method: 'POST',
        headers: writeHeaders(),
        body: JSON.stringify({ requestId, expectedFingerprint, checked, expectedReviewHash }),
      })
      let body: unknown = null
      try { body = await response.json() } catch { /* A body that isn't JSON leaves only the status to report. */ }
      const answer = readReviewResponse(response.status, body)
      if (answer.kind === 'unavailable') return { outcome: 'unavailable', serverMessage: answer.serverMessage }
      const newer = latestModel && (modelVersion !== versionBeforeSave || generation !== streamGeneration) ? latestModel : null
      if (answer.kind === 'conflict') {
        const latest = modelFromSave(answer.snapshot, newer, syncBeforeSave) ?? await localSource.loadWorkModel()
        const latestFingerprint = latest.requests.find((request) => request.id === requestId)?.contentFingerprint
        return conflictReason(expectedFingerprint, latestFingerprint) === 'refused'
          ? { outcome: 'refused', serverMessage: answer.serverMessage, model: latest }
          : { outcome: 'changed-while-reading', model: latest, serverMessage: answer.serverMessage }
      }
      const model = modelFromSave(answer.snapshot, newer, syncBeforeSave)
      if (!model) throw new Error('The local review was saved, but the worker sent back something that is not a work snapshot. Reload to see it.')
      lastDeliveredSignature = modelSignature(model)
      return { outcome: 'saved', model, ...(answer.save ? { save: answer.save } : {}) }
    },

    async answerRequestSuggestion(suggestion, action) {
      const { model, save } = await postForWorkModel(WORK_VIEW_SUGGESTIONS_URL, {
        conversationKey: suggestion.conversationKey, action, expectedSuggestionHash: suggestion.expectedSuggestionHash,
      }, 'The suggestion decision')
      return { model, ...(save ? { save } : {}) }
    },

    async saveRuleChange({ expectedRuleVersion, ...change }) {
      // A sync may update the transport revision while an old draft is still open.
      if (expectedRuleVersion !== undefined && (!expectedRuleVersion ||
        expectedRuleVersion !== ruleVersion(latestModel?.rules.find(rule => rule.id === change.ruleId)))) {
        throw new Error('This rule changed while you were editing. Reopen it to review the latest version.')
      }
      return postForWorkModel(WORK_VIEW_RULES_URL, change, 'The rule change')
    },
    saveFocusChange: async (change) => (await postForWorkModel(WORK_VIEW_FOCUS_URL, change, 'The focus change', true)).model,
    loadRulesInClaudeCode: async () => (await postForWorkModel(WORK_VIEW_LOAD_RULES_URL, {}, 'Loading your rules into Claude Code')).model,
    async refreshWork() {
      const response = await fetchImpl(WORK_VIEW_REFRESH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (!response.ok) {
        let workerReason: string | null = null
        try { const body = await response.json() as { error?: unknown }; if (typeof body.error === 'string') workerReason = body.error } catch { /* Keep the status as the reason. */ }
        throw new RefreshNotStartedError(response.status, workerReason)
      }
      return await response.json() as { state: string }
    },
    markAgentFinished: async (agentId) => (await postForWorkModel(WORK_VIEW_MARK_AGENT_FINISHED_URL, { agentGroupId: agentId }, 'Marking the agent finished')).model,

    subscribeToLiveUpdates(onWorkModel, onConnectionChange) {
      const stopActivity = startViewerActivity({ ...options.activityOptions, enabled: SOURCE_KIND === 'local', fetchImpl })
      const generation = ++streamGeneration
      let resolveFirst!: (model: WorkModel | null) => void
      firstEvent = { promise: new Promise((resolve) => { resolveFirst = resolve }), resolve: (model) => resolveFirst(model) }
      const waiting = firstEvent
      const reportConnection = () => onConnectionChange(currentConnectionStatus())
      const markEventReceived = () => {
        connectionEvidence.transportConnected = true
        connectionEvidence.reconnecting = false
        connectionEvidence.lastEventAt = performance.now()
      }
      const sendIfChanged = (model: WorkModel) => {
        const signature = modelSignature(model)
        if (signature === lastDeliveredSignature) return
        lastDeliveredSignature = signature
        onWorkModel(model)
      }
      publishModel = sendIfChanged

      let stream: EventSource | null = null
      let reopenTimer: ReturnType<typeof setTimeout> | undefined
      const openStream = () => {
        if (generation !== streamGeneration) return
        const query = new URLSearchParams({ view: 'overview' })
        if (sharedOwner) query.set('session', sharedOwner)
        const currentStream = createEventSource(`${WORK_VIEW_EVENTS_URL}?${query}`)
        stream = currentStream
        const current = () => generation === streamGeneration && stream === currentStream
        stream.onopen = () => {
          if (!current()) return
          connectionEvidence.transportConnected = true
          connectionEvidence.reconnecting = false
          reportConnection()
          const reopened = eventStreamHasOpened
          eventStreamHasOpened = true
          // Notices may have been missed while the stream was closed, so every row showing a continued conversation reads it again.
          if (reopened) {
            tellConversationContinuationListeners('live-updates-reconnected')
            notifyReviewStackChanged()
          }
        }
        if (sharedOwner) {
          // The stream's cookie was captured when it opened. A fresh owner-pinned request
          // must authorize every update, including updates announced during another read.
          let refreshing = false
          let pending = false
          const refreshFromHint = async () => {
            pending = true
            if (refreshing) return
            refreshing = true
            try {
              while (pending && current()) {
                pending = false
                const model = await readOverview(undefined, () => { if (!current()) throw abortError() })
                if (!current()) return
                markEventReceived()
                waiting.resolve(model)
                sendIfChanged(model)
                reportConnection()
              }
            } catch { /* Fresh HTTP authorization handles account changes; fallback handles failed reads. */ }
            finally { refreshing = false }
          }
          stream.addEventListener('work-view-changed', () => {
            if (!current()) return
            notifyReviewStackChanged()
            void refreshFromHint()
          })
        } else stream.addEventListener('review-stack-changed', () => {
          if (current()) notifyReviewStackChanged()
        })
        stream.addEventListener('work-view', (event) => {
          if (sharedOwner || !current()) return
          let snapshot: unknown
          try { snapshot = JSON.parse((event as MessageEvent).data) } catch { return /* Malformed messages cannot renew the live indicator. */ }
          if (!isWorkViewSnapshot(snapshot)) return
          markEventReceived()
          legacyMode = true
          const model = acceptSnapshot(snapshot, true)
          waiting.resolve(model)
          sendIfChanged(model)
          reportConnection()
        })
        stream.addEventListener('work-view-overview', (event) => {
          if (sharedOwner || !current()) return
          let overview: unknown
          try { overview = JSON.parse((event as MessageEvent).data) } catch { return }
          if (!isOverview(overview)) return
          markEventReceived()
          const model = acceptOverview(overview, true)
          waiting.resolve(model)
          sendIfChanged(model)
          reportConnection()
        })
        stream.addEventListener('heartbeat', (event) => {
          if (!current()) return
          let beat: { source?: WorkViewSource; at?: string; sync?: SyncStatusForDisplay } | null
          try { beat = JSON.parse((event as MessageEvent).data) } catch { return /* Keep the last valid heartbeat; the freshness deadline still applies. */ }
          if (sharedOwner) {
            if (!beat?.at || !Number.isFinite(Date.parse(beat.at))) return
            markEventReceived()
            // A successful durable-head check confirms that the last authorized model is current.
            if (connectionEvidence.sourceConnected && connectionEvidence.lastSuccessfulCheckAt) {
              connectionEvidence.lastSuccessfulCheckAt = beat.at
              connectionEvidence.lastSuccessfulCheckReceivedAt = performance.now()
            }
            reportConnection()
            return
          }
          if (!beat || typeof beat.source?.connected !== 'boolean') return
          markEventReceived()
          recordSourceHealth(beat.source, beat.at)
          recordSync(beat.sync)
          reportConnection()
        })
        stream.addEventListener('sync_status', (event) => {
          if (sharedOwner || !current()) return
          let status: { sync?: unknown } | null
          try { status = JSON.parse((event as MessageEvent).data) } catch { return }
          if (!status || !isSyncStatus(status.sync)) return
          // A sync diagnostic is not evidence that the work projection was read successfully.
          recordSync(status.sync)
          reportConnection()
        })
        // An exchange sent from My Work started or ended. The notice names it and its state only: the row it concerns
        // reads the rest through the guarded read. Like a sync diagnostic, it is no evidence about the work projection.
        stream.addEventListener('conversation-continuation', (event) => {
          if (sharedOwner || !current()) return
          applySseFrame('conversation-continuation', (event as MessageEvent).data, (frame: Record<string, unknown>) => {
            const notice = readConversationContinuationNotice(frame)
            if (notice) tellConversationContinuationListeners(notice)
          }, (frame) => readConversationContinuationNotice(frame) !== null)
        })
        if (sharedOwner) stream.addEventListener('session-ended', () => {
          if (current()) notifySharedViewer('cmem:session-ended')
        })
        stream.onerror = () => {
          if (!current()) return
          if (sharedOwner) notifySharedViewer('cmem:session-check')
          waiting.resolve(null)
          connectionEvidence.transportConnected = false
          connectionEvidence.reconnecting = true
          reportConnection()
          // EventSource retries a dropped connection by itself, but gives up for good after an HTTP error response
          // (the Vite proxy answers 500 while the worker is down). Reopen it at the server's retry interval.
          if (currentStream.readyState === 2 /* EventSource.CLOSED */) reopenTimer = setTimeout(openStream, STREAM_REOPEN_AFTER_MS)
        }
      }
      if (!pageHidden()) openStream()

      // Cloud only. Hidden: close the stream and cancel a pending reopen (so none can open while hidden); the aging
      // timer below skips its read. Shown: reopen the stream, whose first event is the current overview
      // (WorkViewRoutes sends it on every new stream). No delay and no threshold: a quick tab switch just reconnects,
      // and Fly takes minutes to stop a machine. A machine that slept answers 503 through the gate while its worker
      // boots; the stream's error handler reopens it until the worker answers.
      const followVisibility = () => {
        if (generation !== streamGeneration) return
        if (pageHidden()) {
          clearTimeout(reopenTimer)
          stream?.close()
          stream = null
          connectionEvidence.transportConnected = false
          connectionEvidence.reconnecting = true
          reportConnection()
          return
        }
        if (!stream) openStream()
      }
      visibility?.addEventListener('visibilitychange', followVisibility)

      // Re-reads connection freshness every second: "live" expires on its own when messages stop.
      const connectionTimer = setInterval(reportConnection, CONNECTION_TICK_MS)
      // Legacy snapshots contain epochs we can age locally. Compact streams already send minute remaps;
      // an HTTP fallback is only needed while the feed is unhealthy, at most once per cache window.
      const agingTimer = setInterval(() => {
        if (pageHidden()) return
        if (latestSnapshot) sendIfChanged(withConnection(toWorkModel(latestSnapshot, Date.now())))
        else if (latestModel && !currentConnectionStatus().isLive && performance.now() - lastOverviewReadAt >= STALE_FALLBACK_INTERVAL_MS) {
          void readOverview().then((model) => { if (generation === streamGeneration) sendIfChanged(model) }).catch(() => { /* Keep the last model; event freshness remains independent. */ })
        }
      }, AGING_TICK_MS)

      return () => {
        waiting.resolve(null)
        clearTimeout(reopenTimer)
        visibility?.removeEventListener('visibilitychange', followVisibility)
        stream?.close()
        clearInterval(connectionTimer)
        clearInterval(agingTimer)
        stopActivity()
        if (generation !== streamGeneration) return
        streamGeneration++
        detailSelection++
        if (firstEvent === waiting) firstEvent = null
        initialRead = null
        publishModel = null
        for (const controller of activeReads) controller.abort(abortError())
      }
    },
  }
  return localSource
}

export const localSource = createLocalSource()
