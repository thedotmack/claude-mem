// What the funnel screens show. Every screen reads it through props; nothing here is made up.
// The live source fills it from the worker (prompt scan, extraction, usage, setup state); `?source=sample` loads
// setup-sample.ts instead, and only then.
import type { AgentTool } from '@/data'
import { toSetupUsage, type SetupScanUsage, type SetupUsage } from './setup-usage'

/** Mirrors the worker's SetupScanState (src/services/prompt-import/setup-scan.ts), trimmed to what the screen shows. */
export interface SetupScanAgent { id: string; label: string; detected: boolean; prompts: number }
export type SetupScanPhase = 'idle' | 'reading' | 'checking' | 'saving' | 'done' | 'failed'
export interface SetupScanView { agents: SetupScanAgent[]; percent: number; phase: SetupScanPhase; done: boolean; error: string | null }

/** One overall request. New installs have no progress readings, so `progressPercent` is absent and no bar shows. */
export interface RevealWork { id: string; title: string; agent: AgentTool; lastActiveAt: string; progressPercent?: number }
export interface RevealGoal { id: string; rank: number; title: string; timesAsked: number; latestAt: string }
export interface RevealRule { id: string; text: string; quote: string; quotedAt: string }
/** `null` while that set is still being extracted. */
export interface RevealSets { goals: RevealGoal[] | null; work: RevealWork[] | null; rules: RevealRule[] | null }

export type { Persona, SetupScanUsage, SetupUsage, UsageCoverage } from './setup-usage'

export interface SetupHistory { projects: number; sessions: number; observations: number }
export interface HistoryImportProgress { percent: number; done: boolean }

export interface MemoryResult { id: string; title: string; body: string; project: string; agent: string; session: string; date: string }

export interface SetupData {
  scan: SetupScanView
  reveal: RevealSets
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

export interface SetupSource {
  readonly kind: 'local' | 'sample'
  subscribe(onData: (data: SetupData) => void): () => void
  startHistoryImport(): void
  search(query: string): Promise<MemoryResult[]>
}

export const EMPTY_SETUP_DATA: SetupData = {
  scan: { agents: [], percent: 0, phase: 'idle', done: false, error: null },
  reveal: { goals: null, work: null, rules: null },
  usage: null,
  alreadyPro: false,
  detectedTools: [],
  history: null,
  historyImport: null,
  suggestions: [],
}

const WORK_VIEW_EVENTS_URL = '/api/work-view/events'

/** The worker's SetupScanState, as far as the funnel reads it. */
interface SetupScanState extends SetupScanView { usage?: SetupScanUsage | null }

/** The setup data the worker's scan state carries: scan progress and, once it is done, token usage. */
export function setupDataFromScan(state: SetupScanState): Pick<SetupData, 'scan' | 'usage'> {
  return {
    scan: { agents: state.agents, percent: state.percent, phase: state.phase, done: state.done, error: state.error },
    usage: state.usage ? toSetupUsage(state.usage) : null,
  }
}

/**
 * The live source follows the worker's setup scan through `setup-scan` events on the work view stream (sent on connect once
 * a scan has started, then as it runs; WorkViewRoutes). It does not start the scan. Extraction, search and import land in funnel Phases 5-10; until then those parts keep the empty state.
 */
export const localSetupSource: SetupSource = {
  kind: 'local',
  subscribe(onData) {
    let data = EMPTY_SETUP_DATA
    let closed = false
    const accept = (state: SetupScanState) => { if (!closed) { data = { ...data, ...setupDataFromScan(state) }; onData(data) } }
    onData(data)
    const stream = new EventSource(WORK_VIEW_EVENTS_URL)
    stream.addEventListener('setup-scan', (event) => accept(JSON.parse((event as MessageEvent).data as string) as SetupScanState))
    return () => { closed = true; stream.close() }
  },
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
