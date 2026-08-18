// Working memory: task-scoped scratch state, deliberately NOT another kind of
// observation. No ACT-R strength, no dedup, no embeddings, no FTS — every
// entry is relevant by definition, so none of the ranking machinery applies.
// Two non-overlapping writers share the table:
//   - intent rows (source 'agent'): the agent's hypotheses/plan, upserted by
//     (project, task_key, key) under a hard slot limit — the limit IS the
//     mechanism: overflow is an error that forces an explicit drop/merge.
//   - journal rows (source 'observer'): a mechanical ring buffer of what
//     happened (tool calls), written without any LLM involvement.
// Expiry is lazy: expires_at_epoch = updated + TTL, filtered on read, no
// timers. Rows never flow into observations automatically — only an explicit
// promoteEntry() crosses over.
import type { Database } from 'bun:sqlite';
import type { SessionStore } from '../sqlite/SessionStore.js';
import type { SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';

export const DEFAULT_TASK_KEY = 'default';

// chars-per-token heuristic shared with the rest of the context accounting —
// good enough for a budget whose job is bounding, not billing.
export const CHARS_PER_TOKEN = 4;

const DAY_MS = 86_400_000;

export interface WorkingLimits {
  maxKeys: number;     // intent slots per (project, task_key); journal has its own ring
  maxTokens: number;   // render budget over intent + journal values, in tokens (chars/4)
  journalSize: number; // journal ring length per (project, task_key)
  ttlDays: number;     // lazy expiry: expires_at = updated + ttlDays
}

export interface WorkingEntry {
  id: number;
  project: string;
  task_key: string;
  key: string;
  kind: 'intent' | 'journal';
  value: string;
  source: 'agent' | 'observer';
  created_at_epoch: number;
  updated_at_epoch: number;
  expires_at_epoch: number;
}

/** Overflow carries the current keys+sizes so the agent can decide what to drop. */
export class WorkingLimitError extends Error {
  readonly code = 'WORKING_LIMIT';
  constructor(
    message: string,
    public readonly keys: Array<{ key: string; chars: number }>,
  ) {
    super(message);
    this.name = 'WorkingLimitError';
  }
}

export class WorkingNotFoundError extends Error {
  readonly code = 'WORKING_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'WorkingNotFoundError';
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function workingLimitsFromSettings(settings: Partial<SettingsDefaults>): WorkingLimits {
  return {
    maxKeys: parsePositiveInt(settings.CLAUDE_MEM_WORKING_MAX_KEYS, 8),
    maxTokens: parsePositiveInt(settings.CLAUDE_MEM_WORKING_MAX_TOKENS, 1000),
    journalSize: parsePositiveInt(settings.CLAUDE_MEM_WORKING_JOURNAL_SIZE, 5),
    ttlDays: parsePositiveInt(settings.CLAUDE_MEM_WORKING_TTL_DAYS, 7),
  };
}

export function estimateTokens(entries: Array<Pick<WorkingEntry, 'value'>>): number {
  const chars = entries.reduce((sum, entry) => sum + entry.value.length, 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Live (non-expired) rows for a task — the lazy TTL filter, applied on read. */
function liveRows(db: Database, project: string, taskKey: string, now: number): WorkingEntry[] {
  return db.prepare(`
    SELECT * FROM working_memory
    WHERE project = ? AND task_key = ? AND expires_at_epoch > ?
    ORDER BY updated_at_epoch ASC, id ASC
  `).all(project, taskKey, now) as WorkingEntry[];
}

function limitKeyList(rows: WorkingEntry[]): Array<{ key: string; chars: number }> {
  return rows.map(row => ({ key: row.key, chars: row.value.length }));
}

/**
 * Upsert one intent slot. New keys beyond maxKeys, or a total value size
 * beyond the token budget, fail with WorkingLimitError listing the current
 * keys — the agent must explicitly drop/merge before writing again.
 */
export function setEntry(
  db: Database,
  project: string,
  taskKey: string,
  key: string,
  value: string,
  limits: WorkingLimits,
  now: number = Date.now(),
): WorkingEntry {
  const rows = liveRows(db, project, taskKey, now);
  const existing = rows.find(row => row.key === key);

  if (!existing) {
    const intentCount = rows.filter(row => row.kind === 'intent').length;
    if (intentCount >= limits.maxKeys) {
      throw new WorkingLimitError(
        `working memory full: ${intentCount}/${limits.maxKeys} intent slots used — drop or merge a key first`,
        limitKeyList(rows.filter(row => row.kind === 'intent')),
      );
    }
  }

  const totalChars = rows.reduce((sum, row) => sum + (row.key === key ? 0 : row.value.length), 0) + value.length;
  if (totalChars > limits.maxTokens * CHARS_PER_TOKEN) {
    throw new WorkingLimitError(
      `working memory token budget exceeded: ${Math.ceil(totalChars / CHARS_PER_TOKEN)}/${limits.maxTokens} tokens — drop or shrink entries first`,
      limitKeyList(rows),
    );
  }

  const ttlMs = limits.ttlDays * DAY_MS;
  db.prepare(`
    INSERT INTO working_memory
      (project, task_key, key, kind, value, source, created_at_epoch, updated_at_epoch, expires_at_epoch)
    VALUES (?, ?, ?, 'intent', ?, 'agent', ?, ?, ?)
    ON CONFLICT(project, task_key, key) DO UPDATE SET
      value = excluded.value,
      kind = excluded.kind,
      source = excluded.source,
      updated_at_epoch = excluded.updated_at_epoch,
      expires_at_epoch = excluded.expires_at_epoch
  `).run(project, taskKey, key, value, now, now, now + ttlMs);

  return db.prepare(
    'SELECT * FROM working_memory WHERE project = ? AND task_key = ? AND key = ?'
  ).get(project, taskKey, key) as WorkingEntry;
}

export function dropEntry(
  db: Database,
  project: string,
  taskKey: string,
  key: string,
): void {
  const result = db.prepare(
    'DELETE FROM working_memory WHERE project = ? AND task_key = ? AND key = ?'
  ).run(project, taskKey, key);
  if (result.changes === 0) {
    throw new WorkingNotFoundError(`no working-memory entry for key '${key}' in task '${taskKey}'`);
  }
}

/**
 * Live entries for one task, or — when taskKey is omitted — for every task of
 * the project (the per-prompt injection does not know which task names the
 * agent chose).
 */
export function listEntries(
  db: Database,
  project: string,
  taskKey: string | undefined,
  now: number = Date.now(),
): WorkingEntry[] {
  if (taskKey !== undefined) {
    return liveRows(db, project, taskKey, now);
  }
  return db.prepare(`
    SELECT * FROM working_memory
    WHERE project = ? AND expires_at_epoch > ?
    ORDER BY task_key ASC, updated_at_epoch ASC, id ASC
  `).all(project, now) as WorkingEntry[];
}

/**
 * Mechanical journal append: one row per tool event, ring-trimmed to
 * limits.journalSize per task. Journal rows do not consume intent slots and
 * are never upserted — keys are unique by construction.
 */
export function appendJournal(
  db: Database,
  project: string,
  taskKey: string,
  text: string,
  limits: WorkingLimits,
  now: number = Date.now(),
): void {
  const ttlMs = limits.ttlDays * DAY_MS;
  const key = `journal:${now}:${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO working_memory
      (project, task_key, key, kind, value, source, created_at_epoch, updated_at_epoch, expires_at_epoch)
    VALUES (?, ?, ?, 'journal', ?, 'observer', ?, ?, ?)
  `).run(project, taskKey, key, text, now, now, now + ttlMs);

  db.prepare(`
    DELETE FROM working_memory
    WHERE project = ? AND task_key = ? AND kind = 'journal' AND id NOT IN (
      SELECT id FROM working_memory
      WHERE project = ? AND task_key = ? AND kind = 'journal'
      ORDER BY updated_at_epoch DESC, id DESC
      LIMIT ?
    )
  `).run(project, taskKey, project, taskKey, limits.journalSize);
}

/** Task finished — drop the whole set (intent + journal). Returns rows removed. */
export function closeTask(db: Database, project: string, taskKey: string): number {
  const result = db.prepare(
    'DELETE FROM working_memory WHERE project = ? AND task_key = ?'
  ).run(project, taskKey);
  return result.changes;
}

/** Refresh updated/expires on read-confirmed entries ("still relevant"). */
export function touchTtl(
  db: Database,
  project: string,
  taskKey: string,
  key: string,
  limits: WorkingLimits,
  now: number = Date.now(),
): void {
  const result = db.prepare(`
    UPDATE working_memory
    SET updated_at_epoch = ?, expires_at_epoch = ?
    WHERE project = ? AND task_key = ? AND key = ?
  `).run(now, now + limits.ttlDays * DAY_MS, project, taskKey, key);
  if (result.changes === 0) {
    throw new WorkingNotFoundError(`no working-memory entry for key '${key}' in task '${taskKey}'`);
  }
}

/**
 * The ONLY bridge from working memory to long-term storage: the agent
 * explicitly confirms a hypothesis as true, so it becomes a regular
 * observation (default type 'decision') and the working slot is cleared.
 * Nothing else in the codebase may copy working rows into observations.
 */
export function promoteEntry(
  store: SessionStore,
  project: string,
  taskKey: string,
  key: string,
  type: 'decision' | 'discovery' = 'decision',
  now: number = Date.now(),
): { observationId: number; createdAtEpoch: number } {
  const row = store.db.prepare(
    'SELECT * FROM working_memory WHERE project = ? AND task_key = ? AND key = ?'
  ).get(project, taskKey, key) as WorkingEntry | undefined;
  if (!row || row.expires_at_epoch <= now) {
    throw new WorkingNotFoundError(`no working-memory entry for key '${key}' in task '${taskKey}'`);
  }

  const memorySessionId = store.getOrCreateManualSession(project);
  const result = store.storeObservation(
    memorySessionId,
    project,
    {
      type,
      title: row.value.length > 60 ? `${row.value.slice(0, 57)}...` : row.value,
      subtitle: `Promoted from working memory (task '${taskKey}', key '${row.key}')`,
      facts: [],
      narrative: row.value,
      concepts: [],
      files_read: [],
      files_modified: [],
      metadata: JSON.stringify({ source: 'working_memory', task_key: taskKey, key: row.key }),
    },
    0,
    0,
    now,
  );

  store.db.prepare(
    'DELETE FROM working_memory WHERE project = ? AND task_key = ? AND key = ?'
  ).run(project, taskKey, key);

  return { observationId: result.id, createdAtEpoch: result.createdAtEpoch };
}
