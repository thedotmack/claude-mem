// Review fixtures for the funnel screens. Loaded only by a dynamic import when the page has `?source=sample`;
// nothing else imports this file. Invented work for a made-up person; no real prompts, usage or history.
// `&sample=new` shows a new install (no claude-mem history: no efficiency percent, no import step).
// `&scan=<percent>` holds the scan at that percent, for screenshots.
// `&usage=partial|none` shows an incomplete or missing usage history (default: a complete 30-day window).
// `&scan=consent|failed` stops the scan at the upload question or at a failure (each retry or answer then goes on).
// `&fail=install|checkout|import|installer|choice|stop` makes that hand-off fail once, so its error can be seen; the retry
// works. `choice` is the worker refusing the storage choice and `stop` is Stop import getting no answer (hand-off alerts);
// `import` is cmem.ai refusing the run's last batch; the others are reports from the installer.
// `&installer=on` plays the installer applying the storage choice, as the terminal does, so the choice locks after it.
// `&import=running` plays a page reloaded while an import runs: the worker already reports one running, held after its
// first batch until the person stops it, for screenshots of Finish Setup's "An import is already running.".
import { SetupRequestError, type HistoryImportProgress, type MemoryResult, type SetupChoice, type SetupData, type SetupSource } from './setup-data'
import type { InstallerStage } from './setup-flow'
import { toSetupUsage, type SetupScanUsage } from './setup-usage'
import { SAMPLE_REQUESTS } from '../data'
import { SAMPLE_FOCUS_AREAS } from '../data-goals'
import { HISTORY_IMPORT_BATCH, historyImportRunning } from '../../../../shared/setup-funnel.ts'

const SCAN_MS = 8000
/**
 * How long the sample takes to answer an install, a scan retry or a Stop import: a real one waits for the worker, so
 * "Starting again…" (and the dimmed "Skip the scan" beside it), "Installing…" and "Stopping…" can be seen and checked.
 * Sample only.
 */
const ANSWER_MS = 1200
const REVEAL_GAP_MS = 900
/**
 * How long a whole sample import runs, shared evenly by its batches (two for the sample's 128 memories, 1.8 s each):
 * long enough to see the import screen and press Stop while the first batch is on its way, short enough for the
 * browser walks. Sample only.
 */
const IMPORT_MS = 3600
const TICK_MS = 160

const AGENTS = [
  { id: 'claude-code', label: 'Claude Code', prompts: 412, detectAt: 0.04 },
  { id: 'codex', label: 'Codex', prompts: 186, detectAt: 0.22 },
  { id: 'gemini-cli', label: 'Gemini CLI', prompts: 23, detectAt: 0.46 },
]

const GOALS: SetupData['reveal']['goals'] = [
  { id: 'g1', rank: 1, title: 'Ship the new onboarding flow before the beta invites go out', timesAsked: 9, latestAt: '10-21 17:42' },
  { id: 'g2', rank: 2, title: 'Make the invoice export match what accounting already uses', timesAsked: 5, latestAt: '10-19 11:05' },
  { id: 'g3', rank: 3, title: 'Keep the mobile app fast on older phones', timesAsked: 3, latestAt: '10-14 09:30' },
]
const WORK: SetupData['reveal']['work'] = [
  { id: 'w1', title: 'Rebuild the signup screens with the new copy', agent: 'claude', lastActiveAt: '10-21 17:42' },
  { id: 'w2', title: 'Add CSV and QuickBooks formats to invoice export', agent: 'codex', lastActiveAt: '10-19 11:05' },
  { id: 'w3', title: 'Find why the feed stutters on scroll', agent: 'gemini', lastActiveAt: '10-14 09:30' },
]
const RULES: SetupData['reveal']['rules'] = [
  { id: 'r1', text: 'Run the tests before saying something is done.', quote: 'always run the tests before you tell me it works', quotedAt: '10-20 15:12' },
  { id: 'r2', text: 'Keep pull requests small and focused on one change.', quote: 'one change per PR, please', quotedAt: '10-17 10:48' },
  { id: 'r3', text: 'Never add a new dependency without asking.', quote: 'never pull in a new package without checking with me', quotedAt: '10-12 16:03' },
]

