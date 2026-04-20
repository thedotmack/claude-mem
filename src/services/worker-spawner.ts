/**
 * Worker Spawner - Lightweight worker daemon lifecycle helper
 *
 * Extracted from worker-service.ts so that lightweight consumers (like the
 * MCP server running under Node) can ensure the worker daemon is running
 * without importing the full worker-service bundle, which transitively pulls
 * in `bun:sqlite` and the entire database layer.
 *
 * This module MUST NOT import anything that touches SQLite, ChromaDB, or the
 * worker business logic modules. Keep it lean on purpose.
 *
 * Dependency boundary note: this file imports from `SettingsDefaultsManager`,
 * `ProcessManager`, and `HealthMonitor`. None of those currently touch
 * `bun:sqlite` or any other Bun-only module. If any of them ever does, this
 * module's SQLite-free contract silently breaks and the build guardrail in
 * `scripts/build-hooks.js` is the only thing that catches it. Audit transitive
 * imports here when adding new helpers from the shared/infrastructure layers.
 */

import path from 'path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { logger } from '../utils/logger.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import {
  cleanStalePidFile,
  getPlatformTimeout,
  removePidFile,
  spawnDaemon,
  touchPidFile,
} from './infrastructure/ProcessManager.js';
import {
  isPortInUse,
  waitForHealth,
  waitForReadiness,
} from './infrastructure/HealthMonitor.js';

// Windows: avoid repeated spawn popups when startup fails (issue #921)
const WINDOWS_SPAWN_COOLDOWN_MS = 2 * 60 * 1000;

function getWorkerSpawnLockPath(): string {
  return path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), '.worker-start-attempted');
}

// Internal helpers — NOT exported. Only ensureWorkerStarted should be on the
// public surface; callers must not bypass the lifecycle by calling these
// directly. See PR #1645 review feedback for context.

function shouldSkipSpawnOnWindows(): boolean {
  if (process.platform !== 'win32') return false;
  const lockPath = getWorkerSpawnLockPath();
  if (!existsSync(lockPath)) return false;
  try {
    const modifiedTimeMs = statSync(lockPath).mtimeMs;
    return Date.now() - modifiedTimeMs < WINDOWS_SPAWN_COOLDOWN_MS;
  } catch (error) {
    if (error instanceof Error) {
      logger.debug('SYSTEM', 'Could not stat worker spawn lock file', {}, error);
    } else {
      logger.debug('SYSTEM', 'Could not stat worker spawn lock file', { error: String(error) });
    }
    return false;
  }
}

function markWorkerSpawnAttempted(): void {
  if (process.platform !== 'win32') return;
  try {
    const lockPath = getWorkerSpawnLockPath();
    // Ensure CLAUDE_MEM_DATA_DIR exists before writing the marker. On a fresh
    // user profile the directory may not exist yet, in which case writeFileSync
    // would throw ENOENT, the catch would swallow it, and the cooldown marker
    // would never be created — defeating the popup-loop protection that this
    // helper exists to provide. recursive: true is a no-op when the dir already
    // exists, so this is safe to call on every spawn attempt.
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '', 'utf-8');
  } catch {
    // APPROVED OVERRIDE: best-effort cooldown marker. If we can't even create
    // the data dir or write the marker, the worker spawn itself is almost
    // certainly going to fail too — surfacing that downstream gives the user
    // a far more useful error than a noisy log line about a lock file.
  }
}

