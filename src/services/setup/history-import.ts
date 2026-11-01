/**
 * Finish Setup's "Bring your existing memory" (On The Go only): uploads this machine's own observations to the
 * person's CMEM Pro memory through cmem.ai's existing POST /api/import, authenticated with the installer's setup
 * token (the same bearer /api/hooks takes). That route persists observations only, so this sends observations only,
 * and the receipt counts exactly those. Sessions, summaries and prompts stay on this computer.
 *
 * Batches are small enough for one serverless request each. Imports are idempotent on cmem.ai (stable ids), so a
 * retried run re-sends safely: rows already there come back as skipped. There is no time limit; a refused batch
 * stops the run with the server's reason, and Continue can start it again.
 */

import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';

export const HISTORY_IMPORT_BATCH = 100;

export interface SetupHistoryCounts { projects: number; sessions: number; observations: number }

export interface HistoryImportState {
  state: 'idle' | 'running' | 'done' | 'failed';
  total: number;
  sent: number;
  /** Observations cmem.ai wrote (new to the account). */
  imported: number;
  /** Observations cmem.ai already had, or could not read. */
  skipped: number;
  percent: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Observations this machine wrote itself (not ones synced in from another device). */
const OWN_OBSERVATIONS = 'FROM observations WHERE origin_device_id IS NULL';

export function readHistoryCounts(database: Database): SetupHistoryCounts {
  const row = database.prepare(`SELECT COUNT(*) AS observations, COUNT(DISTINCT project) AS projects, COUNT(DISTINCT memory_session_id) AS sessions ${OWN_OBSERVATIONS}`)
    .get() as { observations: number; projects: number; sessions: number };
  return { projects: row.projects, sessions: row.sessions, observations: row.observations };
}

interface ObservationRow {
  id: number; memory_session_id: string | null; project: string | null; type: string | null; title: string | null; subtitle: string | null;
  narrative: string | null; text: string | null; facts: string | null; concepts: string | null; files_read: string | null; files_modified: string | null;
  prompt_number: number | null; created_at: string | null; created_at_epoch: number | null;
}

/** The import-memories.ts observation shape /api/import reads (lib/eat/import.ts observationPayload). */
function toImportObservation(row: ObservationRow) {
  return {
    memory_session_id: row.memory_session_id, project: row.project, type: row.type, title: row.title, subtitle: row.subtitle,
    narrative: row.narrative, text: row.text, facts: row.facts, concepts: row.concepts, files_read: row.files_read, files_modified: row.files_modified,
    prompt_number: row.prompt_number === null ? null : String(row.prompt_number), created_at: row.created_at, created_at_epoch: row.created_at_epoch,
  };
}

export interface HistoryImportOptions {
  openDatabase: () => Database;
  /** e.g. https://cmem.ai */
  origin: () => string;
  /** The installer's setup token (CLAUDE_MEM_CLOUD_SYNC_TOKEN); null when this machine has no CMEM Pro connection. */
  token: () => string | null;
  fetch?: typeof fetch;
  now?: () => number;
}

export class HistoryImport {
  private current: HistoryImportState = { state: 'idle', total: 0, sent: 0, imported: 0, skipped: 0, percent: 0, error: null, startedAt: null, finishedAt: null };
  private listeners = new Set<(state: HistoryImportState) => void>();
  private running: Promise<void> | null = null;

  constructor(private options: HistoryImportOptions) {}

  state(): HistoryImportState { return { ...this.current }; }

  subscribe(listener: (state: HistoryImportState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts an import unless one is running or this machine has no CMEM Pro connection (that throws). */
  start(): HistoryImportState {
    if (this.running) return this.state();
    const token = this.options.token();
    if (!token) throw new Error('Bringing your memory needs CMEM Pro on this computer. Finish checkout first.');
    this.running = this.run(token).finally(() => { this.running = null; });
    return this.state();
  }

  async finished(): Promise<HistoryImportState> { await this.running; return this.state(); }

  private update(changes: Partial<HistoryImportState>): void {
    this.current = { ...this.current, ...changes };
    const snapshot = this.state();
    for (const listener of this.listeners) listener(snapshot);
  }

  private iso(): string { return new Date((this.options.now ?? Date.now)()).toISOString(); }

  private async run(token: string): Promise<void> {
    const request = this.options.fetch ?? fetch;
    const url = `${this.options.origin()}/api/import`;
    const database = this.options.openDatabase();
    try {
      const total = readHistoryCounts(database).observations;
      this.update({ state: 'running', total, sent: 0, imported: 0, skipped: 0, percent: 0, error: null, startedAt: this.iso(), finishedAt: null });
      const page = database.prepare(`SELECT id, memory_session_id, project, type, title, subtitle, narrative, text, facts, concepts, files_read, files_modified,
        prompt_number, created_at, created_at_epoch ${OWN_OBSERVATIONS} AND id > ? ORDER BY id LIMIT ?`);
      let after = 0;
      for (;;) {
        const rows = page.all(after, HISTORY_IMPORT_BATCH) as ObservationRow[];
        if (!rows.length) break;
        const response = await request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ observations: rows.map(toImportObservation) }),
        });
        const answer = await response.json().catch(() => null) as { stats?: { observationsImported?: number; observationsSkipped?: number }; error?: string; message?: string } | null;
        if (!response.ok) throw new Error(`cmem.ai refused the import (HTTP ${response.status}${answer?.message || answer?.error ? `: ${answer.message ?? answer.error}` : ''}).`);
        after = rows[rows.length - 1].id;
        const sent = this.current.sent + rows.length;
        this.update({
          sent,
          imported: this.current.imported + (answer?.stats?.observationsImported ?? 0),
          skipped: this.current.skipped + (answer?.stats?.observationsSkipped ?? 0),
          percent: total ? Math.min(99, Math.floor((sent / total) * 100)) : 99,
        });
      }
      this.update({ state: 'done', percent: 100, finishedAt: this.iso() });
      logger.info('IMPORT', 'History import finished', { sent: this.current.sent, imported: this.current.imported, skipped: this.current.skipped });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('IMPORT', 'History import stopped', { error: message, sent: this.current.sent });
      this.update({ state: 'failed', error: message, finishedAt: this.iso() });
    } finally {
      database.close();
    }
  }
}
