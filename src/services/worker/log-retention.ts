import { readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Only the logger's own daily files. `runner-errors.log`, legacy `worker-*.log`, `.bak` copies and anything else in the directory are never touched. */
const DAILY_LOG_NAME = /^claude-mem-(\d{4})-(\d{2})-(\d{2})\.log$/;

/**
 * `CLAUDE_MEM_LOG_RETENTION_DAYS` as a whole number of days. 0 means keep
 * forever, and so does anything that is not a plain non-negative integer: a
 * typo in a hand-edited settings.json must never widen a purge, and must never
 * stop the worker from starting. settings.json is hand-editable JSON, so the
 * value may arrive as an unquoted number (`30`) as well as a string (`"30"`);
 * both mean 30 days. Any other type is ignored.
 */
export function resolveLogRetentionDays(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  }
  if (typeof raw !== 'string') return 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const days = Number(trimmed);
  return Number.isSafeInteger(days) ? days : 0;
}

export interface LogPruneResult {
  removed: string[];
  bytes: number;
}

export type RemoveFile = (path: string) => void;

/**
 * Deletes `claude-mem-YYYY-MM-DD.log` files dated more than `retentionDays`
 * UTC days before today. The logger names files with `toISOString()`, so the
 * comparison is in UTC. Today's file and yesterday's are never candidates for
 * any positive retention: `/api/logs` and the viewer read today's file, and a
 * process that has not logged since midnight still holds yesterday's open.
 *
 * A file whose name is old but whose mtime is inside the window is kept too.
 * Before #4063 a long-lived daemon kept appending to its start-date file, so
 * an old name alone does not prove a file is finished.
 *
 * Each delete is its own attempt: a file Windows holds open (EBUSY/EPERM) is
 * skipped and retried on the next sweep, and the rest are still removed.
 * `retentionDays` of 0 keeps everything.
 */
export function pruneOldLogs(
  logsDir: string,
  retentionDays: number,
  nowEpoch: number = Date.now(),
  removeFile: RemoveFile = unlinkSync,
): LogPruneResult {
  const result: LogPruneResult = { removed: [], bytes: 0 };
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) return result;

  let names: string[];
  try {
    names = readdirSync(logsDir);
  } catch {
    // No logs directory yet: nothing to prune.
    return result;
  }

  const now = new Date(nowEpoch);
  const todayEpoch = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const windowMs = retentionDays * DAY_MS;

  for (const name of names) {
    const match = DAILY_LOG_NAME.exec(name);
    if (!match) continue;
    const fileDayEpoch = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (Number.isNaN(fileDayEpoch) || todayEpoch - fileDayEpoch <= windowMs) continue;

    const path = join(logsDir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || nowEpoch - stat.mtimeMs <= windowMs) continue;
      removeFile(path);
      result.removed.push(name);
      result.bytes += stat.size;
    } catch (error) {
      logger.debug('SYSTEM', 'Log retention skipped a file', { file: name },
        error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (result.removed.length > 0) {
    logger.info('SYSTEM', 'Pruned daily log files past retention', {
      files: result.removed.length,
      bytes: result.bytes,
      retentionDays,
    });
  }
  return result;
}
