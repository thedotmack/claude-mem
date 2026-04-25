/**
 * One-time v12.4.3 pollution cleanup.
 *
 * Removes accumulated junk that v12.4.0/v12.4.2 fixes prevent from ever recurring:
 *   1. observer-sessions: rows that polluted user-facing search/timeline before
 *      the observer-sessions filter shipped. Cascades to user_prompts, observations,
 *      and session_summaries via existing FK ON DELETE CASCADE.
 *   2. Stuck pending_messages: poisoned chains where ≥10 rows for a single
 *      session_db_id are stuck in 'failed' or 'processing'. Threshold spares
 *      legitimate transient failures while clearing the cascade-failure cases
 *      from the pre-v12.4.2 context-overflow loop.
 *
 * After SQLite is cleaned, ~/.claude-mem/chroma/ and ~/.claude-mem/chroma-sync-state.json
 * are removed so backfillAllProjects rebuilds the vector store from the cleaned SQLite.
 *
 * Marker-file gated. Idempotent. Opt-out via CLAUDE_MEM_SKIP_CLEANUP_V12_4_3=1.
 *
 * Mirrors the runOneTimeChromaMigration / runOneTimeCwdRemap pattern in
 * ProcessManager.ts. Must run AFTER dbManager.initialize() (so migrations have
 * applied) and BEFORE ChromaSync.backfillAllProjects (so backfill sees the
 * cleaned state).
 */

import path from 'path';
import { existsSync, writeFileSync, mkdirSync, rmSync, statSync, copyFileSync, statfsSync } from 'fs';
import { Database } from 'bun:sqlite';
import { DATA_DIR, OBSERVER_SESSIONS_PROJECT } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

const MARKER_FILENAME = '.cleanup-v12.4.3-applied';
const STUCK_PENDING_THRESHOLD = 10;

interface CleanupCounts {
  observerSessions: number;
  observerCascadeRows: number;
  stuckPendingMessages: number;
}

interface MarkerPayload {
  appliedAt: string;
  backupPath: string | null;
  chromaWiped: boolean;
  chromaWipeError?: string;
  counts: CleanupCounts;
  skipped?: string;
}

/**
 * Run the one-time v12.4.3 cleanup. Safe to call on every worker startup;
 * the marker file ensures the work runs at most once per data directory.
 *
 * @param dataDirectory - Override for DATA_DIR (used in tests)
 */
export function runOneTimeV12_4_3Cleanup(dataDirectory?: string): void {
  const effectiveDataDir = dataDirectory ?? DATA_DIR;
  const markerPath = path.join(effectiveDataDir, MARKER_FILENAME);

  if (existsSync(markerPath)) {
    logger.debug('SYSTEM', 'v12.4.3 cleanup marker exists, skipping');
    return;
  }

  if (process.env.CLAUDE_MEM_SKIP_CLEANUP_V12_4_3 === '1') {
    logger.warn('SYSTEM', 'v12.4.3 cleanup skipped via CLAUDE_MEM_SKIP_CLEANUP_V12_4_3=1; marker not written');
    return;
  }

  const dbPath = path.join(effectiveDataDir, 'claude-mem.db');
  if (!existsSync(dbPath)) {
    mkdirSync(effectiveDataDir, { recursive: true });
    writeMarker(markerPath, { appliedAt: new Date().toISOString(), backupPath: null, chromaWiped: false, counts: emptyCounts(), skipped: 'no-db' });
    logger.debug('SYSTEM', 'No DB present, v12.4.3 cleanup marker written without work', { dbPath });
    return;
  }

  logger.warn('SYSTEM', 'Running one-time v12.4.3 pollution cleanup', { dbPath });

  try {
    executeCleanup(dbPath, effectiveDataDir, markerPath);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('SYSTEM', 'v12.4.3 cleanup failed, marker not written (will retry on next startup)', {}, error);
  }
}

