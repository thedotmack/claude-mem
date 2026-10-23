// What the funnel screens show. Every screen reads it through props; nothing here is made up.
// The live source fills it from the worker (prompt scan, extraction, usage, setup state); `?source=sample` loads
// setup-sample.ts instead, and only then.
import type { AgentTool } from '@/data'
import { toSetupUsage, type SetupScanUsage, type SetupUsage } from './setup-usage'
import { revealFromSnapshot, type SnapshotWithSetup } from './setup-reveal'

/** Mirrors the worker's SetupScanState (src/services/prompt-import/setup-scan.ts), trimmed to what the screen shows. */
export interface SetupScanAgent { id: string; label: string; detected: boolean; prompts: number }
export type SetupScanPhase = 'idle' | 'reading' | 'checking' | 'saving' | 'done' | 'failed'
export interface SetupScanView { agents: SetupScanAgent[]; percent: number; phase: SetupScanPhase; done: boolean; error: string | null }
/** The owner's newest typed prompts, quoted as typed (SetupScanState.recentPrompts). */
export interface SetupRecentPrompt { agent: string; at: string; text: string }
/** The extraction run on the user's own logged-in agent (the worker's automatic refresh). */
export interface SetupExtraction { state: 'idle' | 'running' | 'ok' | 'failed' | 'waiting-for-agent'; step: 'goals' | 'work' | 'rules' | null }

export type { RevealGoal, RevealRule, RevealSets, RevealWork } from './setup-reveal'
import type { RevealSets } from './setup-reveal'

export type { Persona, SetupScanUsage, SetupUsage, UsageCoverage } from './setup-usage'

export interface SetupHistory { projects: number; sessions: number; observations: number }
export interface HistoryImportProgress { percent: number; done: boolean }

export interface MemoryResult { id: string; title: string; body: string; project: string; agent: string; session: string; date: string }

export interface SetupData {
  scan: SetupScanView
  reveal: RevealSets
  /** `null` until the worker reports a run. `waiting-for-agent`: no logged-in agent yet, so the Reveal shows prompts only. */
  extraction: SetupExtraction | null
  recentPrompts: SetupRecentPrompt[]
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
export interface SetupChoice { branch: 'home' | 'go'; memoryBilling: 'hosted' | 'existing' }

export interface SetupSource {
  readonly kind: 'local' | 'sample'
  subscribe(onData: (data: SetupData) => void): () => void
  /** Hands the storage choice to the installer waiting in the terminal (POST /api/setup/choice). */
  choose(choice: SetupChoice): Promise<void>
  /** Finishes setup for this machine; the terminal exits and the funnel does not show again (POST /api/setup/complete). */
  complete(): Promise<void>
  startHistoryImport(): void
  search(query: string): Promise<MemoryResult[]>
}

export const EMPTY_SETUP_DATA: SetupData = {
  scan: { agents: [], percent: 0, phase: 'idle', done: false, error: null },
  reveal: { goals: null, work: null, rules: null },
  extraction: null,
  recentPrompts: [],
  usage: null,
  alreadyPro: false,
  detectedTools: [],
  history: null,
  historyImport: null,
  suggestions: [],
}

/** The worker's answers, trimmed to what this file reads. */
interface WorkerScanState extends SetupScanView {
  agents: Array<SetupScanAgent & { fromMemory?: number; fromTranscripts?: number }>
  /** The 30-day token usage the same pass sums, once the scan is done. */
  usage?: SetupScanUsage | null
  recentPrompts?: SetupRecentPrompt[]
}
interface WorkerSetupState { status: 'pending' | 'complete'; alreadyPro: boolean }

async function workerJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init })
  let answer: unknown = null
  try { answer = await response.json() } catch { /* A body that isn't JSON leaves only the status to report. */ }
  if (!response.ok) {
    const reason = (answer as { error?: unknown } | null)?.error
    throw new Error(typeof reason === 'string' ? reason : `The worker answered ${response.status} for ${url}.`)
  }
  return answer as T
}
const postJson = <T>(url: string, body: unknown) => workerJson<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** Whether this machine still has the funnel to go through. A worker without the endpoint (older) has nothing to show. */
export async function setupPending(): Promise<boolean> {
  const response = await fetch('/api/setup/state', { cache: 'no-store' })
  if (!response.ok) return false
  return ((await response.json()) as WorkerSetupState).status === 'pending'
}

