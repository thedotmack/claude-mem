// What the funnel screens show. Every screen reads it through props; nothing here is made up.
// The live source fills it from the worker (prompt scan, extraction, usage, setup state); `?source=sample` loads
// setup-sample.ts instead, and only then.
import { toSetupUsage, type SetupScanUsage, type SetupUsage } from './setup-usage'
import { revealFromSnapshot, type SnapshotWithSetup, type WorkerExtraction } from './setup-reveal'
import { noteFor, searchUrl, toMemoryResults, type MemoryResult, type WorkerSearchResult } from './setup-search'
import { applySseFrame } from '../live/parse-sse-frame'
import { HISTORY_IMPORT_RUN_STATES, INTENT_MAX_UPLOAD_BYTES, type HistoryImportRunState, type SetupBranch, type SetupCheckoutState, type SetupCloudSyncOffer, type SetupEvent, type SetupMemoryBilling, type SetupScanPhase, type SetupStatus } from '../../../../shared/setup-funnel.ts'
import { hasPendingInstallSetup, type SetupInstallSelection, type SetupInstallState } from '../../../../shared/setup-install.ts'

/** Mirrors the worker's SetupScanState (src/services/prompt-import/setup-scan.ts), trimmed to what the screen shows. */
export interface SetupScanAgent {
  id: string; label: string; detected: boolean; prompts: number
  /** Whether the agent can run setup's extraction here (the worker's agent detection); `null` when unknown or not a runner. */
  canRunSetup: boolean | null
  /** Why it cannot, e.g. "Gemini is installed, but this Google account can't use it: ...". */
  cannotRunReason: string | null
  /** The JSON bytes this tool's prompts add to the hosted upload; 0 from an older worker. */
  uploadBytes: number
}

/**
 * Whether these tools' prompts are too much for setup's one hosted upload. The worker refuses such an upload before it
 * sends anything, so the consent step says it while the person can still untick a tool. Each tool's share is a lower
 * bound on its part of the upload, so this never warns about an upload that would fit.
 */
export function uploadTooLarge(agents: Pick<SetupScanAgent, 'uploadBytes'>[]): boolean {
  return agents.reduce((sum, agent) => sum + agent.uploadBytes, 0) > INTENT_MAX_UPLOAD_BYTES
}

export type { SetupScanPhase }
export interface SetupScanView {
  agents: SetupScanAgent[]; percent: number; phase: SetupScanPhase; done: boolean; error: string | null; improveProduct: boolean
  /** Set only when this page's own request to read or start the scan failed; the worker's scan state never has it. */
  errorKind?: SetupFailureKind
  /** Why hosted extraction was skipped (budget/rate limit) while setup finished locally. */
  hostedNotice?: string | null
  /** Which tools' prompts were sent to cmem.ai: null before the person answers, [] when nothing left this machine. */
  uploadedAgents: string[] | null
}
/** The owner's newest typed prompts, quoted as typed (SetupScanState.recentPrompts). */
export interface SetupRecentPrompt { agent: string; at: string; text: string }
/** The worker's subsidized hosted setup extraction. */
/** On The Go checkout, mirrored from the installer that runs it (`null` until the page asks). */
export interface SetupCheckoutView { state: SetupCheckoutState; error: string | null }
/** What the installer did with the choice. A failed handoff can be retried from the setup page. */
export interface SetupInstallerView { stage: InstallerStage; error: string | null }
export type SetupExtraction = Pick<WorkerExtraction, 'state' | 'step'>

export type { RevealGoal, RevealRule, RevealSets, RevealWork } from './setup-reveal'
import type { RevealSets } from './setup-reveal'
import type { InstallerStage, SetupStep } from './setup-flow'

export type { Persona, SetupScanUsage, SetupUsage, UsageCoverage } from './setup-usage'

export interface SetupHistory { projects: number; sessions: number; observations: number }
/**
 * The worker's history upload, from its first run on (`idle`, no run yet, is null). `state` is the worker's run state
 * (setup-funnel.ts, its one definition). `imported` counts observations cmem.ai wrote, the only count that says what
 * reached the account; `error` is why a failed run stopped. `sent` of `total` is how far the run is (rows cmem.ai
 * acknowledged: written, already there, or unreadable); a worker that does not report them leaves them out (plan G19),
 * and the screen then shows the percent alone. `skipped` is the acknowledged rows cmem.ai did not write: ones it
 * already had or could not read (its answer does not say which). `unconfirmed` is the batch that was on its way when
 * the person pressed Stop: cmem.ai may have saved some of it.
 */