const RECORDS: MemoryResult[] = [
  { id: 'm1', title: 'Signup screens ready for review', body: 'The three signup screens use the new copy. The email step now validates on blur, and the beta invite link opens straight into step two.', project: 'Onboarding', agent: 'Claude Code', session: 'Signup rebuild', date: '2026-10-21' },
  { id: 'm2', title: 'Invoice export formats decided', body: 'We chose CSV plus the QuickBooks IIF format. Accounting confirmed the column order; the export button ships behind a flag first.', project: 'Billing', agent: 'Codex', session: 'Invoice export', date: '2026-10-19' },
  { id: 'm3', title: 'Feed stutter traced to image decoding', body: 'Large thumbnails were decoded on the main thread. Moving decoding off the main thread brought scrolling back to 60 fps on the test phone.', project: 'Mobile app', agent: 'Gemini CLI', session: 'Feed performance', date: '2026-10-14' },
]

export type SampleUsage = 'complete' | 'partial' | 'none'
/** Where `&scan=` stops the sample scan instead of finishing it. */
export type SampleScanStop = 'consent' | 'failed'
/** Which hand-off `&fail=` makes fail once. */
export type SampleFailure = 'install' | 'checkout' | 'import' | 'installer' | 'choice' | 'stop'
/** Invented failure words for the sample, shaped like the worker's own. */
const SAMPLE_FAILURE_WORDS: Record<SampleFailure | 'scan', string> = {
  scan: 'Hosted setup failed (HTTP 503): The anonymous daily budget has been reached.',
  install: 'Cursor configuration could not be saved.',
  checkout: 'The checkout tab was closed before the card was added.',
  import: 'cmem.ai refused the import (HTTP 503).',
  installer: 'The setup program stopped (exit 1). Retry setup in this page, or run npx claude-mem install --setup browser.',
  choice: 'The installer is not waiting for a storage choice yet.',
  // The browser's words when no answer came (a worker that is restarting): the one way a Stop fails while the import runs.
  stop: 'Failed to fetch',
}
/** The worker's answer to a Stop that comes after the import ended (WorkViewRoutes.ts stopHistoryImport). */
const NOTHING_TO_STOP = 'No import is running, so there is nothing to stop.'

/** What the sample installer reports once it has applied a storage choice (the stages the real one reports). */
const appliedStage = (branch: SetupChoice['branch'], alreadyPro: boolean): InstallerStage =>
  branch === 'home' ? 'home-ready' : alreadyPro ? 'go-kept-existing-pro' : 'go-awaiting-checkout'

function sampleUsage(kind: SampleUsage, newInstall: boolean): SetupScanUsage {
  const agents = [
    { id: 'claude-code', label: 'Claude Code', detected: true, recordsTokens: true, tokens: kind === 'none' ? 0 : 61_200_000 },
    { id: 'codex', label: 'Codex', detected: true, recordsTokens: true, tokens: kind === 'none' ? 0 : 23_400_000 },
  ]
  const totalTokens = agents.reduce((sum, agent) => sum + agent.tokens, 0)
  return { windowDays: 30, agents, totalTokens, coverage: kind, persona: kind === 'complete' ? 'Heavy AI User' : null, efficiencyPercent: newInstall ? null : 50 }
}

/** Invented prompts for the waiting-for-agent Reveal (`&agent=none`). */
const RECENT_PROMPTS = [
  { agent: 'claude-code', at: '2026-10-21T17:42:00.000Z', text: 'make the signup screens use the new copy and keep the old layout' },
  { agent: 'codex', at: '2026-10-19T11:05:00.000Z', text: 'add CSV and QuickBooks formats to the invoice export' },
  { agent: 'claude-code', at: '2026-10-14T09:30:00.000Z', text: 'the mobile list is slow on my old phone, find out why' },
]

