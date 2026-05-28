
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

export function runOneTimeV12_4_3Cleanup(
  dataDirectory?: string,
  options: { dryRun?: boolean } = {},
): CleanupCounts | undefined {
  const dryRun = options.dryRun === true;
  const effectiveDataDir = dataDirectory ?? DATA_DIR;
  const markerPath = path.join(effectiveDataDir, MARKER_FILENAME);

  if (existsSync(markerPath) && !dryRun) {
    logger.debug('SYSTEM', 'v12.4.3 cleanup marker exists, skipping');
    return;
  }

  if (process.env.CLAUDE_MEM_SKIP_CLEANUP_V12_4_3 === '1' && !dryRun) {
    logger.warn('SYSTEM', 'v12.4.3 cleanup skipped via CLAUDE_MEM_SKIP_CLEANUP_V12_4_3=1; marker not written');
    return;
  }

  const dbPath = path.join(effectiveDataDir, 'claude-mem.db');
  if (!existsSync(dbPath)) {
    if (dryRun) {
      logger.info('SYSTEM', 'v12.4.3 cleanup --dry-run: no DB present, nothing to scan', { dbPath });
      return emptyCounts();
    }
    mkdirSync(effectiveDataDir, { recursive: true });
    writeMarker(markerPath, { appliedAt: new Date().toISOString(), backupPath: null, chromaWiped: false, counts: emptyCounts(), skipped: 'no-db' });
    logger.debug('SYSTEM', 'No DB present, v12.4.3 cleanup marker written without work', { dbPath });
    return;
  }

  if (dryRun) {
    logger.info('SYSTEM', 'Running v12.4.3 cleanup --dry-run (read-only scan, no writes)', { dbPath });
    try {
      return scanCleanupCounts(dbPath);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error('SYSTEM', 'v12.4.3 cleanup --dry-run scan failed', {}, error);
      return undefined;
    }
  }

  logger.warn('SYSTEM', 'Running one-time v12.4.3 pollution cleanup', { dbPath });

  try {
    executeCleanup(dbPath, effectiveDataDir, markerPath);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('SYSTEM', 'v12.4.3 cleanup failed, marker not written (will retry on next startup)', {}, error);
  }
}

function scanCleanupCounts(dbPath: string): CleanupCounts {
  const counts = emptyCounts();
  const db = new Database(dbPath, { readonly: true });
  try {
    counts.observerSessions = (
      db.prepare(`SELECT COUNT(*) AS n FROM sdk_sessions WHERE project = ?`).get(OBSERVER_SESSIONS_PROJECT) as { n: number }
    ).n;
    counts.observerCascadeRows =
      (db.prepare(`SELECT COUNT(*) AS n FROM user_prompts WHERE content_session_id IN (SELECT content_session_id FROM sdk_sessions WHERE project = ?)`).get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n
      + (db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE memory_session_id IN (SELECT memory_session_id FROM sdk_sessions WHERE project = ? AND memory_session_id IS NOT NULL)`).get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n
      + (db.prepare(`SELECT COUNT(*) AS n FROM session_summaries WHERE memory_session_id IN (SELECT memory_session_id FROM sdk_sessions WHERE project = ? AND memory_session_id IS NOT NULL)`).get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n;
    counts.stuckPendingMessages = (db.prepare(
      `SELECT COUNT(*) AS n FROM pending_messages
         WHERE status = 'processing'
           AND session_db_id IN (
             SELECT session_db_id FROM pending_messages
              WHERE status = 'processing'
              GROUP BY session_db_id
              HAVING COUNT(*) >= ?
           )`
    ).get(STUCK_PENDING_THRESHOLD) as { n: number }).n;
  } finally {
    db.close();
  }
  logger.info('SYSTEM', 'v12.4.3 cleanup --dry-run scan complete', {
    observerSessions: counts.observerSessions,
    observerCascadeRows: counts.observerCascadeRows,
    stuckPendingMessages: counts.stuckPendingMessages,
  });
  return counts;
}

function executeCleanup(dbPath: string, effectiveDataDir: string, markerPath: string): void {
  const dbSize = statSync(dbPath).size;
  const required = Math.ceil(dbSize * 1.2) + 100 * 1024 * 1024;

  let backupPath: string | null = null;
  try {
    const fs = statfsSync(effectiveDataDir);
    const bsize = Number(fs.bsize);
    const bavail = Number(fs.bavail);

    // Bun <= 1.3.14 on darwin-x64 returns a misaligned statfs struct
    // (bsize = 0, fields shifted by one slot). Tracking issue:
    //   https://github.com/oven-sh/bun/issues/31133
    // Fix landed upstream in:
    //   https://github.com/oven-sh/bun/pull/31139
    // and will ship in the next Bun release after 1.3.14. Until then, any
    // `bavail * bsize` math returns 0 and this gate would permanently skip
    // the cleanup with a misleading `free=0` error. Treat non-credible
    // readings (bsize <= 0, NaN, or non-finite) as "skip the gate" rather
    // than "disk is full" -- a real out-of-space condition will still
    // surface from the subsequent VACUUM INTO / copyFileSync.
    if (!Number.isFinite(bsize) || !Number.isFinite(bavail) || bsize <= 0) {
      logger.warn(
        'SYSTEM',
        'statfsSync returned non-credible values; proceeding without disk-space pre-flight',
        {
          bsize,
          bavail,
          runtime: typeof Bun !== 'undefined' ? `bun ${Bun.version}` : 'node',
          platform: `${process.platform}-${process.arch}`,
          hint: 'see https://github.com/oven-sh/bun/issues/31133 for the darwin-x64 case',
        },
      );
    } else {
      const free = bavail * bsize;
      if (free < required) {
        logger.error('SYSTEM', 'Insufficient disk for v12.4.3 backup; skipping cleanup (will retry on next startup)', { dbSize, free, required });
        return;
      }
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
  backupDb.close();

  if (vacuumFailed) {
    logger.warn('SYSTEM', 'VACUUM INTO failed, falling back to copyFileSync', {}, vacuumError ?? undefined);
    try {
      copyFileSync(dbPath, backupPath);
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
  db.run('PRAGMA foreign_keys = ON');

  try {
    runObserverSessionsPurge(db, counts);
    runStuckPendingPurge(db, counts);
  } finally {
    db.close();
  }

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
    try { db.run('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

function runStuckPendingPurge(db: Database, counts: CleanupCounts): void {
  db.run('BEGIN IMMEDIATE');
  try {
    const stuckCount = (db.prepare(
      `SELECT COUNT(*) AS n FROM pending_messages
         WHERE status = 'processing'
           AND session_db_id IN (
             SELECT session_db_id FROM pending_messages
              WHERE status = 'processing'
              GROUP BY session_db_id
              HAVING COUNT(*) >= ?
           )`
    ).get(STUCK_PENDING_THRESHOLD) as { n: number }).n;

    db.run(
      `DELETE FROM pending_messages
         WHERE status = 'processing'
           AND session_db_id IN (
             SELECT session_db_id FROM pending_messages
              WHERE status = 'processing'
              GROUP BY session_db_id
              HAVING COUNT(*) >= ?
           )`,
      [STUCK_PENDING_THRESHOLD]
    );
    counts.stuckPendingMessages = stuckCount;
    db.run('COMMIT');
    logger.info('SYSTEM', 'v12.4.3: stuck pending_messages purge committed', { rows: counts.stuckPendingMessages });
  } catch (err: unknown) {
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
