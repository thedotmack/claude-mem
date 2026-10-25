// The claude-mem worker on this computer (localhost:37777). In Vite dev the /api proxy reaches it; served by the
// worker, /api is the same origin. One HTTP read when the page opens, then the worker's SSE feed. No polling.
// The live wiring copies claude-mem v15.0.1 plugin/ui/work-view/app.js:180-261 (`accept`, `refresh`, the
// EventSource handlers, the 1s connection timer and the 60s aging timer). The check copies app.js:125-138 (`saveReview`).
import { getConnectionStatus, type ConnectionStatus } from './connection-status.ts'
import { conflictReason, readReviewResponse, type ReviewResult } from './review-response.ts'
import { toWorkModel } from './to-work-model.ts'
import type { MappedWorkModel, WorkDataSource, WorkModel } from './work-data-source.ts'
import type { WorkViewSnapshot, WorkViewSource } from './work-view-api-types.ts'

const WORK_VIEW_URL = '/api/work-view'
const WORK_VIEW_EVENTS_URL = '/api/work-view/events'
const WORK_VIEW_REVIEW_URL = '/api/work-view/review'
const WORK_VIEW_RULES_URL = '/api/work-view/rules'
const WORK_VIEW_LOAD_RULES_URL = '/api/work-view/rules/load-in-claude-code'
const WORK_VIEW_MARK_AGENT_FINISHED_URL = '/api/work-view/agents/mark-finished'
const CONTENT_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const CONNECTION_TICK_MS = 1000
const AGING_TICK_MS = 60_000
/** The worker's SSE `retry: 1000`. */
const STREAM_REOPEN_AFTER_MS = 1000

/** The evidence getConnectionStatus reads. Times are performance.now(); see connection-status.ts. */
const connectionEvidence = {
  transportConnected: false,
  reconnecting: false,
  lastEventAt: null as number | null,
  sourceConnected: null as boolean | null,
  lastSuccessfulCheckAt: null as string | null,
  lastSuccessfulCheckReceivedAt: null as number | null,
}
/** The newest snapshot accepted, kept so the aging timer can re-map it as time passes. */
let latestSnapshot: WorkViewSnapshot | null = null
/** The content of the last model handed to the screens, so an unchanged snapshot or a quiet minute is not sent again. */
let lastDeliveredSignature: string | null = null
const modelSignature = (model: MappedWorkModel) => JSON.stringify([model.agents, model.requests, model.requestReadErrors, model.unlinkedWorkCount, model.sourceHealth, model.priorities, model.openAsks, model.currentPeriod, model.pastPeriods, model.goalsReadError, model.lastRuns, model.refresh, model.rules, model.ruleScopes, model.rulesLearning, model.rulesFile, model.rulesReadError])

const currentConnectionStatus = (): ConnectionStatus =>
  getConnectionStatus({ ...connectionEvidence, now: performance.now(), wallNow: Date.now() })

const withConnection = (mapped: MappedWorkModel): WorkModel => ({ ...mapped, connection: currentConnectionStatus() })

/** app.js `health`: only a payload whose source read succeeded counts as a successful check. */
function recordSourceHealth(source: WorkViewSource | undefined) {
  connectionEvidence.sourceConnected = typeof source?.connected === 'boolean' ? source.connected : null
  if (source?.connected === true && typeof source.lastCheckedAt === 'string' && Number.isFinite(Date.parse(source.lastCheckedAt))) {
    connectionEvidence.lastSuccessfulCheckAt = source.lastCheckedAt
    connectionEvidence.lastSuccessfulCheckReceivedAt = performance.now()
  }
}

/** app.js `accept`: an HTTP read that began before a newer event must not renew or overwrite the feed's health evidence. */
function acceptSnapshot(snapshot: WorkViewSnapshot, fromEvent: boolean): WorkModel {
  latestSnapshot = snapshot
  if (fromEvent || connectionEvidence.lastEventAt === null) recordSourceHealth(snapshot.source)
  return withConnection(toWorkModel(snapshot, Date.now()))
}

const isWorkViewSnapshot = (value: unknown): value is WorkViewSnapshot => {
  const snapshot = value as WorkViewSnapshot | null
  return !!snapshot && Array.isArray(snapshot.humanRequests) && typeof snapshot.source?.connected === 'boolean'
}

/** POSTs to an origin-guarded work-view route that answers with the snapshot after the change. Anything else throws its reason. */
async function postForWorkModel(url: string, body: unknown, whatWasSaved: string): Promise<WorkModel> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let answer: unknown = null
  try { answer = await response.json() } catch { /* A body that isn't JSON leaves only the status to report. */ }
  if (!response.ok) {
    const reason = (answer as { error?: unknown } | null)?.error
    throw new Error(`${whatWasSaved} was not saved: ${typeof reason === 'string' ? reason : `the worker answered ${response.status}`}`)
  }
  if (!isWorkViewSnapshot(answer)) throw new Error(`${whatWasSaved} was saved, but the worker sent back something that is not a work snapshot. Reload to see it.`)
  const model = acceptSnapshot(answer, false)
  lastDeliveredSignature = modelSignature(model)
  return model
}