export interface HistoryImportProgress {
  state: Exclude<HistoryImportRunState, 'idle'>; percent: number; imported: number; error: string | null
  sent?: number; total?: number; skipped?: number; unconfirmed?: number
}

/**
 * Why something the page asked of the worker failed, as the page words it (plan G17): no answer arrived at all (the
 * worker is down or restarting), the worker answered and refused, or the page itself failed, before or after asking
 * (it is not connected, or it could not read the answer). The one definition; the screens' words are a Record over it.
 */
export type SetupFailureKind = 'unreachable' | 'refused' | 'page'

/** A failed request whose kind is known. `message` keeps the browser's or the worker's own words, for the Details fold. */
export class SetupRequestError extends Error {
  kind: SetupFailureKind
  constructor(kind: SetupFailureKind, message: string) {
    super(message)
    this.name = 'SetupRequestError'
    this.kind = kind
  }
}

/** A failure as a screen shows it: plain words chosen by `kind`, and the raw `detail` folded under Details. */
export interface SetupFailure { kind: SetupFailureKind; detail: string }

/**
 * Anything thrown while talking to the worker. Only a request that says so is "unreachable" or "refused"; any other
 * error came from the page itself, so its words never claim that claude-mem answered.
 */
export function toSetupFailure(error: unknown): SetupFailure {
  return { kind: error instanceof SetupRequestError ? error.kind : 'page', detail: error instanceof Error ? error.message : String(error) }
}

export type { MemoryResult } from './setup-search'

export interface SetupData {
  connectionError: string | null
  /** Whether the connection error got no answer at all or a refusal; null with no error. */
  connectionErrorKind: SetupFailureKind | null
  choice: SetupChoice | null
  /** Undefined until the first state response; null for older/already configured installers. */
  install: SetupInstallState | null | undefined
  scan: SetupScanView
  reveal: RevealSets
  /** `null` until the worker reports a run. Older workers may still report waiting-for-agent. */
  extraction: SetupExtraction | null
  recentPrompts: SetupRecentPrompt[]
  checkout: SetupCheckoutView | null
  /** `null` until an installer reports. */
  installer: SetupInstallerView | null
  usage: SetupUsage | null
  alreadyPro: boolean
  /** Finish Setup tool ids found on this machine; they come pre-ticked. */
  detectedTools: string[]
  /** claude-mem observation history that could be imported. `null` for new installs. */
  history: SetupHistory | null
  historyImport: HistoryImportProgress | null
  /** "What's next?" chips, from the person's own goals and open asks. */
  suggestions: string[]
}

/** What the page posts when it leaves Token Savings: where memory lives, and who generates it. */
export interface SetupChoice { branch: SetupBranch; memoryBilling: SetupMemoryBilling; cloudSyncOffer?: SetupCloudSyncOffer }

export interface SetupSource {
  readonly kind: 'local' | 'sample'
  subscribe(onData: (data: SetupData) => void): () => void
  /** Explicitly retries a stopped installation; first-use resume never carries this intent. */
  resume(): Promise<void>
  configureInstall(selection: SetupInstallSelection): Promise<void>
  /** Starts another scan only after the user chooses to retry a failure. */
  retryScan(): Promise<void>
  /** Changes the hosted setup results preference without pausing the scan or upload. */
  setImproveProduct(improveProduct: boolean): Promise<void>
  /** Answers the upload question: true sends the scanned prompts to cmem.ai, false keeps them on this machine. */
  confirmUpload(upload: boolean, agents?: string[], improveProduct?: boolean): Promise<void>
  /** Hands the storage choice to the installer waiting in the terminal (POST /api/setup/choice). */
  choose(choice: SetupChoice): Promise<void>
  /** Asks the installer holding the On The Go sign-in to open checkout (POST /api/setup/checkout). */
  checkout(): Promise<void>
  /** Finishes setup for this machine with the tools picked on Finish Setup; the terminal exits (POST /api/setup/complete). */
  complete(tools: string[], telemetry?: SetupEvent[]): Promise<void>
  /** Uploads this machine's observations to the CMEM account (POST /api/setup/import). Only the person's press calls it. */
  startHistoryImport(): Promise<void>
  /** Ends the upload at once; what reached the account stays (POST /api/setup/import/stop). Only the person's Stop calls it. */
  stopHistoryImport(): Promise<void>
  search(query: string): Promise<MemoryResult[]>
  /** Keep as note: saves `text` as a new memory (POST /api/memory/save) and answers its observation id. */
  keepNote(record: MemoryResult, text: string): Promise<number>
  /** Removes a note this page saved, once its edited copy is saved (DELETE /api/observation/:id). */
  forgetNote(id: number): Promise<void>
}

