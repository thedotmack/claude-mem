import type { Database } from 'bun:sqlite';

/**
 * Row -> cloud-payload mappers for the cmem.ai sync contract.
 *
 * The local tables store facts/concepts/files_* as JSON TEXT; the cloud routes
 * want arrays. parseJsonArray() is the single tolerant parser used everywhere.
 * These functions read base rows by local_id and shape them into the EXACT
 * camelCase payloads the /batch routes expect. No network here.
 */

export function parseJsonArray(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (trimmed === '') return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map(String);
    return [];
  } catch {
    return [];
  }
}

export interface ObservationPayload {
  localId: number;
  memorySessionId: string;
  project: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
  promptNumber: number | null;
  discoveryTokens: number | null;
  createdAtEpoch: number;
}

export interface SummaryPayload {
  localId: number;
  memorySessionId: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  nextSteps: string | null;
  notes: string | null;
  promptNumber: number | null;
  discoveryTokens: number | null;
  createdAtEpoch: number;
}

export interface PromptPayload {
  localId: number;
  contentSessionId: string;
  /** May be null when the prompt's session has no resolved memory id yet. */
  memorySessionId: string | null;
  /** May be null when the prompt's session row is missing. */
  project: string | null;
  promptText: string;
  promptNumber: number;
  createdAtEpoch: number;
}

interface ObservationRow {
  id: number;
  memory_session_id: string;
  project: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  discovery_tokens: number | null;
  created_at_epoch: number;
}

export function mapObservationRow(row: ObservationRow): ObservationPayload {
  return {
    localId: row.id,
    memorySessionId: row.memory_session_id,
    project: row.project,
    type: row.type,
    title: row.title,
    subtitle: row.subtitle,
    facts: parseJsonArray(row.facts),
    narrative: row.narrative,
    concepts: parseJsonArray(row.concepts),
    filesRead: parseJsonArray(row.files_read),
    filesModified: parseJsonArray(row.files_modified),
    promptNumber: row.prompt_number,
    discoveryTokens: row.discovery_tokens,
    createdAtEpoch: row.created_at_epoch,
  };
}

interface SummaryRow {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  prompt_number: number | null;
  discovery_tokens: number | null;
  created_at_epoch: number;
}

export function mapSummaryRow(row: SummaryRow): SummaryPayload {
  return {
    localId: row.id,
    memorySessionId: row.memory_session_id,
    project: row.project,
    request: row.request,
    investigated: row.investigated,
    learned: row.learned,
    completed: row.completed,
    nextSteps: row.next_steps,
    notes: row.notes,
    promptNumber: row.prompt_number,
    discoveryTokens: row.discovery_tokens,
    createdAtEpoch: row.created_at_epoch,
  };
}

interface PromptRow {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
  // Joined from sdk_sessions (may be null):
  project: string | null;
  memory_session_id: string | null;
}

export function mapPromptRow(row: PromptRow): PromptPayload {
  return {
    localId: row.id,
    contentSessionId: row.content_session_id,
    memorySessionId: row.memory_session_id,
    project: row.project,
    promptText: row.prompt_text,
    promptNumber: row.prompt_number,
    createdAtEpoch: row.created_at_epoch,
  };
}

/** Read observations by local_id and map to payloads (skips rows that vanished). */
export function readObservationPayloads(db: Database, ids: number[]): ObservationPayload[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, memory_session_id, project, type, title, subtitle, facts, narrative,
              concepts, files_read, files_modified, prompt_number, discovery_tokens, created_at_epoch
         FROM observations WHERE id IN (${placeholders})`
    )
    .all(...ids) as ObservationRow[];
  return rows.map(mapObservationRow);
}

export function readSummaryPayloads(db: Database, ids: number[]): SummaryPayload[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, memory_session_id, project, request, investigated, learned, completed,
              next_steps, notes, prompt_number, discovery_tokens, created_at_epoch
         FROM session_summaries WHERE id IN (${placeholders})`
    )
    .all(...ids) as SummaryRow[];
  return rows.map(mapSummaryRow);
}

/**
 * Read user_prompts by local_id, LEFT JOINing sdk_sessions on content_session_id
 * to derive project + memory_session_id. LEFT JOIN (not INNER) so a prompt whose
 * session row is missing still syncs (project/memorySessionId best-effort null).
 */
export function readPromptPayloads(db: Database, ids: number[]): PromptPayload[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT up.id, up.content_session_id, up.prompt_number, up.prompt_text, up.created_at_epoch,
              s.project AS project, s.memory_session_id AS memory_session_id
         FROM user_prompts up
         LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
        WHERE up.id IN (${placeholders})`
    )
    .all(...ids) as PromptRow[];
  return rows.map(mapPromptRow);
}
