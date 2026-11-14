import { logger } from '../../utils/logger.js';

/**
 * Waits before each retry of a database init that failed with SQLITE_BUSY*.
 * Six attempts in all, about 31 s of waiting plus each attempt's own busy wait.
 * That is long enough for another connection to finish a write and short enough
 * that a lock that never goes away still ends in `failed`, where readers can see it.
 */
export const DB_INIT_BUSY_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];

/**
 * True for SQLITE_BUSY and its extended codes (SQLITE_BUSY_SNAPSHOT,
 * SQLITE_BUSY_RECOVERY, SQLITE_BUSY_TIMEOUT). Each one means another connection
 * held the database at that moment. None of them means the file is bad.
 *
 * SQLITE_BUSY_SNAPSHOT is the reason this retry exists. In WAL mode, a
 * transaction that starts by reading and then writes fails with it when another
 * connection committed in between. SQLite returns it at once and never calls the
 * busy handler, so `PRAGMA busy_timeout` does not help. Only running the work
 * again does.
 *
 * SQLITE_LOCKED is not included: it is a conflict inside one connection, so
 * running the work again would hit it again.
 */
export function isTransientSqliteBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^SQLITE_BUSY(_|$)/.test(code);
}

export interface RetryableDatabaseInit {
  initialize(): Promise<void>;
  /** Must undo everything a partial `initialize()` started, so the next attempt starts clean. */
  close(): Promise<void>;
}

export interface DbInitBusyRetryOptions {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** Checked before each retry. When it returns true, the last error is thrown without another attempt. */
  shouldStop?: () => boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Runs `db.initialize()`. When it fails with SQLITE_BUSY*, closes what it
 * opened, waits, and runs it again, up to `delaysMs.length` more times.
 * Any other error, the last busy error, and a busy error after `shouldStop()`
 * are thrown to the caller unchanged.
 */
export async function initializeDatabaseWithBusyRetry(
  db: RetryableDatabaseInit,
  options: DbInitBusyRetryOptions = {},
): Promise<void> {
  const delaysMs = options.delaysMs ?? DB_INIT_BUSY_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      await db.initialize();
      if (attempt > 0) logger.info('DB', 'Database initialized after busy retries', { retries: attempt });
      return;
    } catch (error) {
      if (!isTransientSqliteBusy(error) || attempt >= delaysMs.length || options.shouldStop?.()) throw error;
      const delayMs = delaysMs[attempt];
      logger.warn('DB', 'Database busy during initialization; closing and retrying', {
        code: (error as { code?: unknown }).code as string,
        attempt: attempt + 1,
        maxRetries: delaysMs.length,
        delayMs,
      });
      try {
        await db.close();
      } catch (closeError) {
        // A half-closed manager is not a clean start for another attempt.
        // Report the busy error that started this, not the close failure.
        logger.warn('DB', 'Could not close the database after a busy init; not retrying', {}, closeError as Error);
        throw error;
      }
      await sleep(delayMs);
      if (options.shouldStop?.()) throw error;
    }
  }
}