export const EMPTY_SETUP_DATA: SetupData = {
  connectionError: null,
  connectionErrorKind: null,
  choice: null,
  install: undefined,
  scan: { agents: [], percent: 0, phase: 'idle', done: false, error: null, improveProduct: true, uploadedAgents: null },
  reveal: { goals: null, work: null, rules: null, focusAreas: null, requests: [], requestReadErrorCount: 0 },
  extraction: null,
  recentPrompts: [],
  checkout: null,
  installer: null,
  usage: null,
  alreadyPro: false,
  detectedTools: [],
  history: null,
  historyImport: null,
  suggestions: [],
}

/**
 * The connection failure the page shows above the screen, or null. The first load's failure is also the stopped
 * scan's own failure: while the scan screen shows that stop, the page says it there instead, once.
 */
export function connectionFailureAbove(data: Pick<SetupData, 'connectionError' | 'connectionErrorKind' | 'scan'>, step: SetupStep): SetupFailure | null {
  if (data.connectionError === null) return null
  if (step === 'scan' && data.scan.phase === 'failed' && data.scan.error === data.connectionError) return null
  // Every writer sets the kind with the error; without one the page's own state is off, which is the "page" words.
  return { kind: data.connectionErrorKind ?? 'page', detail: data.connectionError }
}

/** The worker's answers, trimmed to what this file reads. `errorKind` is the page's own: the worker never sends it. */
interface WorkerScanState extends Omit<SetupScanView, 'agents' | 'improveProduct' | 'uploadedAgents' | 'hostedNotice' | 'errorKind'> {
  hostedNotice?: string | null
  /** Older workers upload without asking and do not send this. */
  uploadedAgents?: string[] | null
  /** Older workers do not send the hosted setup preference. */
  improveProduct?: boolean
  /** An older worker sends no canRunSetup / cannotRunReason / uploadBytes. */
  agents: Array<Omit<SetupScanAgent, 'canRunSetup' | 'cannotRunReason' | 'uploadBytes'> & Partial<Pick<SetupScanAgent, 'canRunSetup' | 'cannotRunReason' | 'uploadBytes'>> & { fromMemory?: number; fromTranscripts?: number }>
  /** The 30-day token usage the same pass sums, once the scan is done. */
  usage?: SetupScanUsage | null
  recentPrompts?: SetupRecentPrompt[]
}
interface WorkerHistoryImport { state: HistoryImportRunState; percent: number; imported: number; error: string | null; sent?: number; total?: number; skipped?: number; unconfirmed?: number }
interface WorkerSetupState {
  choice?: SetupChoice | null
  install?: SetupInstallState | null
  status: SetupStatus; alreadyPro: boolean; checkout?: SetupCheckoutView | null
  installer?: SetupInstallerView | null
  history?: SetupHistory | null; historyImport?: WorkerHistoryImport | null
}
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
/** Whether the worker's word is a run state this page knows (the list's one definition is setup-funnel.ts). */
const knownRunState = (state: unknown): state is HistoryImportRunState => HISTORY_IMPORT_RUN_STATES.includes(state as HistoryImportRunState)
const toHistoryImport = (run: WorkerHistoryImport | null | undefined): HistoryImportProgress | null =>
  // No run yet, or a state this page cannot word (a newer worker's): nothing to show, and nothing called running.
  !run || run.state === 'idle' || !knownRunState(run.state) ? null : {
    state: run.state, percent: run.percent, imported: run.imported, error: run.state === 'failed' ? run.error : null,
    // Older workers send neither; the screen shows "<sent> of <total>" only when both are real counts.
    ...(count(run.sent) !== undefined && count(run.total) ? { sent: count(run.sent), total: count(run.total) } : {}),
    // Finish Setup's receipt says what the skipped ones were only when the worker counted them.
    ...(count(run.skipped) !== undefined ? { skipped: count(run.skipped) } : {}),
    // Only a stopped run has a batch whose answer never came; 0 means there was none.
    ...(run.state === 'stopped' && count(run.unconfirmed) ? { unconfirmed: count(run.unconfirmed) } : {}),
  }