function executeCleanup(dbPath: string, effectiveDataDir: string, markerPath: string): void {
  const dbSize = statSync(dbPath).size;
  const required = Math.ceil(dbSize * 1.2) + 100 * 1024 * 1024;

  let backupPath: string | null = null;
  try {
    const fs = statfsSync(effectiveDataDir);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (free < required) {
      // Don't write the marker — once the user frees disk space, the next
      // worker startup should retry the cleanup rather than skipping forever.
      logger.error('SYSTEM', 'Insufficient disk for v12.4.3 backup; skipping cleanup (will retry on next startup)', { dbSize, free, required });
      return;
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn('SYSTEM', 'statfsSync failed; proceeding without disk-space pre-flight', {}, error);
  }

  const effectiveBackupsDir = path.join(effectiveDataDir, 'backups');
  mkdirSync(effectiveBackupsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  backupPath = path.join(effectiveBackupsDir, `claude-mem-pre-12.4.3-${ts}.db`);

  const backupDb = new Database(dbPath, { readonly: true });
  let vacuumFailed = false;
  let vacuumError: Error | null = null;
  try {
    backupDb.run(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    logger.info('SYSTEM', 'v12.4.3 backup created via VACUUM INTO', { backupPath, dbSize });
  } catch (err: unknown) {
    vacuumFailed = true;
    vacuumError = err instanceof Error ? err : new Error(String(err));
  }
  // Close before any fallback: on Windows an open SQLite handle holds a
  // file lock that can prevent copyFileSync from reading the source.
  backupDb.close();

  if (vacuumFailed) {
    logger.warn('SYSTEM', 'VACUUM INTO failed, falling back to copyFileSync', {}, vacuumError ?? undefined);
    try {
      copyFileSync(dbPath, backupPath);
      // The DB is in WAL mode; recent committed pages may live in -wal/-shm.
      // VACUUM INTO captures them automatically; copyFileSync does not, so
      // mirror them alongside so the backup represents the same state.
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      if (existsSync(walPath)) copyFileSync(walPath, `${backupPath}-wal`);
      if (existsSync(shmPath)) copyFileSync(shmPath, `${backupPath}-shm`);
      logger.info('SYSTEM', 'v12.4.3 backup created via copyFileSync (incl. -wal/-shm if present)', { backupPath, dbSize });
    } catch (copyErr: unknown) {
      const copyError = copyErr instanceof Error ? copyErr : new Error(String(copyErr));
      logger.error('SYSTEM', 'v12.4.3 backup failed via both VACUUM INTO and copyFileSync; aborting cleanup', {}, copyError);
      return;
    }
  }

  const counts = emptyCounts();
  const db = new Database(dbPath);
  // PRAGMA foreign_keys must be set OUTSIDE a transaction to take effect on this connection.
  db.run('PRAGMA foreign_keys = ON');

  try {
    runObserverSessionsPurge(db, counts);
    runStuckPendingPurge(db, counts);
  } finally {
    db.close();
  }

  // SQLite purge succeeded; chroma wipe failure must NOT re-run the migration
  // on the next startup or we accumulate one new backup per boot. Capture the
  // failure on the marker instead.
  let chromaWiped = false;
  let chromaWipeError: string | undefined;
  try {
    chromaWiped = wipeChromaArtifacts(effectiveDataDir);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    chromaWipeError = error.message;
    logger.error('SYSTEM', 'v12.4.3: Chroma wipe failed; marker still written so cleanup does not re-run', {}, error);
  }

  writeMarker(markerPath, {
    appliedAt: new Date().toISOString(),
    backupPath,
    chromaWiped,
    chromaWipeError,
    counts,
  });

  logger.info('SYSTEM', 'v12.4.3 cleanup complete', {
    backupPath,
    chromaWiped,
    ...counts,
  });
  logger.info('SYSTEM', `To restore: cp '${backupPath}' '${dbPath}'`);
}

function runObserverSessionsPurge(db: Database, counts: CleanupCounts): void {
  db.run('BEGIN IMMEDIATE');
  try {
    // Count rows before the delete: bun:sqlite's result.changes inflates with
    // FTS-trigger and cascade row counts, so it can't stand in for a session
    // count or a cascade-row count on its own.
    const sessionCount = (db.prepare(`SELECT COUNT(*) AS n FROM sdk_sessions WHERE project = ?`).get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n;
    const cascadeRows =
      (db.prepare(`SELECT COUNT(*) AS n FROM user_prompts WHERE content_session_id IN (SELECT content_session_id FROM sdk_sessions WHERE project = ?)`).get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n
      + (db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE memory_session_id IN (SELECT memory_session_id FROM sdk_sessions WHERE project = ? AND memory_session_id IS NOT NULL)`).get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n
      + (db.prepare(`SELECT COUNT(*) AS n FROM session_summaries WHERE memory_session_id IN (SELECT memory_session_id FROM sdk_sessions WHERE project = ? AND memory_session_id IS NOT NULL)`).get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n;

    db.run(`DELETE FROM sdk_sessions WHERE project = ?`, [OBSERVER_SESSIONS_PROJECT]);
    counts.observerSessions = sessionCount;
    counts.observerCascadeRows = cascadeRows;

    db.run('COMMIT');
    logger.info('SYSTEM', 'v12.4.3: observer-sessions purge committed', {
      sessions: counts.observerSessions,
      cascadeRows: counts.observerCascadeRows,
    });
  } catch (err: unknown) {
    // Defensive: SQLite may have already auto-rolled back on certain
    // constraint failures. Don't let a no-op ROLLBACK shadow the real error.
    try { db.run('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

function runStuckPendingPurge(db: Database, counts: CleanupCounts): void {
  db.run('BEGIN IMMEDIATE');
  try {
    // Pre-count for consistency with runObserverSessionsPurge: result.changes
    // would be reliable today (no FTS on pending_messages) but the explicit
    // count protects against future schema changes.
    const stuckCount = (db.prepare(
      `SELECT COUNT(*) AS n FROM pending_messages
         WHERE status IN ('failed', 'processing')
           AND session_db_id IN (
             SELECT session_db_id FROM pending_messages
              WHERE status IN ('failed', 'processing')
              GROUP BY session_db_id
              HAVING COUNT(*) >= ?
           )`
    ).get(STUCK_PENDING_THRESHOLD) as { n: number }).n;

    db.run(
      `DELETE FROM pending_messages
         WHERE status IN ('failed', 'processing')
           AND session_db_id IN (
             SELECT session_db_id FROM pending_messages
              WHERE status IN ('failed', 'processing')
              GROUP BY session_db_id
              HAVING COUNT(*) >= ?
           )`,
      [STUCK_PENDING_THRESHOLD]
    );
    counts.stuckPendingMessages = stuckCount;
    db.run('COMMIT');
    logger.info('SYSTEM', 'v12.4.3: stuck pending_messages purge committed', { rows: counts.stuckPendingMessages });
  } catch (err: unknown) {
    // Defensive: SQLite may have already auto-rolled back on certain
    // constraint failures. Don't let a no-op ROLLBACK shadow the real error.
    try { db.run('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

function wipeChromaArtifacts(effectiveDataDir: string): boolean {
  const chromaDir = path.join(effectiveDataDir, 'chroma');
  const stateFile = path.join(effectiveDataDir, 'chroma-sync-state.json');
  let wiped = false;

  if (existsSync(chromaDir)) {
    rmSync(chromaDir, { recursive: true, force: true });
    logger.info('SYSTEM', 'v12.4.3: chroma directory removed (will rebuild via backfill)', { chromaDir });
    wiped = true;
  }
  if (existsSync(stateFile)) {
    rmSync(stateFile, { force: true });
    logger.info('SYSTEM', 'v12.4.3: chroma-sync-state.json removed', { stateFile });
    wiped = true;
  }
  return wiped;
}

function writeMarker(markerPath: string, payload: MarkerPayload): void {
  writeFileSync(markerPath, JSON.stringify(payload, null, 2));
}

function emptyCounts(): CleanupCounts {
  return { observerSessions: 0, observerCascadeRows: 0, stuckPendingMessages: 0 };
}