const toScanView = (scan: WorkerScanState): SetupScanView => ({
  agents: scan.agents.map(({ id, label, detected, prompts }) => ({ id, label, detected, prompts })),
  percent: scan.percent, phase: scan.phase, done: scan.done, error: scan.error,
})

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
    const publish = (changes: Partial<SetupData>) => { if (closed) return; data = { ...data, ...changes }; onData(data) }
    const applyScan = (scan: WorkerScanState) => publish({
      scan: toScanView(scan),
      usage: scan.usage ? toSetupUsage(scan.usage) : null,
      recentPrompts: scan.recentPrompts ?? [],
      // Finish Setup pre-ticks the tools the scan found on this machine.
      detectedTools: scan.agents.filter((agent) => agent.detected).map((agent) => agent.id).filter((id) => SETUP_TOOLS.some((tool) => tool.id === id)),
    })
    const applyState = (state: WorkerSetupState) => publish({ alreadyPro: state.alreadyPro })
    // Goals, work and rules land in the work view snapshot as the extraction saves each one.
    const applySnapshot = (snapshot: SnapshotWithSetup) => {
      const extraction = snapshot.setup?.extraction ?? null
      publish({ reveal: revealFromSnapshot(snapshot), extraction: extraction && { state: extraction.state, step: extraction.step } })
    }
    onData(data)
    const stream = new EventSource('/api/work-view/events')
    stream.addEventListener('setup-scan', (event) => applyScan(JSON.parse((event as MessageEvent<string>).data) as WorkerScanState))
    stream.addEventListener('setup-state', (event) => applyState(JSON.parse((event as MessageEvent<string>).data) as WorkerSetupState))
    stream.addEventListener('work-view', (event) => applySnapshot(JSON.parse((event as MessageEvent<string>).data) as SnapshotWithSetup))
    void (async () => {
      const [scan, state] = await Promise.all([workerJson<WorkerScanState>('/api/setup/scan'), workerJson<WorkerSetupState>('/api/setup/state')])
      applyState(state)
      applyScan(scan)
      if (scan.phase === 'idle') applyScan(await postJson<WorkerScanState>('/api/setup/scan', {}))
    })().catch((error: unknown) => publish({ scan: { ...data.scan, phase: 'failed', error: error instanceof Error ? error.message : String(error) } }))
    return () => { closed = true; stream.close() }
  },
  async choose(choice) { await postJson('/api/setup/choice', choice) },
  async complete() { await postJson('/api/setup/complete', {}) },
  startHistoryImport() { throw new Error('History import is not connected to the worker yet.') },
  search: async () => [],
}

/** D6 plan prices, in cents. Plan prices only; never a usage cost. */
export const PLAN = { name: 'CMEM Pro', monthlyCents: 3000, cloudSyncCents: 1200 } as const

export const CMEM_MCP_URL = 'https://cmem.ai/api/mcp'

/** Finish Setup tools. Names, descriptions and steps come from PROTO workspace-data.js and CONNECTOR-EVIDENCE.md. */
export interface SetupTool {
  id: string
  name: string
  /** Local tools capture work on this machine; cloud readers only exist with On The Go. */
  kind: 'local' | 'cloud'
  mark: 'terminal' | 'codex' | 'chatgpt' | 'claude' | 'gemini'
  steps?: string[]
  commands?: string[]
  guide: { href: string; label: string }
}
export const SETUP_TOOLS: SetupTool[] = [
  { id: 'claude-code', name: 'Claude Code', kind: 'local', mark: 'terminal', commands: ['claude mcp add --transport http --scope user cmem https://cmem.ai/api/mcp', 'claude mcp login cmem', 'claude mcp list'], guide: { href: 'https://code.claude.com/docs/en/mcp', label: 'Claude Code connection guide' } },
  { id: 'claude-ai', name: 'Claude.ai', kind: 'cloud', mark: 'claude', steps: ['Open Customize, then Connectors, and choose + Add.', 'Choose Add custom connector, name it CMEM, paste the URL, and continue.', 'Complete the OAuth sign-in and add the connector. Enable it in a chat from +, then Connectors.'], guide: { href: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp', label: 'Claude connection guide' } },
  { id: 'codex', name: 'Codex CLI', kind: 'local', mark: 'codex', commands: ['codex mcp add cmem --url https://cmem.ai/api/mcp', 'codex mcp login cmem', 'codex mcp list'], guide: { href: 'https://learn.chatgpt.com/docs/extend/mcp', label: 'Codex connection guide' } },
  { id: 'gemini-cli', name: 'Gemini CLI', kind: 'cloud', mark: 'gemini', steps: ['Add CMEM as a remote HTTP MCP server.', 'Authenticate CMEM inside Gemini CLI, then check the available tools.'], commands: ['gemini mcp add --transport http --scope user cmem https://cmem.ai/api/mcp', '/mcp auth cmem', '/mcp list'], guide: { href: 'https://geminicli.com/docs/tools/mcp-server/', label: 'Gemini CLI connection guide' } },
  { id: 'chatgpt', name: 'ChatGPT', kind: 'cloud', mark: 'chatgpt', steps: ['Open ChatGPT Plugins and choose +, then Add custom MCP server.', 'Paste the CMEM URL, choose OAuth, and create the plugin.', 'Review the available tools, install the plugin, then @mention it in a chat.'], guide: { href: 'https://developers.openai.com/plugins/deploy/connect-chatgpt', label: 'ChatGPT connection guide' } },
]

/** The scan's agent ids drawn with the brand marks brand.tsx has; any other agent gets the neutral mark. */
export const agentToolFor = (agentId: string): AgentTool =>
  agentId === 'claude-code' ? 'claude' : agentId === 'codex' ? 'codex' : agentId === 'gemini-cli' ? 'gemini' : 'other'