export const localSource: WorkDataSource = {
  sourceKind: 'local',

  /** app.js `refresh`: when an SSE snapshot arrived while this read was in flight, the event's newer model wins. */
  async loadWorkModel() {
    const lastEventBeforeRead = connectionEvidence.lastEventAt
    const response = await fetch(WORK_VIEW_URL, { cache: 'no-store' })
    if (!response.ok) throw new Error(`The local worker answered ${response.status} ${response.statusText}`.trim())
    const snapshot = (await response.json()) as WorkViewSnapshot
    const model = connectionEvidence.lastEventAt !== lastEventBeforeRead && latestSnapshot
      ? withConnection(toWorkModel(latestSnapshot, Date.now()))
      : acceptSnapshot(snapshot, false)
    lastDeliveredSignature = modelSignature(model)
    return model
  },

  /**
   * app.js `saveReview`: POST the version on screen. 409 → read the latest model (the worker refused a stale or
   * incomplete version); 200 → the worker's snapshot after the save; 503 → the worker's reason. Anything else throws.
   */
  async setRequestChecked(requestId, expectedFingerprint, checked): Promise<ReviewResult> {
    if (!CONTENT_FINGERPRINT_PATTERN.test(expectedFingerprint)) throw new Error(`Can't check ${requestId}: its recorded version (content fingerprint) is missing`)
    const response = await fetch(WORK_VIEW_REVIEW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, expectedFingerprint, checked }),
    })
    let body: unknown = null
    try { body = await response.json() } catch { /* A body that isn't JSON leaves only the status to report. */ }
    const answer = readReviewResponse(response.status, body)
    if (answer.kind === 'unavailable') return { outcome: 'unavailable', serverMessage: answer.serverMessage }
    if (answer.kind === 'conflict') {
      const latest = await localSource.loadWorkModel()
      const latestFingerprint = latest.requests.find((request) => request.id === requestId)?.contentFingerprint
      return conflictReason(expectedFingerprint, latestFingerprint) === 'refused'
        ? { outcome: 'refused', serverMessage: answer.serverMessage, model: latest }
        : { outcome: 'changed-while-reading', model: latest }
    }
    if (!isWorkViewSnapshot(answer.snapshot)) throw new Error('The local review was saved, but the worker sent back something that is not a work snapshot. Reload to see it.')
    const model = acceptSnapshot(answer.snapshot, false)
    lastDeliveredSignature = modelSignature(model)
    return { outcome: 'saved', model }
  },

  saveRuleChange: (change) => postForWorkModel(WORK_VIEW_RULES_URL, change, 'The rule change'),
  loadRulesInClaudeCode: () => postForWorkModel(WORK_VIEW_LOAD_RULES_URL, {}, 'Loading your rules into Claude Code'),
  markAgentFinished: (agentId) => postForWorkModel(WORK_VIEW_MARK_AGENT_FINISHED_URL, { agentGroupId: agentId }, 'Marking the agent finished'),

  subscribeToLiveUpdates(onWorkModel, onConnectionChange) {
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

    let stream: EventSource
    let reopenTimer: ReturnType<typeof setTimeout> | undefined
    const openStream = () => {
      stream = new EventSource(WORK_VIEW_EVENTS_URL)
      stream.onopen = () => {
        connectionEvidence.transportConnected = true
        connectionEvidence.reconnecting = false
        reportConnection()
      }
      stream.addEventListener('work-view', (event) => {
        let snapshot: unknown
        try { snapshot = JSON.parse((event as MessageEvent<string>).data) } catch { return /* Malformed messages cannot renew the live indicator. */ }
        if (!isWorkViewSnapshot(snapshot)) return
        markEventReceived()
        sendIfChanged(acceptSnapshot(snapshot, true))
        reportConnection()
      })
      stream.addEventListener('heartbeat', (event) => {
        let beat: { source?: WorkViewSource } | null
        try { beat = JSON.parse((event as MessageEvent<string>).data) } catch { return /* Keep the last valid heartbeat; the freshness deadline still applies. */ }
        if (!beat || typeof beat.source?.connected !== 'boolean') return
        markEventReceived()
        recordSourceHealth(beat.source)
        reportConnection()
      })
      stream.onerror = () => {
        connectionEvidence.transportConnected = false
        connectionEvidence.reconnecting = true
        reportConnection()
        // EventSource retries a dropped connection by itself, but gives up for good after an HTTP error response
        // (the Vite proxy answers 500 while the worker is down). Reopen it at the server's retry interval.
        if (stream.readyState === EventSource.CLOSED) reopenTimer = setTimeout(openStream, STREAM_REOPEN_AFTER_MS)
      }
    }
    openStream()

    // Re-reads connection freshness every second: "live" expires on its own when messages stop.
    const connectionTimer = setInterval(reportConnection, CONNECTION_TICK_MS)
    // Ages recorded activity (running-for, quiet after 6h) without a synthetic source event.
    const agingTimer = setInterval(() => {
      if (latestSnapshot) sendIfChanged(withConnection(toWorkModel(latestSnapshot, Date.now())))
    }, AGING_TICK_MS)

    return () => {
      clearTimeout(reopenTimer)
      stream.close()
      clearInterval(connectionTimer)
      clearInterval(agingTimer)
    }
  },
}