async function workerJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response
  // fetch rejects only when no answer arrived; the browser's own words ("Failed to fetch") go to the Details fold.
  try { response = await fetch(url, { cache: 'no-store', ...init }) } catch (error) {
    throw new SetupRequestError('unreachable', error instanceof Error ? error.message : String(error))
  }
  let answer: unknown = null
  try { answer = await response.json() } catch { /* A body that isn't JSON leaves only the status to report. */ }
  if (!response.ok) {
    const reason = (answer as { error?: unknown } | null)?.error
    throw new SetupRequestError('refused', typeof reason === 'string' ? reason : `The worker answered ${response.status} for ${url}.`)
  }
  return answer as T
}
const postJson = <T>(url: string, body: unknown) => workerJson<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** Whether this machine still has the funnel to go through. A worker without the endpoint (older) has nothing to show. */
export async function setupPending(): Promise<boolean> {
  const response = await fetch('/api/setup/state', { cache: 'no-store' })
  if (!response.ok) return false
  const state = await response.json() as WorkerSetupState
  return hasPendingInstallSetup(state)
}

const toScanView = (scan: WorkerScanState): SetupScanView => ({
  agents: scan.agents.map(({ id, label, detected, prompts, uploadBytes }) => ({
    // Agent login is irrelevant to hosted setup; the transcript scan only reports which tools were found.
    id, label, detected, prompts, canRunSetup: null, cannotRunReason: null, uploadBytes: uploadBytes ?? 0,
  })),
  percent: scan.percent, phase: scan.phase, done: scan.done, error: scan.error, improveProduct: scan.improveProduct ?? true,
  uploadedAgents: scan.uploadedAgents ?? null, hostedNotice: scan.hostedNotice ?? null,
})

// Keep rapid checkbox changes in click order; scan and upload never wait on this queue.
let preferenceWrite: Promise<unknown> = Promise.resolve()
let desiredImproveProduct: boolean | undefined
let appliedImproveProduct: boolean | undefined
let preferenceReady: Promise<void> = Promise.resolve()
let retryLocalScan: (() => Promise<void>) | null = null
let acknowledgeInstallConnection: (() => void) | null = null
/** Sends an import start or stop and shows the worker's answer (set while the page is subscribed). */
let sendImportRequest: ((url: string) => Promise<void>) | null = null
const askImport = async (url: string) => { if (sendImportRequest) await sendImportRequest(url); else await postJson(url, {}) }

/**
 * The local worker: the prompt scan (started here when it has not run, then followed on the work view's event
 * stream), the 30-day token usage that scan sums, the setup state, and the Reveal's sets from the work view snapshot. Search and import land in funnel
 * Phases 9-10; until then those parts stay empty.
 */