function sampleData(newInstall: boolean, usage: SampleUsage, waitingForAgent: boolean, fail: SampleFailure | undefined, installer: boolean): SetupData {
  return {
    connectionError: null,
    connectionErrorKind: null,
    choice: null,
    install: {
      status: 'waiting', selection: null, error: null,
      catalog: {
        agents: [
          { id: 'claude-code', label: 'Claude Code', hint: 'Recommended', detected: true },
          { id: 'codex-cli', label: 'Codex CLI', hint: 'Native hooks integration', detected: true },
          { id: 'cursor', label: 'Cursor', hint: 'Hooks and MCP integration', detected: true },
          { id: 'opencode', label: 'OpenCode', hint: 'Plugin integration', detected: false },
          { id: 'openclaw', label: 'OpenClaw', hint: 'Plugin integration', detected: false },
          { id: 'hermes', label: 'Hermes Agent', hint: 'Memory provider and MCP search', detected: false },
        ],
        skills: [
          { id: 'how-it-works', label: 'How it works', description: 'Understand how claude-mem remembers your work.', required: true },
          { id: 'make-plan', label: 'Make a plan', description: 'Turn a task into an implementation plan.' },
          { id: 'do', label: 'Execute a plan', description: 'Carry out an implementation plan with agents.' },
          { id: 'mem-search', label: 'Memory search', description: 'Recall decisions from previous sessions.' },
        ],
        defaults: { agents: ['claude-code', 'codex-cli', 'cursor'], skills: ['how-it-works', 'make-plan', 'do', 'mem-search'], installClaudeCode: false, disableAutoMemory: false, telemetryEnabled: true, claudeModel: 'haiku' },
        reinstall: !newInstall,
      },
    },
    scan: { agents: [], percent: 0, phase: 'reading', done: false, error: null, improveProduct: true, uploadedAgents: null },
    reveal: { goals: null, work: null, rules: null, focusAreas: null, requests: [] },
    extraction: waitingForAgent ? { state: 'waiting-for-agent', step: null } : null,
    recentPrompts: RECENT_PROMPTS,
    checkout: null,
    installer: fail === 'installer' ? { stage: 'failed', error: SAMPLE_FAILURE_WORDS.installer } : installer ? { stage: 'waiting-for-choice', error: null } : null,
    usage: toSetupUsage(sampleUsage(usage, newInstall)),
    alreadyPro: false,
    detectedTools: ['claude-code', 'codex', 'chatgpt'],
    history: newInstall ? null : { projects: 3, sessions: 24, observations: 128 },
    historyImport: null,
    suggestions: GOALS!.map((goal) => goal.title),
  }
}

/**
 * Where `&scan=failed` stops, in percent: partway, so the stopped screen shows a partly filled bar and the scan has found
 * two of its three tools (Gemini's detectAt is 0.46).
 */
const SAMPLE_FAIL_AT_PERCENT = 40

