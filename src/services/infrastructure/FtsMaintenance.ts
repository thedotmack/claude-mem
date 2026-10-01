import path from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { Database } from 'bun:sqlite';
import { DATA_DIR } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

// FTS5 external-content indexes delete logically: every delete, and every update the old
// unscoped update triggers mirrored, appended a delete marker plus a re-inserted copy of the
// row's text. Neither VACUUM nor auto_vacuum can compact an FTS index; only merging its
// b-trees drops that dead content (#2793). Schema v54 stops new bloat at the source
// (column-scoped update triggers, no user_prompts_fts); this reclaims what an install already
// accumulated — once, off the startup path, in bounded steps.

const RECLAIM_MARKER_FILENAME = '.fts-bloat-reclaim-started';

// Constant identifiers (never user input), so interpolating them into the statements below
// is not dynamic SQL.
const RECLAIMABLE_FTS_TABLES = ['observations_fts', 'session_summaries_fts'] as const;

const DEFAULT_START_DELAY_MS = 60_000;
// Roughly this many pages are written per merge step (FTS5 'merge' command). Measured at
// under 10 ms per step on a bloated index, so a request is never blocked for long.
const DEFAULT_PAGES_PER_MERGE_STEP = 256;
const DEFAULT_PAUSE_BETWEEN_MERGE_STEPS_MS = 25;

export interface FtsBloatReclaimOptions {
  dataDir?: string;
  startDelayMs?: number;
  pagesPerMergeStep?: number;
  pauseBetweenMergeStepsMs?: number;
}

export interface FtsTableReclaimResult {
  table: string;
  mergeSteps: number;
}

function ftsTableExists(db: Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

function totalChanges(db: Database): number {
  return (db.query('SELECT total_changes() AS changes').get() as { changes: number }).changes;
}

function pauseWithoutHoldingTheProcess(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

/**
 * Merge each FTS index's b-trees in bounded steps (SQLite FTS5 'merge' command): the first
 * step passes a negative page count, which starts a full merge; later steps pass a positive
 * count, which runs that merge to completion even if new rows arrive meanwhile. A step that
 * changes fewer than two rows (sqlite total_changes) means there is nothing left to merge.
 * The event loop gets a pause between steps so requests keep being served.
 */
export async function reclaimFtsBloatInBoundedSteps(
  db: Database,
  options: FtsBloatReclaimOptions = {}
): Promise<FtsTableReclaimResult[]> {
  const pagesPerMergeStep = options.pagesPerMergeStep ?? DEFAULT_PAGES_PER_MERGE_STEP;
  const pauseBetweenMergeStepsMs = options.pauseBetweenMergeStepsMs ?? DEFAULT_PAUSE_BETWEEN_MERGE_STEPS_MS;
  const results: FtsTableReclaimResult[] = [];

  for (const table of RECLAIMABLE_FTS_TABLES) {
    if (!ftsTableExists(db, table)) continue;
    const mergeStep = db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES('merge', ?)`);
    let mergeSteps = 0;
    while (true) {
      const changesBefore = totalChanges(db);
      mergeStep.run(mergeSteps === 0 ? -pagesPerMergeStep : pagesPerMergeStep);
      mergeSteps += 1;
      if (totalChanges(db) - changesBefore < 2) break;
      await pauseWithoutHoldingTheProcess(pauseBetweenMergeStepsMs);
    }
    results.push({ table, mergeSteps });
  }

  logger.info('SYSTEM', 'FTS bloat reclaim finished', { tables: results });
  return results;
}

/**
 * Schedule the one-time FTS bloat reclaim on an unref'd timer, so worker startup and health
 * checks never wait for it. The marker is written when the timer fires, before the first merge
 * step: a worker killed mid-reclaim does not start over on every boot (merge steps already done
 * are committed, and a partly merged index is valid), while a worker stopped during the start
 * delay never reclaimed anything and schedules it again on its next start. Written at
 * scheduling time instead, a restart inside the delay skipped the reclaim forever. Returns
 * null when the reclaim already started once. If the marker cannot be written the reclaim is
 * skipped, since running without it would repeat the work on every boot.
 */
export function scheduleOneTimeFtsBloatReclaim(
  db: Database,
  options: FtsBloatReclaimOptions = {}
): ReturnType<typeof setTimeout> | null {
  const dataDir = options.dataDir ?? DATA_DIR;
  const markerPath = path.join(dataDir, RECLAIM_MARKER_FILENAME);
  if (existsSync(markerPath)) return null;

  const timer = setTimeout(() => {
    // Checked again: another schedule may have started it during the delay.
    if (existsSync(markerPath)) return;
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(markerPath, JSON.stringify({ startedAt: new Date().toISOString() }));
    } catch (error) {
      logger.warn('SYSTEM', 'Skipping FTS bloat reclaim: could not write its marker', { markerPath }, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    reclaimFtsBloatInBoundedSteps(db, options).catch(error => {
      logger.warn('SYSTEM', 'FTS bloat reclaim stopped before finishing', {}, error instanceof Error ? error : new Error(String(error)));
    });
  }, options.startDelayMs ?? DEFAULT_START_DELAY_MS);
  timer.unref?.();
  return timer;
}