export const localSetupSource: SetupSource = {
  kind: 'local',
  subscribe(onData) {
    let data = EMPTY_SETUP_DATA
    let closed = false
    let scanRevision = 0
    let stateRevision = 0
    let importRevision = 0
    let ready!: () => void
    preferenceReady = new Promise<void>((resolve) => { ready = resolve })
    const publish = (changes: Partial<SetupData>) => { if (closed) return; data = { ...data, ...changes }; onData(data) }
    const applyScan = (scan: WorkerScanState) => {
      scanRevision++
      appliedImproveProduct = scan.improveProduct ?? true
      publish({
        scan: toScanView(scan),
        usage: scan.usage ? toSetupUsage(scan.usage) : null,
        recentPrompts: scan.recentPrompts ?? [],
        // Finish Setup pre-ticks the tools the scan found on this machine.
        detectedTools: scan.agents.filter((agent) => agent.detected).map((agent) => agent.id).filter((id) => SETUP_TOOLS.some((tool) => tool.id === id)),
      })
    }
    const applyState = (state: WorkerSetupState) => {
      stateRevision++
      publish({
      connectionError: null,
      connectionErrorKind: null,
      choice: state.choice ?? null,
      install: state.install ?? null,
      alreadyPro: state.alreadyPro,
      checkout: state.checkout ? { state: state.checkout.state, error: state.checkout.error } : null,
      installer: state.installer ? { stage: state.installer.stage, error: state.installer.error } : null,
      // Nothing to bring along on a new install: the import offer stays hidden.
      history: state.history && state.history.observations > 0 ? state.history : null,
      historyImport: toHistoryImport(state.historyImport),
      })
      void ensureScanStarted()
    }
    // The upload's own words, its `setup-import` frames and a request's answer, count, so an older answer never wins.
    // The worker sends such a frame for every change, the one a request makes included, so dropping an answer that a
    // frame overtook loses nothing. A `setup-state` frame does not count: it copies the upload as it was whenever the
    // setup state was written, which can be before the request was sent, so a start's answer must not lose to it.
    const applyImport = (run: WorkerHistoryImport | null | undefined) => {
      importRevision++
      publish({ historyImport: toHistoryImport(run) })
    }
    // Goals, work and rules land in the work view snapshot as the extraction saves each one.
    const applySnapshot = (snapshot: SnapshotWithSetup) => {
      const extraction = snapshot.setup?.extraction ?? null
      const goals = snapshot.goals ? [...snapshot.goals.areas, ...snapshot.goals.asks].map((item) => item.title) : []
      publish({
        reveal: revealFromSnapshot(snapshot),
        extraction: extraction && { state: extraction.state, step: extraction.step },
        // "What's next?" chips: the person's own goals and open asks.
        suggestions: [...new Set(goals)].slice(0, 4),
      })
    }
    onData(data)
    const stream = new EventSource('/api/work-view/events')
    // A frame that is not a JSON object is skipped with a warning, not thrown:
    // these listeners run outside React's error boundaries (see parseSseFrame).
    const onFrame = <T>(event: Event, apply: (frame: T) => void, isShaped: (frame: Record<string, unknown>) => boolean = () => true): void => {
      applySseFrame(event.type, (event as MessageEvent<string>).data, apply, isShaped)
    }
    // applyScan reads scan.agents, so a scan frame without that list is skipped.
    stream.addEventListener('setup-scan', (event) => onFrame<WorkerScanState>(event, applyScan, (frame) => Array.isArray(frame.agents)))
    stream.addEventListener('setup-state', (event) => onFrame<WorkerSetupState>(event, applyState))
    stream.addEventListener('setup-import', (event) => onFrame<WorkerHistoryImport>(event, applyImport))
    stream.addEventListener('work-view', (event) => onFrame<SnapshotWithSetup>(event, applySnapshot, (frame) =>
      Array.isArray(frame.humanRequests) && Array.isArray(frame.agents)
      && typeof (frame.source as { connected?: unknown } | null)?.connected === 'boolean'))
    const startScan = async () => {
      const revision = scanRevision
      const started = await postJson<WorkerScanState>('/api/setup/scan', desiredImproveProduct === undefined ? {} : { improveProduct: desiredImproveProduct })
      if (!closed && scanRevision === revision) applyScan(started)
    }
    let initialScanLoaded = false
    let startingScan = false
    const ensureScanStarted = async () => {
      if (!initialScanLoaded || startingScan || closed || data.scan.phase !== 'idle'
        || data.install === undefined || (data.install && data.install.status !== 'ready')) return
      startingScan = true
      try { await startScan() }
      catch (error) {
        const failure = toSetupFailure(error)
        if (!closed) publish({ scan: { ...data.scan, phase: 'failed', error: failure.detail, errorKind: failure.kind } })
      }
      finally { startingScan = false }
    }
    const acknowledgeConnection = () => {
      publish({ connectionError: null, connectionErrorKind: null })
      void ensureScanStarted()
    }
    acknowledgeInstallConnection = acknowledgeConnection
    // Retrying may repeat hosted extraction, so only the page's explicit action invokes this.
    retryLocalScan = startScan
    // The answer is the run as the worker held it when it took the request, so the page knows at once that the upload
    // runs or stopped, whichever of the answer and the event stream arrives first. An upload frame after the request is
    // at least as new (above).
    const importRequest = async (url: string) => {
      const revision = importRevision
      const answer = await postJson<WorkerHistoryImport>(url, {})
      if (!closed && importRevision === revision) applyImport(answer)
    }
    sendImportRequest = importRequest
    let requestedAtRevision = scanRevision
    const requestedStateRevision = stateRevision
    void (async () => {
      const [scan, state] = await Promise.all([workerJson<WorkerScanState>('/api/setup/scan'), workerJson<WorkerSetupState>('/api/setup/state')])
      if (closed) return
      if (stateRevision === requestedStateRevision) applyState(state)
      // The event stream can advance while GET or POST is in flight. Never restore an older phase or preference.
      if (scanRevision === requestedAtRevision) applyScan(scan)
      initialScanLoaded = true
      requestedAtRevision = scanRevision
      // A failed installer connection is not a failed scan. Keep the actual scan
      // state so an explicit retry can continue as soon as installation is ready.
      if (hasPendingInstallSetup(state)) {
        try { await postJson('/api/setup/resume', {}) }
        catch (error) {
          const failure = toSetupFailure(error)
          if (!closed) publish({ connectionError: failure.detail, connectionErrorKind: failure.kind })
        }
      }
      await ensureScanStarted()
    })().catch((error: unknown) => {
      // A late startup error must not replace progress or results already received from the stream.
      if (!closed && (scanRevision === requestedAtRevision || data.scan.phase === 'idle')) {
        const failure = toSetupFailure(error)
        // The page shows this once: in the stopped scan when the scan screen is up, otherwise above the heading.
        // `install` stays as the worker last said (undefined when it never answered): the page shows the stopped scan
        // without claiming the installation finished.
        publish({ connectionError: failure.detail, connectionErrorKind: failure.kind, scan: { ...data.scan, phase: 'failed', error: failure.detail, errorKind: failure.kind } })
      }
    }).finally(ready)
    return () => {
      closed = true
      if (retryLocalScan === startScan) retryLocalScan = null
      if (acknowledgeInstallConnection === acknowledgeConnection) acknowledgeInstallConnection = null
      if (sendImportRequest === importRequest) sendImportRequest = null
      stream.close()
      ready()
    }
  },
  async resume() { await postJson('/api/setup/resume', { retry: true }); acknowledgeInstallConnection?.() },
  async configureInstall(selection) { await postJson('/api/setup/install', selection); acknowledgeInstallConnection?.() },
  async retryScan() {
    // Nothing was sent: the page has no connection to start from, so its words are the page's own (reload).
    if (!retryLocalScan) throw new SetupRequestError('page', 'The setup page is not connected to the worker. Reload it to try again.')
    await retryLocalScan()
  },
  async setImproveProduct(improveProduct) {
    desiredImproveProduct = improveProduct
    const initialized = preferenceReady
    const write = preferenceWrite.then(async () => {
      // Buffer early clicks until GET/start establishes the scan. It starts with the latest choice
      // immediately; an older preference request must not arrive later and overwrite that choice.
      await initialized
      // Start may already have accepted this value; a redundant POST after upload would report a false failure.
      if (desiredImproveProduct === improveProduct && appliedImproveProduct !== improveProduct) {
        const scan = await postJson<WorkerScanState>('/api/setup/scan/preferences', { improveProduct })
        appliedImproveProduct = scan.improveProduct ?? improveProduct
      }
    })
    preferenceWrite = write.catch(() => {})
    await write
  },
  async confirmUpload(upload, agents, improveProduct) { await postJson('/api/setup/scan/consent', { upload, ...(agents ? { agents } : {}), ...(improveProduct === undefined ? {} : { improveProduct }) }) },
  async choose(choice) { await postJson('/api/setup/choice', choice) },
  async checkout() { await postJson('/api/setup/checkout', {}) },
  async complete(tools, telemetry) { await postJson('/api/setup/complete', { tools, ...(telemetry?.length ? { telemetry } : {}) }) },
  async startHistoryImport() { await askImport('/api/setup/import') },
  async stopHistoryImport() { await askImport('/api/setup/import/stop') },
  async search(query) { return toMemoryResults(await workerJson<WorkerSearchResult>(searchUrl(query))) },
  async keepNote(record, text) {
    const saved = await postJson<{ success?: boolean; id?: unknown; reason?: unknown }>('/api/memory/save', noteFor(record, text))
    // The worker answered, but without a saved note: a refusal in the page's words.
    if (saved.success !== true || typeof saved.id !== 'number') throw new SetupRequestError('refused', `The note was not saved${typeof saved.reason === 'string' ? `: ${saved.reason}` : '.'}`)
    return saved.id
  },
  async forgetNote(id) { await workerJson(`/api/observation/${id}`, { method: 'DELETE' }) },
}