/** Plays the scan, then lands Goals, Work and Rules one after another, as the live screen will. */
export function createSampleSetupSource(newInstall: boolean, holdScanAtPercent: number | null, usage: SampleUsage = 'complete', waitingForAgent = false,
  { scanStop, fail, installer = false, importRunning = false }: { scanStop?: SampleScanStop; fail?: SampleFailure; installer?: boolean; importRunning?: boolean } = {}): SetupSource {
  let data = sampleData(newInstall, usage, waitingForAgent, fail, installer)
  const listeners = new Set<(data: SetupData) => void>()
  const publish = (changes: Partial<SetupData>) => { data = { ...data, ...changes }; for (const listener of listeners) listener(data) }
  // The history upload, played the way the worker reports it (history-import.ts): whole batches of HISTORY_IMPORT_BATCH,
  // `sent` counting every memory cmem.ai answered for and `skipped` the ones it already had.
  const historyTotal = data.history?.observations ?? 0
  /** The batch the upload sends next: a full one, or what is left. */
  const nextBatch = (sent: number) => Math.min(HISTORY_IMPORT_BATCH, historyTotal - sent)
  /** The worker's percent while it runs: from what was answered for, held under 100 until the run is done. */
  const runningPercent = (sent: number) => historyTotal ? Math.min(99, Math.floor((sent / historyTotal) * 100)) : 99
  // The sample's cmem.ai account: how many of the sample's memories it has, counted from the first, since the upload
  // sends them in order. A later run gets the ones already there back as skipped, as the worker does from cmem.ai.
  let inAccount = 0
  let importTimer: ReturnType<typeof setTimeout> | undefined
  if (importRunning && historyTotal) {
    // As a reload finds it: the first batch answered (cmem.ai wrote it) and the next one on its way, held there.
    const sent = nextBatch(0)
    inAccount = sent
    data = { ...data, historyImport: { state: 'running', percent: runningPercent(sent), imported: sent, skipped: 0, sent, total: historyTotal, error: null } }
  }
  // Each `&fail=` hand-off fails the first time only, so the retry can be seen working.
  const failing = new Set<SampleFailure>(fail ? [fail] : [])
  const failsOnce = (kind: SampleFailure) => failing.delete(kind)
  let stopAt = scanStop
  const land = () => {
    if (waitingForAgent) return
    setTimeout(() => publish({ reveal: { ...data.reveal, goals: GOALS, focusAreas: [...SAMPLE_FOCUS_AREAS] } }), REVEAL_GAP_MS)
    setTimeout(() => publish({ reveal: { ...data.reveal, work: WORK, requests: [...SAMPLE_REQUESTS] } }), REVEAL_GAP_MS * 2)
    setTimeout(() => publish({ reveal: { ...data.reveal, rules: RULES } }), REVEAL_GAP_MS * 3)
  }
  let playing = false
  const play = () => {
    playing = true
    const started = Date.now()
    const timer = setInterval(() => {
      const share = Math.min(holdScanAtPercent === null ? 1 : holdScanAtPercent / 100, (Date.now() - started) / SCAN_MS)
      const agents = AGENTS.filter((agent) => share >= agent.detectAt).map((agent) => ({
        id: agent.id, label: agent.label, detected: true, canRunSetup: true, cannotRunReason: null, uploadBytes: 0,
        prompts: Math.round(agent.prompts * Math.min(1, (share - agent.detectAt) / (0.9 - agent.detectAt))),
      }))
      if (stopAt === 'failed' && share * 100 >= SAMPLE_FAIL_AT_PERCENT) {
        clearInterval(timer)
        playing = false
        stopAt = undefined
        publish({ scan: { ...data.scan, agents, percent: Math.floor(share * 100), phase: 'failed', done: true, error: SAMPLE_FAILURE_WORDS.scan } })
        return
      }
      const done = share === 1
      if (holdScanAtPercent !== null && share === holdScanAtPercent / 100) clearInterval(timer)
      if (done && stopAt === 'consent') {
        clearInterval(timer)
        publish({ scan: { ...data.scan, agents, percent: 100, phase: 'awaiting-consent', done: false, error: null } })
        return
      }
      publish({ scan: { ...data.scan, agents, percent: Math.floor(share * 100), phase: done ? 'done' : share < 0.5 ? 'reading' : share < 0.95 ? 'checking' : 'saving', done, error: null } })
      if (!done) return
      clearInterval(timer)
      land()
    }, TICK_MS)
  }
  return {
    kind: 'sample',
    subscribe(onData) {
      listeners.add(onData)
      onData(data)
      if (!playing && data.install?.status === 'ready') play()
      return () => listeners.delete(onData)
    },
    async resume() { publish({ installer: installer ? { stage: 'waiting-for-choice', error: null } : null }) },
    async configureInstall(selection) {
      publish({ install: { ...data.install!, selection, status: 'installing', error: null } })
      setTimeout(() => {
        if (failsOnce('install')) { publish({ install: { ...data.install!, status: 'failed', error: SAMPLE_FAILURE_WORDS.install } }); return }
        publish({ install: { ...data.install!, status: 'ready' } })
        if (!playing) play()
      }, ANSWER_MS)
    },
    async retryScan() {
      await new Promise((resolve) => setTimeout(resolve, ANSWER_MS))
      if (!playing) play()
    },
    async confirmUpload(upload, agents) {
      publish({ scan: { ...data.scan, phase: 'done', done: true, percent: 100, uploadedAgents: upload ? agents ?? data.scan.agents.map((agent) => agent.id) : [] } })
      // Kept local: nothing was uploaded, so nothing lands.
      if (upload) land()
    },
    async setImproveProduct(improveProduct) { publish({ scan: { ...data.scan, improveProduct } }) },
    // Review fixtures hand nothing to an installer; with `&installer=on` the sample one applies the choice, as the
    // terminal does, which locks it (the page then offers no way back to change it).
    async choose(choice, openCheckout) {
      if (failsOnce('choice')) throw new SetupRequestError('refused', SAMPLE_FAILURE_WORDS.choice)
      publish({ choice, ...(installer ? { installer: { stage: appliedStage(choice.branch, data.alreadyPro), error: null } } : {}) })
      if (openCheckout) await this.checkout()
    },
    // Plays the checkout the terminal would open: waiting, then paid.
    async checkout() {
      publish({ checkout: { state: 'waiting', error: null } })
      const failed = failsOnce('checkout')
      setTimeout(() => publish({ checkout: failed ? { state: 'failed', error: SAMPLE_FAILURE_WORDS.checkout } : { state: 'paid', error: null } }), 1500)
    },
    async complete() {},
    async startHistoryImport() {
      // One run at a time, as the worker: a press while one runs (a reload found it) answers with that run.
      if (data.historyImport && historyImportRunning(data.historyImport.state)) return
      const failed = failsOnce('import')
      const batchMs = IMPORT_MS / Math.max(1, Math.ceil(historyTotal / HISTORY_IMPORT_BATCH))
      let run: HistoryImportProgress = { state: 'running', percent: 0, imported: 0, skipped: 0, sent: 0, total: historyTotal, error: null }
      // Running from the press, as the worker answers the start, so the page opens the import screen on it.
      publish({ historyImport: run })
      const answerBatch = () => {
        const sent = run.sent ?? 0
        const rows = nextBatch(sent)
        // `&fail=import`: cmem.ai refuses the run's last batch, so the failed run has sent part of the history.
        if (failed && sent + rows === historyTotal) {
          publish({ historyImport: { ...run, state: 'failed', error: SAMPLE_FAILURE_WORDS.import } })
          return
        }
        // cmem.ai skips the memories it already has (the first `inAccount`) and writes the rest.
        const skipped = Math.max(0, Math.min(inAccount, sent + rows) - sent)
        const answered = sent + rows
        inAccount = Math.max(inAccount, answered)
        const done = answered === historyTotal
        run = { ...run, state: done ? 'done' : 'running', sent: answered, imported: run.imported + rows - skipped, skipped: (run.skipped ?? 0) + skipped, percent: done ? 100 : runningPercent(answered) }
        publish({ historyImport: run })
        if (!done) importTimer = setTimeout(answerBatch, batchMs)
      }
      importTimer = setTimeout(answerBatch, batchMs)
    },
    // The worker takes a Stop the moment it arrives: the upload ends there, with what it sent and its batch on the way
    // unconfirmed, and the answer comes back after a round trip (ANSWER_MS), so "Stopping…" can be seen. An import that
    // already ended has nothing to stop, as the worker says. The sample's cmem.ai keeps the batch that was on its way (a
    // real one may or may not have saved it before the cancel reached it), so a Continue gets it back as skipped.
    async stopHistoryImport() {
      const roundTrip = () => new Promise((resolve) => setTimeout(resolve, ANSWER_MS))
      if (failsOnce('stop')) { await roundTrip(); throw new SetupRequestError('unreachable', SAMPLE_FAILURE_WORDS.stop) }
      const run = data.historyImport
      if (!run || !historyImportRunning(run.state)) { await roundTrip(); throw new SetupRequestError('refused', NOTHING_TO_STOP) }
      clearTimeout(importTimer)
      const onItsWay = nextBatch(run.sent ?? 0)
      inAccount = Math.max(inAccount, (run.sent ?? 0) + onItsWay)
      await roundTrip()
      publish({ historyImport: { ...run, state: 'stopped', unconfirmed: onItsWay || undefined } })
    },
    async keepNote() { return 0 },
    async forgetNote() {},
    async search(query) {
      const words = query.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 3) ?? []
      return RECORDS.filter((record) => words.some((word) => `${record.title} ${record.body} ${record.project} ${record.session}`.toLowerCase().includes(word)))
    },
  }
}
