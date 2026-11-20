/**
 * Finish Setup's "Bring your existing memory" (On The Go only): uploads this machine's own observations to the
 * person's CMEM Pro memory through cmem.ai's existing POST /api/import, authenticated with the installer's setup
 * token (the same bearer /api/hooks takes). That route persists observations only, so this sends observations only,
 * and the receipt counts exactly those. Sessions, summaries and prompts stay on this computer.
 *
 * Batches are small enough for one serverless request each. Imports are idempotent on cmem.ai (stable ids), so a
 * retried run re-sends safely: rows already there come back as skipped. There is no time limit; a refused batch
 * stops the run with the server's reason, and Continue can start it again.
 *
 * The person can stop a run (`stop`, Finish Setup's "Stop import"). No request starts after that, the one on its way
 * is cancelled, and nothing is deleted on either side. Only the person's next start runs it again: nothing here or in
 * the worker starts an upload by itself, at startup, on a timer or on a reconnect.
 */

import type { Database } from 'bun:sqlite';
import { HISTORY_IMPORT_BATCH, historyImportRunning, type HistoryImportRunState } from '../../shared/setup-funnel.js';
import { logger } from '../../utils/logger.js';

export { HISTORY_IMPORT_BATCH };

export interface SetupHistoryCounts { projects: number; sessions: number; observations: number }

export interface HistoryImportState {
  state: HistoryImportRunState;
  total: number;
  /**
   * Observations cmem.ai acknowledged (imported + skipped): ones it wrote, ones it already had, and ones it could not
   * read. So `sent` says how far the run got, never how many reached the account; only `imported` says that.
   */
  sent: number;
  /**
   * Observations in the batch that was on its way to cmem.ai when the person pressed Stop: no answer came back, so
   * cmem.ai may or may not have saved them. 0 in every other state. A later run sends them again, safely.
   */
  unconfirmed: number;
  /** Observations cmem.ai wrote (new to the account). */
  imported: number;
  /** Observations cmem.ai already had, or could not read: its answer counts both as skipped and does not say which. */
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

/** One run: the switch Stop pulls, and the batch it is waiting on cmem.ai for. */
interface ImportRun {
  stop: AbortController;
  /** Rows in the request on its way now; 0 between requests. */
  batchOnItsWay: number;
}

export class HistoryImport {
  private current: HistoryImportState = { state: 'idle', total: 0, sent: 0, unconfirmed: 0, imported: 0, skipped: 0, percent: 0, error: null, startedAt: null, finishedAt: null };
  private listeners = new Set<(state: HistoryImportState) => void>();
  /** The run that may still send; null once it ended or was stopped. */
  private running: ImportRun | null = null;
  /** Settles when the last run's code has returned (a stopped run's cancelled request included). */
  private lastRunEnded: Promise<void> = Promise.resolve();

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
    const run: ImportRun = { stop: new AbortController(), batchOnItsWay: 0 };
    this.running = run;
    this.lastRunEnded = this.run(token, run).finally(() => { if (this.running === run) this.running = null; });
    return this.state();
  }

  /**
   * The person's Stop: ends the running upload at once. No request to /api/import starts after this returns. The one
   * on its way, if any, is cancelled, and its rows are reported as `unconfirmed`, because cmem.ai may have saved them
   * before the cancel reached it. What cmem.ai acknowledged stays there and stays counted; nothing is deleted on either
   * side. The run is over when this returns (`stopped` is not running), so nothing waits for it or counts it as busy.
   * Null when no upload is running: there is nothing to stop.
   */
  stop(): HistoryImportState | null {
    const run = this.running;
    if (!run || !historyImportRunning(this.current.state)) return null;
    this.running = null;
    run.stop.abort();
    this.update({ state: 'stopped', unconfirmed: run.batchOnItsWay, finishedAt: this.iso() });
    logger.info('IMPORT', 'History import stopped by the person', { sent: this.current.sent, unconfirmed: this.current.unconfirmed });
    return this.state();
  }

  /** The state once the last run's code has returned, including a stopped run whose cancelled request has settled. */
  async finished(): Promise<HistoryImportState> { await this.lastRunEnded; return this.state(); }

  private update(changes: Partial<HistoryImportState>): void {
    this.current = { ...this.current, ...changes };
    const snapshot = this.state();
    for (const listener of this.listeners) listener(snapshot);
  }

  private iso(): string { return new Date((this.options.now ?? Date.now)()).toISOString(); }

