// The claude-mem worker on this computer (localhost:37777). In Vite dev the /api proxy reaches it; served by the
// worker, /api is the same origin. One HTTP read when the page opens, then the worker's SSE feed. No polling.
// The live wiring copies claude-mem v15.0.1 plugin/ui/work-view/app.js:180-261 (`accept`, `refresh`, the
// EventSource handlers, the 1s connection timer and the 60s aging timer). The check copies app.js:125-138 (`saveReview`).
import { getConnectionStatus, type ConnectionStatus } from './connection-status.ts'
import { conflictReason, readReviewResponse, type ReviewResult } from './review-response.ts'
import { toWorkModel } from './to-work-model.ts'
import type { MappedWorkModel, WorkDataSource, WorkModel, WorkMutationResult } from './work-data-source.ts'
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

/** Only connection evidence is excluded: it is delivered separately on its own clock. */
const modelSignature = ({ connection: _connection, ...model }: WorkModel) => JSON.stringify(model)

const isWorkViewSnapshot = (value: unknown): value is WorkViewSnapshot => {
  const snapshot = value as WorkViewSnapshot | null
  return !!snapshot && Array.isArray(snapshot.humanRequests) && typeof snapshot.source?.connected === 'boolean'
}

/** Each source owns its cache and transport evidence; tests and remounts never inherit another source's feed. */
export function createLocalSource(): WorkDataSource {
  const connectionEvidence = {
    transportConnected: false,
    reconnecting: false,
    lastEventAt: null as number | null,
    sourceConnected: null as boolean | null,
    lastSuccessfulCheckAt: null as string | null,
    lastSuccessfulCheckReceivedAt: null as number | null,
  }
  let latestSnapshot: WorkViewSnapshot | null = null
  let snapshotVersion = 0
  let subscriptionGeneration = 0

  const currentConnectionStatus = (): ConnectionStatus =>
    getConnectionStatus({ ...connectionEvidence, now: performance.now(), wallNow: Date.now() })
  const withConnection = (mapped: MappedWorkModel): WorkModel => ({ ...mapped, connection: currentConnectionStatus() })
  const currentModel = () => latestSnapshot ? withConnection(toWorkModel(latestSnapshot, Date.now())) : null

  function recordSourceHealth(source: WorkViewSource | undefined) {
    connectionEvidence.sourceConnected = typeof source?.connected === 'boolean' ? source.connected : null
    if (source?.connected === true && typeof source.lastCheckedAt === 'string' && Number.isFinite(Date.parse(source.lastCheckedAt))) {
      connectionEvidence.lastSuccessfulCheckAt = source.lastCheckedAt
      connectionEvidence.lastSuccessfulCheckReceivedAt = performance.now()
    }
  }

  function acceptSnapshot(snapshot: WorkViewSnapshot): WorkModel {
    latestSnapshot = snapshot
    snapshotVersion++
    // Accepting a checked HTTP response can update source health, but cannot renew SSE liveness.
    recordSourceHealth(snapshot.source)
    return withConnection(toWorkModel(snapshot, Date.now()))
  }

  async function loadWorkModel(): Promise<WorkModel> {
    const versionBeforeRead = snapshotVersion
    const generationBeforeRead = subscriptionGeneration
    const response = await fetch(WORK_VIEW_URL, { cache: 'no-store' })
    if (!response.ok) throw new Error(`The local worker answered ${response.status} ${response.statusText}`.trim())
    const snapshot: unknown = await response.json()
    if (!isWorkViewSnapshot(snapshot)) throw new Error('The local worker sent something that is not a work snapshot.')
    // A model, not a heartbeat, received during this read wins. A response from an old subscription
    // may satisfy its caller, but cannot overwrite the cache belonging to a newer subscription.
    if (snapshotVersion !== versionBeforeRead || subscriptionGeneration !== generationBeforeRead) {
      return currentModel() ?? withConnection(toWorkModel(snapshot, Date.now()))
    }
    return acceptSnapshot(snapshot)
  }

  async function acceptMutation(snapshot: WorkViewSnapshot, versionBeforeSave: number, generationBeforeSave: number): Promise<WorkMutationResult> {
    const savedModel = withConnection(toWorkModel(snapshot, Date.now()))
    if (subscriptionGeneration !== generationBeforeSave) return { savedModel, model: currentModel() ?? savedModel, refreshError: null }
    // The write succeeded, but its response may predate a newer event. Re-read after the write so
    // the mutation is retained without rolling back unrelated requests, rules or agent updates.
    if (snapshotVersion === versionBeforeSave) return { savedModel, model: acceptSnapshot(snapshot), refreshError: null }
    try {
      return { savedModel, model: await loadWorkModel(), refreshError: null }
    } catch (reason) {
      return { savedModel, model: currentModel() ?? savedModel, refreshError: reason instanceof Error ? reason.message : String(reason) }
    }
  }

  async function postForWorkModel(url: string, body: unknown, whatWasSaved: string): Promise<WorkMutationResult> {
    const versionBeforeSave = snapshotVersion
    const generationBeforeSave = subscriptionGeneration
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    let answer: unknown = null
    try { answer = await response.json() } catch { /* A non-JSON body leaves the status to report. */ }
    if (!response.ok) {
      const reason = (answer as { error?: unknown } | null)?.error
      throw new Error(`${whatWasSaved} was not saved: ${typeof reason === 'string' ? reason : `the worker answered ${response.status}`}`)
    }
    if (!isWorkViewSnapshot(answer)) throw new Error(`${whatWasSaved} was saved, but the worker sent back something that is not a work snapshot. Reload to see it.`)
    const result = await acceptMutation(answer, versionBeforeSave, generationBeforeSave)
    const savedRuleId = (answer as WorkViewSnapshot & { savedRuleId?: unknown }).savedRuleId
    return url === WORK_VIEW_RULES_URL && typeof savedRuleId === 'string'
      ? { ...result, savedRuleId }
      : result
  }

  return {
    sourceKind: 'local',
    loadWorkModel,

    async setRequestChecked(requestId, expectedFingerprint, checked): Promise<ReviewResult> {
      if (!CONTENT_FINGERPRINT_PATTERN.test(expectedFingerprint)) throw new Error(`Can't check ${requestId}: its recorded version (content fingerprint) is missing`)
      const versionBeforeSave = snapshotVersion
      const generationBeforeSave = subscriptionGeneration
      const response = await fetch(WORK_VIEW_REVIEW_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, expectedFingerprint, checked }),
      })
      let body: unknown = null
      try { body = await response.json() } catch { /* A non-JSON body leaves the status to report. */ }
      const answer = readReviewResponse(response.status, body)
      if (answer.kind === 'unavailable') return { outcome: 'unavailable', serverMessage: answer.serverMessage }
      if (answer.kind === 'conflict') {
        const latest = await loadWorkModel()
        const latestFingerprint = latest.requests.find((request) => request.id === requestId)?.contentFingerprint
        return conflictReason(expectedFingerprint, latestFingerprint) === 'refused'
          ? { outcome: 'refused', serverMessage: answer.serverMessage, model: latest }
          : { outcome: 'changed-while-reading', model: latest }
      }
      if (!isWorkViewSnapshot(answer.snapshot)) throw new Error('The local review was saved, but the worker sent back something that is not a work snapshot. Reload to see it.')
      return { outcome: 'saved', ...await acceptMutation(answer.snapshot, versionBeforeSave, generationBeforeSave) }
    },

    saveRuleChange: (change) => postForWorkModel(WORK_VIEW_RULES_URL, change, 'The rule change'),
    loadRulesInClaudeCode: () => postForWorkModel(WORK_VIEW_LOAD_RULES_URL, {}, 'Loading your rules into Claude Code'),
    markAgentFinished: (agentId) => postForWorkModel(WORK_VIEW_MARK_AGENT_FINISHED_URL, { agentGroupId: agentId }, 'Marking the agent finished'),

    subscribeToLiveUpdates(onWorkModel, onConnectionChange) {
      const generation = ++subscriptionGeneration
      let disposed = false
      let lastDeliveredSignature: string | null = null
      let stream: EventSource | null = null
      let reopenTimer: ReturnType<typeof setTimeout> | undefined
      const active = () => !disposed && subscriptionGeneration === generation
      // A new subscription must prove its own liveness, even when the last model is cached.
      connectionEvidence.transportConnected = false
      connectionEvidence.reconnecting = false
      connectionEvidence.lastEventAt = null
      const reportConnection = () => { if (active()) onConnectionChange(currentConnectionStatus()) }
      const sendIfChanged = (model: WorkModel) => {
        if (!active()) return
        const signature = modelSignature(model)
        if (signature === lastDeliveredSignature) return
        lastDeliveredSignature = signature
        onWorkModel(model)
      }
      const markEventReceived = () => {
        connectionEvidence.transportConnected = true
        connectionEvidence.reconnecting = false
        connectionEvidence.lastEventAt = performance.now()
      }
      const openStream = () => {
        reopenTimer = undefined
        if (!active()) return
        const opened = new EventSource(WORK_VIEW_EVENTS_URL)
        stream = opened
        const isCurrentStream = () => active() && stream === opened
        opened.onopen = () => {
          if (!isCurrentStream()) return
          connectionEvidence.transportConnected = true
          connectionEvidence.reconnecting = false
          reportConnection()
        }
        opened.addEventListener('work-view', (event) => {
          if (!isCurrentStream()) return
          let snapshot: unknown
          try { snapshot = JSON.parse((event as MessageEvent).data) } catch { return }
          if (!isWorkViewSnapshot(snapshot)) return
          markEventReceived()
          sendIfChanged(acceptSnapshot(snapshot))
          reportConnection()
        })
        opened.addEventListener('heartbeat', (event) => {
          if (!isCurrentStream()) return
          let beat: { source?: WorkViewSource } | null
          try { beat = JSON.parse((event as MessageEvent).data) } catch { return }
          if (!beat || typeof beat.source?.connected !== 'boolean') return
          markEventReceived()
          recordSourceHealth(beat.source)
          reportConnection()
        })
        opened.onerror = () => {
          if (!isCurrentStream()) return
          connectionEvidence.transportConnected = false
          connectionEvidence.reconnecting = true
          reportConnection()
          // EventSource handles ordinary disconnects; closed streams (including proxy HTTP errors)
          // need a new object. Schedule at most one and never reopen after cleanup.
          if (opened.readyState === EventSource.CLOSED && reopenTimer === undefined) {
            reopenTimer = setTimeout(openStream, STREAM_REOPEN_AFTER_MS)
          }
        }
      }
      reportConnection()
      openStream()
      const connectionTimer = setInterval(reportConnection, CONNECTION_TICK_MS)
      const agingTimer = setInterval(() => {
        if (active()) {
          const model = currentModel()
          if (model) sendIfChanged(model)
        }
      }, AGING_TICK_MS)

      return () => {
        disposed = true
        clearTimeout(reopenTimer)
        stream?.close()
        clearInterval(connectionTimer)
        clearInterval(agingTimer)
        if (subscriptionGeneration === generation) {
          subscriptionGeneration++
          connectionEvidence.transportConnected = false
        }
      }
    },
  }
}

export const localSource = createLocalSource()
