// "What's next?" search: the worker's GET /api/search over memory (observations, session summaries) and the prompts the
// scan imported, so a new install with prompts only still gets results. Keep as note saves through POST /api/memory/save.
import { CONTENT_BODY_MAX_BYTES } from '../../../../shared/cloud-sync-limits.ts'

/** One "What's next?" card. `date` is YYYY-MM-DD. */
export interface MemoryResult { id: string; title: string; body: string; project: string; agent: string; session: string; date: string }

interface SearchObservation { id: number; title?: string | null; subtitle?: string | null; narrative?: string | null; text?: string | null; project?: string | null; memory_session_id?: string | null; platform_source?: string | null; created_at?: string | null }
interface SearchSession { id: number; request?: string | null; learned?: string | null; completed?: string | null; investigated?: string | null; project?: string | null; memory_session_id?: string | null; platform_source?: string | null; created_at?: string | null }
interface SearchPrompt { id: number; prompt_text?: string | null; project?: string | null; content_session_id?: string | null; platform_source?: string | null; created_at?: string | null }
export interface WorkerSearchResult { observations?: SearchObservation[]; sessions?: SearchSession[]; prompts?: SearchPrompt[] }

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI', 'antigravity-cli': 'Antigravity CLI', opencode: 'OpenCode', cursor: 'Cursor', hermes: 'Hermes' }
function agentName(platform: string | null | undefined): string {
  if (!platform) return 'Claude-Mem'
  return Object.hasOwn(AGENT_NAMES, platform) ? AGENT_NAMES[platform] : platform
}
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

/**
 * The bytes a kept note's synced record takes besides the note's text, title and project: every other field of the
 * observation's canonical body at its longest (the longest ids, revisions and timestamp, the manual session id with its
 * UUID suffix, and a device id of 128 control characters). Measured 2026-11-16 from the sync's own worst case,
 * `observationSyncBodyBound` in src/npx-cli/commands/import-memory.ts, for a note with empty text, title and project and
 * no metadata (a kept note sends none): 1,719 bytes. tests/worker/sync/kept-note-sync-limit.test.ts measures it again
 * and builds real synced records, so a sync change that makes the record bigger fails there.
 */
export const KEPT_NOTE_RECORD_REST_BYTES = 1719

const UTF8 = new TextEncoder()
/** The UTF-8 bytes `text` takes inside a JSON string, as the synced record writes it: escapes counted, quotes not. */
export const jsonTextBytes = (text: string) => UTF8.encode(JSON.stringify(text)).length - 2

/**
 * The most text a kept note can hold, in jsonTextBytes, so the memory it becomes is still one record cloud sync accepts.
 * The sync refuses a record whose canonical body passes CONTENT_BODY_MAX_BYTES (src/shared/cloud-sync-limits.ts) and
 * keeps it on this computer for good. What the text leaves room for: the rest of the record (KEPT_NOTE_RECORD_REST_BYTES),
 * this note's title, and its project, which the record holds twice (as the project and in the manual session's id).
 */
export function keptNoteTextMaxBytes(record: MemoryResult): number {
  const { title, project } = noteFor(record, '')
  return CONTENT_BODY_MAX_BYTES - KEPT_NOTE_RECORD_REST_BYTES - jsonTextBytes(title) - 2 * jsonTextBytes(project)
}

/** `end`, moved back by one when it would split a surrogate pair (one character). */
const pairSafe = (text: string, end: number) =>
  end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end]) ? end - 1 : end

/**
 * A kept note's text within keptNoteTextMaxBytes: the longest start of `text` that fits, cut between characters, and
 * whether a cut was needed, so the box can say so (owner rule: never cut text silently). A character costs 1 to 6 bytes
 * there (3 for most CJK, 4 for an emoji, 6 for an escaped control character), so the cap is measured, not counted.
 */
export function keptNoteText(record: MemoryResult, text: string): { text: string; cut: boolean } {
  const max = keptNoteTextMaxBytes(record)
  if (jsonTextBytes(text) <= max) return { text, cut: false }
  if (max <= 0) return { text: '', cut: true }
  // Binary search over where to cut: the bytes of a start that ends between characters only grow with its length.
  let fits = 0
  let over = text.length
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2)
    if (jsonTextBytes(text.slice(0, pairSafe(text, middle))) <= max) fits = middle
    else over = middle
  }
  return { text: text.slice(0, pairSafe(text, fits)), cut: true }
}
