// Review fixtures for the funnel screens. Loaded only by a dynamic import when the page has `?source=sample`;
// nothing else imports this file. Invented work for a made-up person; no real prompts, usage or history.
// `&sample=new` shows a new install (no claude-mem history: no efficiency percent, no import step).
// `&scan=<percent>` holds the scan at that percent, for screenshots.
import type { MemoryResult, SetupData, SetupSource } from './setup-data'

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

function sampleData(newInstall: boolean): SetupData {
  return {
    scan: { agents: [], percent: 0, phase: 'reading', done: false, error: null },
    reveal: { goals: null, work: null, rules: null },
    usage: { periodLabel: 'Last 30 days · Claude Code · Codex · Gemini CLI', tokens: 84_600_000, persona: 'Heavy AI User', efficiencyPercent: newInstall ? null : 50 },
    alreadyPro: false,
    detectedTools: ['claude-code', 'codex', 'chatgpt'],
    history: newInstall ? null : { projects: 3, sessions: 24, observations: 128 },
    historyImport: null,
    suggestions: GOALS!.map((goal) => goal.title),
  }
}

/** Plays the scan, then lands Goals, Work and Rules one after another, as the live screen will. */
export function createSampleSetupSource(newInstall: boolean, holdScanAtPercent: number | null): SetupSource {
  let data = sampleData(newInstall)
  const listeners = new Set<(data: SetupData) => void>()
  const publish = (changes: Partial<SetupData>) => { data = { ...data, ...changes }; for (const listener of listeners) listener(data) }
  let playing = false
  const play = () => {
    playing = true
    const started = Date.now()
    const timer = setInterval(() => {
      const share = Math.min(holdScanAtPercent === null ? 1 : holdScanAtPercent / 100, (Date.now() - started) / SCAN_MS)
      const agents = AGENTS.filter((agent) => share >= agent.detectAt).map((agent) => ({
        id: agent.id, label: agent.label, detected: true,
        prompts: Math.round(agent.prompts * Math.min(1, (share - agent.detectAt) / (0.9 - agent.detectAt))),
      }))
      const done = share === 1
      if (holdScanAtPercent !== null && share === holdScanAtPercent / 100) clearInterval(timer)
      publish({ scan: { agents, percent: Math.floor(share * 100), phase: done ? 'done' : share < 0.5 ? 'reading' : share < 0.95 ? 'checking' : 'saving', done, error: null } })
      if (!done) return
      clearInterval(timer)
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
    startHistoryImport() {
      const started = Date.now()
      const timer = setInterval(() => {
        const percent = Math.min(100, Math.floor(((Date.now() - started) / IMPORT_MS) * 100))
        publish({ historyImport: { percent, done: percent === 100 } })
        if (percent === 100) clearInterval(timer)
      }, TICK_MS)
    },
    async search(query) {
      const words = query.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 3) ?? []
      return RECORDS.filter((record) => words.some((word) => `${record.title} ${record.body} ${record.project} ${record.session}`.toLowerCase().includes(word)))
    },
  }
}
