import { dirname, join } from 'path';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { resolveDataDir } from './paths.js';

/**
 * Cross-launcher spawn lockfile (Phase 4 of
 * plans/2026-06-10-worker-restart-single-source-of-truth.md).
 *
 * Three independent launchers can try to start the worker at the same time —
 * hooks (src/shared/worker-utils.ts), the MCP server
 * (src/services/worker-spawner.ts), and the CLI restart fallback
 * (src/services/worker-service.ts). This gate gives
 * them mutual exclusion over the SPAWN only: whoever creates
 * `<DATA_DIR>/spawn.lock` with the `wx` flag (O_CREAT|O_EXCL — the create IS
 * the atomicity, no rename or lock library needed) is the one launcher allowed
 * to spawn; everyone else skips their spawn and waits for the winner's worker
 * to come up.
 *
 * Hard rules:
 * - The lock gates SPAWNING only — never health/readiness checks. A held lock
 *   must never make a hook FAIL, only wait for the holder's worker.
 * - Staleness is judged by the lock file's mtime (statSync().mtimeMs), never
 *   by clock values stored in the file content.
 * - The dying worker's restart handoff (src/services/worker-shutdown.ts) is
 *   deliberately NOT gated: it is the PRIMARY spawner on restart, and hooks
 *   wait for its successor instead of competing with it.
 */

/**
 * A holder that hasn't finished spawning within this window is presumed dead
 * (crashed mid-spawn); its lock may be broken. The longest in-lock wait any
 * holder performs is the ~15s post-spawn port/health wait, which
 * getPlatformTimeout scales 2.0x on Windows to ~30s — so the staleness window
 * must clear 30s, not 15s. 60s keeps a 2x margin over that worst case.
 */
const SPAWN_LOCK_STALE_MS = 60_000;

/**
 * Resolved at call time (resolveDataDir consults CLAUDE_MEM_DATA_DIR / the
 * settings file on each call) rather than binding paths.ts's import-time
 * DATA_DIR const, so every launcher — and the test suite, which points
 * CLAUDE_MEM_DATA_DIR at a temp dir — agrees on the same lock path.
 */
function getSpawnLockPath(): string {
  return join(resolveDataDir(), 'spawn.lock');
}

/**
 * Try to become the one launcher allowed to spawn the worker.
 *
 * Returns true when this process now holds the lock (caller MUST
 * releaseSpawnLock() in a finally). Returns false when another launcher holds
 * a fresh lock — the caller must SKIP its spawn and wait for the holder's
 * worker instead.
 *
 * A lock whose mtime is older than SPAWN_LOCK_STALE_MS is broken (unlinked)
 * and acquisition is retried exactly once.
 */
export function acquireSpawnLock(): boolean {
  const lockPath = getSpawnLockPath();
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, payload, { flag: 'wx' });
      return true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') {
        // Not contention — the filesystem refused the lock outright (EACCES,
        // EROFS, ...). Fail OPEN: the lock is a collision guard, not a
        // correctness gate, and a broken lock mechanism must degrade to the
        // pre-lock behavior (spawn anyway), never suppress every spawn
        // forever. releaseSpawnLock() is a no-op when no file was written.
        return true;
      }
      if (attempt > 0) {
        // We already broke one stale lock and someone re-acquired before us —
        // treat them as the live holder; never break twice.
        return false;
      }

      let mtimeMs: number;
      try {
        mtimeMs = statSync(lockPath).mtimeMs;
      } catch {
        // Lock vanished between the failed write and the stat — the holder
        // just released. Retry once via the loop.
        continue;
      }

      if (Date.now() - mtimeMs <= SPAWN_LOCK_STALE_MS) {
        // Fresh lock: another launcher is mid-spawn. Caller waits for its
        // worker instead of spawning a competitor.
        return false;
      }

      // Stale lock: the holder died mid-spawn. Re-stat immediately before
      // breaking it — if the mtime changed since we judged it stale, another
      // launcher already broke it and re-took the lock; unlinking now would
      // delete THEIR fresh lock and mint two winners. The re-stat narrows
      // that TOCTOU window from the whole staleness evaluation to a few
      // microseconds.
      let recheckedMtimeMs: number;
      try {
        recheckedMtimeMs = statSync(lockPath).mtimeMs;
      } catch {
        // Lock vanished between the staleness judgment and the re-stat —
        // either the holder released or a competing breaker won. Retry once
        // via the loop.
        continue;
      }
      if (recheckedMtimeMs !== mtimeMs) {
        // Re-taken (or refreshed) since we judged it stale — its new owner is
        // live; yield to them.
        return false;
      }

      try {
        // Break the stale lock and retry once.
        unlinkSync(lockPath);
      } catch {
        // The file vanished between the re-stat and the unlink (a competing
        // breaker's unlink won the race), or the filesystem refused the
        // delete (EPERM/EACCES). Either way we cannot claim the break —
        // yield.
        return false;
      }
    }
  }
  return false;
}

/**
 * Release the spawn lock IF this process owns it. Owner-checked: the file is
 * read back and only deleted when its pid matches process.pid, so a launcher
 * can never delete a competitor's live lock (e.g. after its own stale lock
 * was broken and re-acquired by someone else). All errors are swallowed —
 * release is best-effort; an orphaned lock self-heals via the staleness
 * breaker in acquireSpawnLock.
 */
export function releaseSpawnLock(): void {
  const lockPath = getSpawnLockPath();
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid?: unknown };
    if (lock.pid !== process.pid) return;
    unlinkSync(lockPath);
  } catch {
    // Missing, unreadable, or corrupt lock file — leave it alone; the
    // staleness breaker (SPAWN_LOCK_STALE_MS) reclaims anything orphaned.
  }
}