function clearWorkerSpawnAttempted(): void {
  if (process.platform !== 'win32') return;
  try {
    const lockPath = getWorkerSpawnLockPath();
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {
    // APPROVED OVERRIDE: best-effort cleanup of the cooldown marker after a
    // successful spawn. A stale marker on disk is harmless — the worst case
    // is one suppressed retry within the cooldown window, then it self-heals.
  }
}

/**
 * Ensures the worker is started and healthy.
 *
 * @param port - The TCP port (used for port-in-use checks and daemon spawn)
 * @param workerScriptPath - Absolute path to the worker-service script to spawn.
 *                           Callers running inside worker-service pass `__filename`.
 *                           Callers outside (e.g., mcp-server) must resolve the
 *                           path to worker-service.cjs in the plugin's scripts dir.
 * @returns true if worker is healthy (existing or newly started), false on failure
 */
export async function ensureWorkerStarted(
  port: number,
  workerScriptPath: string
): Promise<boolean> {
  // Defensive guard: validate the worker script path before any health check
  // or spawn attempt. Without this, an empty string or missing file just
  // surfaces as a low-signal child_process error from spawnDaemon. Callers
  // should always pass a valid path, but a partial install or a regression
  // in path resolution upstream is much easier to debug with an explicit
  // log line at the entry point. See PR #1645 review feedback for context.
  if (!workerScriptPath) {
    logger.error('SYSTEM', 'ensureWorkerStarted called with empty workerScriptPath — caller bug');
    return false;
  }
  if (!existsSync(workerScriptPath)) {
    logger.error(
      'SYSTEM',
      'ensureWorkerStarted: worker script not found at expected path — likely a partial install or build artifact missing',
      { workerScriptPath }
    );
    return false;
  }

  // Clean stale PID file first (cheap: 1 fs read + 1 signal-0 check)
  const pidFileStatus = cleanStalePidFile();
  if (pidFileStatus === 'alive') {
    logger.info('SYSTEM', 'Worker PID file points to a live process, skipping duplicate spawn');
    const healthy = await waitForHealth(port, getPlatformTimeout(HOOK_TIMEOUTS.PORT_IN_USE_WAIT));
    if (healthy) {
      // A previous failed spawn may have left a stale Windows cooldown marker
      // on disk. Now that the worker is confirmed healthy via this alternate
      // path, clear it so a future genuine outage isn't suppressed for the
      // remainder of the 2-minute window. Per CodeRabbit on PR #1645.
      // No-op on non-Windows.
      clearWorkerSpawnAttempted();
      logger.info('SYSTEM', 'Worker became healthy while waiting on live PID');
      return true;
    }
    logger.warn('SYSTEM', 'Live PID detected but worker did not become healthy before timeout');
    return false;
  }

  // Check if worker is already running and healthy.
  // NOTE: Version mismatch auto-restart intentionally removed (#1435).
  if (await waitForHealth(port, 1000)) {
    // Same rationale as above: clear any stale cooldown marker now that we
    // know the worker is healthy via the fast-path health check.
    clearWorkerSpawnAttempted();
    const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
    if (!ready) {
      logger.warn('SYSTEM', 'Worker is alive but readiness timed out — proceeding anyway');
    }
    logger.info('SYSTEM', 'Worker already running and healthy');
    return true;
  }

  // Check if port is in use by something else
  const portInUse = await isPortInUse(port);
  if (portInUse) {
    logger.info('SYSTEM', 'Port in use, waiting for worker to become healthy');
    const healthy = await waitForHealth(port, getPlatformTimeout(HOOK_TIMEOUTS.PORT_IN_USE_WAIT));
    if (healthy) {
      // Same rationale as above.
      clearWorkerSpawnAttempted();
      logger.info('SYSTEM', 'Worker is now healthy');
      return true;
    }
    logger.error('SYSTEM', 'Port in use but worker not responding to health checks');
    return false;
  }

  // Windows: skip spawn if a recent attempt already failed (issue #921)
  if (shouldSkipSpawnOnWindows()) {
    logger.warn('SYSTEM', 'Worker unavailable on Windows — skipping spawn (recent attempt failed within cooldown)');
    return false;
  }

  // Spawn new worker daemon
  logger.info('SYSTEM', 'Starting worker daemon', { workerScriptPath });
  markWorkerSpawnAttempted();
  const pid = spawnDaemon(workerScriptPath, port);
  if (pid === undefined) {
    logger.error('SYSTEM', 'Failed to spawn worker daemon');
    return false;
  }

  // PID file is written by the worker itself after listen() succeeds
  const healthy = await waitForHealth(port, getPlatformTimeout(HOOK_TIMEOUTS.POST_SPAWN_WAIT));
  if (!healthy) {
    removePidFile();
    logger.error('SYSTEM', 'Worker failed to start (health check timeout)');
    return false;
  }

  // Health passed (HTTP listening). Now wait for DB + search initialization
  const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
  if (!ready) {
    logger.warn('SYSTEM', 'Worker is alive but readiness timed out — proceeding anyway');
  }

  clearWorkerSpawnAttempted();
  touchPidFile();
  logger.info('SYSTEM', 'Worker started successfully');
  return true;
}
