// "What's next?" search: the worker's GET /api/search over memory (observations, session summaries) and the prompts the
// scan imported, so a new install with prompts only still gets results. Keep as note saves through POST /api/memory/save.

/** One "What's next?" card. `date` is YYYY-MM-DD. */
export interface MemoryResult { id: string; title: string; body: string; project: string; agent: string; session: string; date: string }

interface SearchObservation { id: number; title?: string | null; subtitle?: string | null; narrative?: string | null; text?: string | null; project?: string | null; memory_session_id?: string | null; platform_source?: string | null; created_at?: string | null }
interface SearchSession { id: number; request?: string | null; learned?: string | null; completed?: string | null; investigated?: string | null; project?: string | null; memory_session_id?: string | null; platform_source?: string | null; created_at?: string | null }
interface SearchPrompt { id: number; prompt_text?: string | null; project?: string | null; content_session_id?: string | null; platform_source?: string | null; created_at?: string | null }
export interface WorkerSearchResult { observations?: SearchObservation[]; sessions?: SearchSession[]; prompts?: SearchPrompt[] }

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI', 'antigravity-cli': 'Antigravity CLI', opencode: 'OpenCode' }
const agentName = (platform: string | null | undefined) => (platform && AGENT_NAMES[platform]) || 'Claude-Mem'
const day = (at: string | null | undefined) => (at && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : new Date().toISOString().slice(0, 10))
const shortSession = (id: string | null | undefined) => (id ? id.slice(0, 8) : 'session')
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text)

export const SEARCH_LIMIT = 10

/** Newest first, observations, then summaries, then prompts as the worker ranked each. */
export function toMemoryResults(result: WorkerSearchResult): MemoryResult[] {
  const observations = (result.observations ?? []).map((row): MemoryResult => ({
    id: `observation-${row.id}`, title: row.title || clip(row.narrative ?? row.text ?? 'Memory', 80),
    body: row.narrative || row.text || row.subtitle || '', project: row.project || 'claude-mem', agent: agentName(row.platform_source),
    session: shortSession(row.memory_session_id), date: day(row.created_at),
  }))
  const sessions = (result.sessions ?? []).map((row): MemoryResult => ({
    id: `summary-${row.id}`, title: clip(row.request || 'Session summary', 120),
    body: row.learned || row.completed || row.investigated || '', project: row.project || 'claude-mem', agent: agentName(row.platform_source),
    session: shortSession(row.memory_session_id), date: day(row.created_at),
  }))
  const prompts = (result.prompts ?? []).filter((row) => row.prompt_text?.trim()).map((row): MemoryResult => ({
    id: `prompt-${row.id}`, title: clip(row.prompt_text!.trim().split('\n')[0], 120),
    body: clip(row.prompt_text!.trim(), 600), project: row.project || 'claude-mem', agent: agentName(row.platform_source),
    session: shortSession(row.content_session_id), date: day(row.created_at),
  }))
  return [...observations, ...sessions, ...prompts]
}

export const searchUrl = (query: string) => `/api/search?${new URLSearchParams({ query, format: 'json', limit: String(SEARCH_LIMIT) })}`

/** The memory a kept note becomes. The source memory is never changed. */
export const noteFor = (record: MemoryResult, text: string) => ({ title: `Note: ${record.title}`.slice(0, 200), text, project: record.project })
