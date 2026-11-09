import { readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { logger } from '../../utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Only the logger's own daily files and the auto-updater's attempt logs. `runner-errors.log`, legacy `worker-*.log`, `.bak` copies and anything else in the directory are never touched. */
const DAILY_LOG_NAME = /^claude-mem-(\d{4})-(\d{2})-(\d{2})\.log$/;

/**
 * One auto-update attempt's log: `auto-update-<epoch ms the attempt started>.log`
 * (auto-update-launch.ts autoUpdateAttemptLogPath; tests/worker/log-retention.test.ts
 * builds its names with that function). Named by an instant, not a day, so its
 * day is the UTC day it started.
 */
const AUTO_UPDATE_ATTEMPT_LOG_NAME = /^auto-update-(\d+)\.log$/;

export interface LogPruneResult {
  removed: string[];
  bytes: number;
}

export type RemoveFile = (path: string) => Promise<void>;

/**
 * Deletes `claude-mem-YYYY-MM-DD.log` files dated more than `retentionDays`
 * UTC days before today, and `auto-update-<epoch ms>.log` attempt logs started
 * that long ago, by the same rules. The logger names files with
 * `toISOString()`, so the comparison is in UTC. Today's file and yesterday's are never candidates for
 * any positive retention: `/api/logs` and the viewer read today's file, and a
 * process that has not logged since midnight still holds yesterday's open.
 *
 * A file whose name is old but whose mtime is inside the window is kept too.
 * Before #4063 a long-lived daemon kept appending to its start-date file, so
 * an old name alone does not prove a file is finished.
 *
 * All filesystem calls are async and awaited one file at a time, so a backlog
 * sweep on a slow or AV-scanned disk never blocks the worker's event loop
 * (health checks and hook requests keep being served while it runs).
 *
 * Each delete is its own attempt: a file Windows holds open (EBUSY/EPERM) is
 * skipped and retried on the next sweep, and the rest are still removed.
 * `retentionDays` of 0 keeps everything.
 */
export async function pruneOldLogs(
  logsDir: string,
  retentionDays: number,
  nowEpoch: number = Date.now(),
  removeFile: RemoveFile = unlink,
): Promise<LogPruneResult> {
  const result: LogPruneResult = { removed: [], bytes: 0 };
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) return result;

  let names: string[];
  try {
    names = await readdir(logsDir);
  } catch {
    // No logs directory yet: nothing to prune.
    return result;
  }

  const now = new Date(nowEpoch);
  const todayEpoch = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const windowMs = retentionDays * DAY_MS;

  for (const name of names) {
    const fileDayEpoch = logFileDayEpoch(name);
    if (fileDayEpoch === null || Number.isNaN(fileDayEpoch) || todayEpoch - fileDayEpoch <= windowMs) continue;

    const path = join(logsDir, name);
    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile() || nowEpoch - fileStat.mtimeMs <= windowMs) continue;
      await removeFile(path);
      result.removed.push(name);
      result.bytes += fileStat.size;
    } catch (error) {
      logger.debug('SYSTEM', 'Log retention skipped a file', { file: name },
        error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (result.removed.length > 0) {
    logger.info('SYSTEM', 'Pruned log files past retention', {
      files: result.removed.length,
      bytes: result.bytes,
      retentionDays,
    });
  }
  return result;
}

/** The UTC day (epoch ms of its midnight) a retained log file is dated, or null for a name retention never touches. */
function logFileDayEpoch(name: string): number | null {
  const daily = DAILY_LOG_NAME.exec(name);
  if (daily) return Date.UTC(Number(daily[1]), Number(daily[2]) - 1, Number(daily[3]));
  const attempt = AUTO_UPDATE_ATTEMPT_LOG_NAME.exec(name);
  if (!attempt) return null;
  const startedAt = Number(attempt[1]);
  if (!Number.isSafeInteger(startedAt)) return null;
  const started = new Date(startedAt);
  return Date.UTC(started.getUTCFullYear(), started.getUTCMonth(), started.getUTCDate());
}
