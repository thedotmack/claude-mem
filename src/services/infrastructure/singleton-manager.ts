/**
 * Filesystem-based mutex for worker spawn coordination.
 *
 * Prevents TOCTOU race: only one process at a time can attempt to spawn
 * a worker daemon. Concurrent hook invocations that lose the lock race
 * fall back to waiting for port health.
 *
 * Uses proper-lockfile (same library npm uses for package-lock coordination).
 * Lock location: ~/.claude-mem/worker-spawn-<port>.lock
 */

import path from 'path';
import { homedir } from 'os';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import lockfile from 'proper-lockfile';
import { logger } from '../../utils/logger.js';

const DATA_DIR = path.join(homedir(), '.claude-mem');

/**
 * Acquire the spawn lock and execute the callback.
 * Returns null if the lock is already held (another process is spawning).
 * Lock path is per-port to support multiple worker instances.
 */
export async function acquireSpawnLock<T>(
  fn: () => Promise<T>,
  port: number = 37777
): Promise<T | null> {
  const lockPath = path.join(DATA_DIR, `worker-spawn-${port}.lock`);

  // Ensure lock file exists (proper-lockfile needs the file to exist)
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(lockPath)) {
    writeFileSync(lockPath, '');
  }

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(lockPath, {
      realpath: false,
      retries: 0,       // Don't wait — if locked, fall back immediately
      stale: 10_000     // Auto-release after 10s (handles crashed processes)
    });
  } catch (err: any) {
    if (err.code === 'ELOCKED') {
      logger.info('SYSTEM', 'Spawn lock held by another process — waiting for port health instead');
      return null;
    }
    // Non-lock errors (filesystem, permissions) — log and proceed without lock
    logger.warn('SYSTEM', 'Failed to acquire spawn lock, proceeding without', { error: err.message });
    return fn();
  }

  try {
    return await fn();
  } finally {
    if (release) {
      try { await release(); } catch {}
    }
  }
}