/** D6 plan prices, in cents. Plan prices only, never per-run spend. */
export const PLAN = { name: 'CMEM Pro', monthlyCents: 3000, cloudSyncCents: 1200 } as const

export const CMEM_MCP_URL = 'https://cmem.ai/api/mcp'

/** Finish Setup tools. Names, descriptions and steps come from the PROTO workspace tool list and CONNECTOR-EVIDENCE.md. */
export interface SetupTool {
  id: string
  name: string
  /** Local tools capture work on this machine; cloud readers only exist with On The Go. */
  kind: 'local' | 'cloud'
  /** Already configured by the install step; shown as connected in Finish Setup. */
  installed?: boolean
  steps?: string[]
  commands?: string[]
  guide?: { href: string; label: string }
}
export const SETUP_TOOLS: SetupTool[] = [
  { id: 'claude-code', name: 'Claude Code', kind: 'local', commands: ['claude mcp add --transport http --scope user cmem https://cmem.ai/api/mcp', 'claude mcp login cmem', 'claude mcp list'], guide: { href: 'https://code.claude.com/docs/en/mcp', label: 'Claude Code connection guide' } },
  { id: 'claude-ai', name: 'Claude.ai', kind: 'cloud', steps: ['Open Customize, then Connectors, and choose + Add.', 'Choose Add custom connector, name it CMEM, paste the URL, and continue.', 'Complete the OAuth sign-in and add the connector. Enable it in a chat from +, then Connectors.'], guide: { href: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp', label: 'Claude connection guide' } },
  { id: 'codex', name: 'Codex CLI', kind: 'local', commands: ['codex mcp add cmem --url https://cmem.ai/api/mcp', 'codex mcp login cmem', 'codex mcp list'], guide: { href: 'https://learn.chatgpt.com/docs/extend/mcp', label: 'Codex connection guide' } },
  { id: 'gemini-cli', name: 'Gemini CLI', kind: 'cloud', steps: ['Add CMEM as a remote HTTP MCP server.', 'Authenticate CMEM inside Gemini CLI, then check the available tools.'], commands: ['gemini mcp add --transport http --scope user cmem https://cmem.ai/api/mcp', '/mcp auth cmem', '/mcp list'], guide: { href: 'https://geminicli.com/docs/tools/mcp-server/', label: 'Gemini CLI connection guide' } },
  { id: 'chatgpt', name: 'ChatGPT', kind: 'cloud', steps: ['Open ChatGPT Plugins and choose +, then Add custom MCP server.', 'Paste the CMEM URL, choose OAuth, and create the plugin.', 'Review the available tools, install the plugin, then @mention it in a chat.'], guide: { href: 'https://developers.openai.com/plugins/deploy/connect-chatgpt', label: 'ChatGPT connection guide' } },
]

/** The install selection is authoritative; cloud readers remain an optional next step. */
export function setupToolsForInstall(install: SetupInstallState | null | undefined): SetupTool[] {
  if (!install?.selection) return SETUP_TOOLS
  const local = install.catalog.agents.filter(agent => install.selection!.agents.includes(agent.id)).map((agent): SetupTool => ({
    id: agent.id, name: agent.label, kind: 'local', installed: true,
  }))
  return [...local, ...SETUP_TOOLS.filter(tool => tool.kind === 'cloud')]
}
