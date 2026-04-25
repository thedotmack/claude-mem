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
import { DATA_DIR, BACKUPS_DIR, DB_PATH, OBSERVER_SESSIONS_PROJECT } from '../../shared/paths.js';
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
      logger.error('SYSTEM', 'Insufficient disk for v12.4.3 backup; skipping cleanup', { dbSize, free, required });
      writeMarker(markerPath, { appliedAt: new Date().toISOString(), backupPath: null, chromaWiped: false, counts: emptyCounts(), skipped: 'disk' });
      return;
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn('SYSTEM', 'statfsSync failed; proceeding without disk-space pre-flight', {}, error);
  }

  mkdirSync(BACKUPS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  backupPath = path.join(BACKUPS_DIR, `claude-mem-pre-12.4.3-${ts}.db`);

  const backupDb = new Database(dbPath, { readonly: true });
  try {
    backupDb.run(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    logger.info('SYSTEM', 'v12.4.3 backup created via VACUUM INTO', { backupPath, dbSize });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn('SYSTEM', 'VACUUM INTO failed, falling back to copyFileSync', {}, error);
    try {
      copyFileSync(dbPath, backupPath);
      logger.info('SYSTEM', 'v12.4.3 backup created via copyFileSync', { backupPath, dbSize });
    } catch (copyErr: unknown) {
      const copyError = copyErr instanceof Error ? copyErr : new Error(String(copyErr));
      logger.error('SYSTEM', 'v12.4.3 backup failed via both VACUUM INTO and copyFileSync; aborting cleanup', {}, copyError);
      backupDb.close();
      return;
    }
  }
  backupDb.close();

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

  const chromaWiped = wipeChromaArtifacts(effectiveDataDir);

  writeMarker(markerPath, {
    appliedAt: new Date().toISOString(),
    backupPath,
    chromaWiped,
    counts,
  });

  logger.info('SYSTEM', 'v12.4.3 cleanup complete', {
    backupPath,
    chromaWiped,
    ...counts,
  });
  logger.info('SYSTEM', `To restore: cp '${backupPath}' '${DB_PATH}'`);
}

function runObserverSessionsPurge(db: Database, counts: CleanupCounts): void {
  db.run('BEGIN IMMEDIATE');
  try {
    const cascadeRows =
      (db.prepare(`SELECT COUNT(*) AS n FROM user_prompts WHERE content_session_id IN (SELECT content_session_id FROM sdk_sessions WHERE project = ?)`).get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n
      + (db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE memory_session_id IN (SELECT memory_session_id FROM sdk_sessions WHERE project = ? AND memory_session_id IS NOT NULL)`).get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n
      + (db.prepare(`SELECT COUNT(*) AS n FROM session_summaries WHERE memory_session_id IN (SELECT memory_session_id FROM sdk_sessions WHERE project = ? AND memory_session_id IS NOT NULL)`).get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n;

    const result = db.run(`DELETE FROM sdk_sessions WHERE project = ?`, [OBSERVER_SESSIONS_PROJECT]);
    counts.observerSessions = result.changes;
    counts.observerCascadeRows = cascadeRows;

    db.run('COMMIT');
    logger.info('SYSTEM', 'v12.4.3: observer-sessions purge committed', {
      sessions: counts.observerSessions,
      cascadeRows: counts.observerCascadeRows,
    });
  } catch (err: unknown) {
    db.run('ROLLBACK');
    throw err;
  }
}

function runStuckPendingPurge(db: Database, counts: CleanupCounts): void {
  db.run('BEGIN IMMEDIATE');
  try {
    const result = db.run(
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
    counts.stuckPendingMessages = result.changes;
    db.run('COMMIT');
    logger.info('SYSTEM', 'v12.4.3: stuck pending_messages purge committed', { rows: counts.stuckPendingMessages });
  } catch (err: unknown) {
    db.run('ROLLBACK');
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
