import path from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { Database } from 'bun:sqlite';
import { DATA_DIR } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

// FTS5 external-content indexes delete logically: removing a row appends a
// delete-marker segment rather than reclaiming the original postings. Neither
// VACUUM nor auto_vacuum can compact this — only an FTS 'optimize' (or
// 'rebuild') merges the segments and drops the deleted-row content. Without it,
// a heavy-delete install grows an unbounded shadow index: #2793 reported a
// user_prompts_fts data table reaching ~12GB against an 18MB source table,
// reclaimable only via the manual troubleshooting recipe. Running a throttled
// optimize on startup makes that reclaim automatic.

const MARKER_FILENAME = '.fts-optimize-applied';
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

// Constant identifiers (never user input), so interpolating them into the
// maintenance statements below is not dynamic SQL.
const FTS_TABLES = ['observations_fts', 'session_summaries_fts', 'user_prompts_fts'] as const;

interface MarkerPayload {
  optimizedAt: string;
  tables: string[];
}

export interface FtsOptimizeResult {
  optimized: boolean;
  tables: string[];
}

function ftsTableExists(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row != null;
}

function readLastOptimizedAt(markerPath: string): number | null {
  if (!existsSync(markerPath)) return null;
  try {
    const payload = JSON.parse(readFileSync(markerPath, 'utf-8')) as MarkerPayload;
    const parsed = Date.parse(payload.optimizedAt);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    // A corrupt/unreadable marker should not wedge maintenance forever — treat
    // it as "never optimized" so the next run rewrites a clean marker.
    return null;
  }
}

/**
 * Compact the app's FTS5 indexes, throttled to at most once per `intervalMs`
 * via a marker file in the data directory. Safe to call on every worker
 * startup: it no-ops when it ran recently and skips FTS tables that do not
 * exist. Returns whether any table was optimized (false when throttled or when
 * there are no FTS tables).
 */
export function runPeriodicFtsOptimize(
  db: Database,
  options: { dataDir?: string; intervalMs?: number; now?: number } = {},
): FtsOptimizeResult {
  const dataDir = options.dataDir ?? DATA_DIR;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = options.now ?? Date.now();
  const markerPath = path.join(dataDir, MARKER_FILENAME);

  const lastOptimizedAt = readLastOptimizedAt(markerPath);
  if (lastOptimizedAt != null && now - lastOptimizedAt < intervalMs) {
    logger.debug('SYSTEM', 'FTS optimize skipped — ran within throttle window', {
      lastOptimizedAt,
      intervalMs,
    });
    return { optimized: false, tables: [] };
  }

  const optimized: string[] = [];
  for (const table of FTS_TABLES) {
    if (!ftsTableExists(db, table)) continue;
    try {
      db.run(`INSERT INTO ${table}(${table}) VALUES('optimize')`);
      optimized.push(table);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('SYSTEM', `FTS optimize failed for ${table}`, {}, err);
    }
  }

  try {
    mkdirSync(dataDir, { recursive: true });
    const payload: MarkerPayload = { optimizedAt: new Date(now).toISOString(), tables: optimized };
    writeFileSync(markerPath, JSON.stringify(payload, null, 2));
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', 'Failed to write FTS optimize marker', {}, err);
  }

  if (optimized.length > 0) {
    logger.info('SYSTEM', 'FTS indexes optimized', { tables: optimized });
  }

  return { optimized: optimized.length > 0, tables: optimized };
}
