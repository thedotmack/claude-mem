// Review fixtures for the funnel screens. Loaded only by a dynamic import when the page has `?source=sample`;
// nothing else imports this file. Invented work for a made-up person; no real prompts, usage or history.
// `&sample=new` shows a new install (no claude-mem history: no efficiency percent, no import step).
// `&scan=<percent>` holds the scan at that percent, for screenshots.
// `&usage=partial|none` shows an incomplete or missing usage history (default: a complete 30-day window).
import type { MemoryResult, SetupData, SetupSource } from './setup-data'
import { toSetupUsage, type SetupScanUsage } from './setup-usage'

const SCAN_MS = 8000
const REVEAL_GAP_MS = 900
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

function sampleData(newInstall: boolean, usage: SampleUsage, waitingForAgent: boolean): SetupData {
  return {
    scan: { agents: [], percent: 0, phase: 'reading', done: false, error: null, improveProduct: true },
    reveal: { goals: null, work: null, rules: null },
    extraction: waitingForAgent ? { state: 'waiting-for-agent', step: null } : null,
    recentPrompts: RECENT_PROMPTS,
    checkout: null,
    installer: null,
    usage: toSetupUsage(sampleUsage(usage, newInstall)),
    alreadyPro: false,
    detectedTools: ['claude-code', 'codex', 'chatgpt'],
    history: newInstall ? null : { projects: 3, sessions: 24, observations: 128 },
    historyImport: null,
    suggestions: GOALS!.map((goal) => goal.title),
  }
}

/** Plays the scan, then lands Goals, Work and Rules one after another, as the live screen will. */
export function createSampleSetupSource(newInstall: boolean, holdScanAtPercent: number | null, usage: SampleUsage = 'complete', waitingForAgent = false): SetupSource {
  let data = sampleData(newInstall, usage, waitingForAgent)
  const listeners = new Set<(data: SetupData) => void>()
  const publish = (changes: Partial<SetupData>) => { data = { ...data, ...changes }; for (const listener of listeners) listener(data) }
  let playing = false
  const play = () => {
    playing = true
    const started = Date.now()
    const timer = setInterval(() => {
      const share = Math.min(holdScanAtPercent === null ? 1 : holdScanAtPercent / 100, (Date.now() - started) / SCAN_MS)
      const agents = AGENTS.filter((agent) => share >= agent.detectAt).map((agent) => ({
        id: agent.id, label: agent.label, detected: true, canRunSetup: true, cannotRunReason: null,
        prompts: Math.round(agent.prompts * Math.min(1, (share - agent.detectAt) / (0.9 - agent.detectAt))),
      }))
      const done = share === 1
      if (holdScanAtPercent !== null && share === holdScanAtPercent / 100) clearInterval(timer)
      publish({ scan: { ...data.scan, agents, percent: Math.floor(share * 100), phase: done ? 'done' : share < 0.5 ? 'reading' : share < 0.95 ? 'checking' : 'saving', done, error: null } })
      if (!done) return
      clearInterval(timer)
      if (waitingForAgent) return
      setTimeout(() => publish({ reveal: { ...data.reveal, goals: GOALS } }), REVEAL_GAP_MS)
      setTimeout(() => publish({ reveal: { ...data.reveal, work: WORK } }), REVEAL_GAP_MS * 2)
      setTimeout(() => publish({ reveal: { ...data.reveal, rules: RULES } }), REVEAL_GAP_MS * 3)
    }, TICK_MS)
  }
  return {
    kind: 'sample',
    subscribe(onData) {
      listeners.add(onData)
      onData(data)
      if (!playing) play()
      return () => listeners.delete(onData)
    },
    async retryScan() { if (!playing) play() },
    async setImproveProduct(improveProduct) { publish({ scan: { ...data.scan, improveProduct } }) },
    // Review fixtures hand nothing to an installer.
    async choose() {},
    // Plays the checkout the terminal would open: waiting, then paid.
    async checkout() {
      publish({ checkout: { state: 'waiting', error: null } })
      setTimeout(() => publish({ checkout: { state: 'paid', error: null } }), 1500)
    },
    async complete() {},
    async startHistoryImport() {
      const started = Date.now()
      const timer = setInterval(() => {
        const percent = Math.min(100, Math.floor(((Date.now() - started) / IMPORT_MS) * 100))
        publish({ historyImport: { percent, done: percent === 100, imported: Math.round((data.history?.observations ?? 0) * percent / 100), error: null } })
        if (percent === 100) clearInterval(timer)
      }, TICK_MS)
    },
    async keepNote() { return 0 },
    async forgetNote() {},
    async search(query) {
      const words = query.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 3) ?? []
      return RECORDS.filter((record) => words.some((word) => `${record.title} ${record.body} ${record.project} ${record.session}`.toLowerCase().includes(word)))
    },
  }
}