  private async run(token: string, run: ImportRun): Promise<void> {
    const request = this.options.fetch ?? fetch;
    const url = `${this.options.origin()}/api/import`;
    const stopped = run.stop.signal;
    // The cancel Stop makes: a cancelled request, and a body read it cut off, reject with the signal's own reason.
    const isTheStop = (error: unknown) => error === stopped.reason;
    let database: Database | undefined;
    try {
      database = this.options.openDatabase();
      // Fix the run's count and upper ID in one read. Live capture may append
      // observations while an upload is awaiting its network receipt.
      const { total, through } = database.prepare(`SELECT COUNT(*) AS total, COALESCE(MAX(id), 0) AS through ${OWN_OBSERVATIONS}`)
        .get() as { total: number; through: number };
      this.update({ state: 'running', total, sent: 0, unconfirmed: 0, imported: 0, skipped: 0, percent: 0, error: null, startedAt: this.iso(), finishedAt: null });
      const page = database.prepare(`SELECT id, memory_session_id, project, type, title, subtitle, narrative, text, facts, concepts, files_read, files_modified,
        prompt_number, created_at, created_at_epoch ${OWN_OBSERVATIONS} AND id > ? AND id <= ? ORDER BY id LIMIT ?`);
      let after = 0;
      // Stop can only land while this awaits cmem.ai (the code between two requests never yields), so each request
      // starts from a run that the check after the previous answer found still going.
      for (;;) {
        const rows = page.all(after, through, HISTORY_IMPORT_BATCH) as ObservationRow[];
        if (!rows.length) break;
        run.batchOnItsWay = rows.length;
        const response = await request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ observations: rows.map(toImportObservation) }),
          signal: stopped,
        });
        // A body that is not JSON, or one Stop cut off, leaves only the status to report.
        let unreadable: unknown = null;
        const answer = await response.json().catch((error: unknown) => { unreadable = error; return null; }) as { stats?: { observationsImported?: number; observationsSkipped?: number }; error?: string; message?: string } | null;
        // Stopped while this batch was on its way: stop() already reported it as unconfirmed, and an answer that
        // still came back changes nothing. Nothing more is sent. Only the cancel itself goes unlogged: a refusal, or
        // a body that failed for another reason, is logged with its cause.
        if (stopped.aborted) {
          const cause = isTheStop(unreadable) ? null : unreadable;
          if (!response.ok || cause !== null) {
            logger.warn('IMPORT', 'History import: cmem.ai answered the batch on its way at Stop with an error', { status: response.status, reason: answer?.message ?? answer?.error ?? null }, cause ?? undefined);
          }
          return;
        }
        run.batchOnItsWay = 0;
        if (!response.ok) throw new Error(`cmem.ai refused the import (HTTP ${response.status}${answer?.message || answer?.error ? `: ${answer.message ?? answer.error}` : ''}).`);
        const imported = answer?.stats?.observationsImported;
        const skipped = answer?.stats?.observationsSkipped;
        if (typeof imported !== 'number' || typeof skipped !== 'number'
          || !Number.isSafeInteger(imported) || !Number.isSafeInteger(skipped)
          || imported < 0 || skipped < 0 || imported + skipped !== rows.length) {
          throw new Error('cmem.ai did not acknowledge every observation in the import batch. Continue to resend it safely.');
        }
        after = rows[rows.length - 1].id;
        const sent = this.current.sent + rows.length;
        this.update({
          sent,
          imported: this.current.imported + imported,
          skipped: this.current.skipped + skipped,
          percent: total ? Math.min(99, Math.floor((sent / total) * 100)) : 99,
        });
      }
      this.update({ state: 'done', percent: 100, finishedAt: this.iso() });
      logger.info('IMPORT', 'History import finished', { sent: this.current.sent, imported: this.current.imported, skipped: this.current.skipped });
    } catch (error) {
      if (stopped.aborted) {
        // Stop cancels the request on its way, which rejects here with the cancel itself; stop() already wrote how
        // this run ended, so that one is silent. Any other error after Stop changes nothing either, but keeps its cause.
        if (!isTheStop(error)) logger.warn('IMPORT', 'History import: an error came after the person pressed Stop', { sent: this.current.sent }, error);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('IMPORT', 'History import failed', { error: message, sent: this.current.sent });
      this.update({ state: 'failed', error: message, finishedAt: this.iso() });
    } finally {
      database?.close();
    }
  }
}
