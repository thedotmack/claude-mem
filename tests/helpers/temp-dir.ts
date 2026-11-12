import { rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * About 1.8 s in total. A SQLite connection that has just closed keeps the
 * directory busy on Windows for a moment, and the handle is only released
 * while the event loop runs, so the waits here are real yields, never a
 * blocking sleep.
 */
const REMOVAL_RETRY_DELAYS_MS = [0, 25, 75, 200, 500, 1000];
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

/**
 * Remove a test temp directory, retrying while the filesystem still reports it
 * busy. On Windows a SQLite connection that has just closed (or an antivirus or
 * indexer pass over the -wal and -shm files) keeps the directory undeletable
 * for a few hundred milliseconds, which otherwise turns a passing test into a
 * red afterEach and hides the assertion that actually ran.
 */
export async function removeTempDir(target: string): Promise<void> {
  let lastError: unknown;
  for (const wait of REMOVAL_RETRY_DELAYS_MS) {
    if (wait) await delay(wait);
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code && !RETRYABLE_CODES.has(code)) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
