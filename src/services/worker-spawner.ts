
import path from 'path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { logger } from '../utils/logger.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import {
  cleanStalePidFile,
  getPlatformTimeout,
  probeWorkerBootFailure,
  spawnDaemon,
  touchPidFile,
} from './infrastructure/ProcessManager.js';
import {
  isPortInUse,
  waitForHealth,
  waitForReadiness,
} from './infrastructure/HealthMonitor.js';
import { acquireSpawnLock, releaseSpawnLock } from '../shared/worker-spawn-gate.js';
import { isPidAlive } from '../supervisor/process-registry.js';
import { reclaimGhostListeningPort } from '../shared/port-reclaim.js';

const WINDOWS_SPAWN_COOLDOWN_MS = 2 * 60 * 1000;

function getWorkerSpawnLockPath(): string {
  return path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), '.worker-start-attempted');
}

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

export type WorkerStartResult = 'ready' | 'warming' | 'dead';

// Why the last spawn died, when we could prove it. ensureWorkerStarted returns
// a three-state verdict that callers switch on, and widening that union to
// carry a reason would churn every call site for a string only the failure
// branch ever has. Set immediately before returning 'dead', cleared on entry so
// a later failure can never be explained by an earlier one's diagnosis.
let lastWorkerBootFailure: string | undefined;

export function getLastWorkerBootFailure(): string | undefined {
  return lastWorkerBootFailure;
}

export async function ensureWorkerStarted(
  port: number,
  workerScriptPath: string
): Promise<WorkerStartResult> {
  lastWorkerBootFailure = undefined;

  if (!workerScriptPath) {
    logger.error('SYSTEM', 'ensureWorkerStarted called with empty workerScriptPath — caller bug');
    return 'dead';
  }
  if (!existsSync(workerScriptPath)) {
    logger.error(
      'SYSTEM',
      'ensureWorkerStarted: worker script not found at expected path — likely a partial install or build artifact missing',
      { workerScriptPath }
    );
    return 'dead';
  }

  const pidFileStatus = cleanStalePidFile();
  if (pidFileStatus === 'alive') {
    logger.info('SYSTEM', 'Worker PID file points to a live process, skipping duplicate spawn');
    const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
    if (ready) {
      clearWorkerSpawnAttempted();
      logger.info('SYSTEM', 'Worker became ready while waiting on live PID');
      return 'ready';
    }
    const workerStillHealthy = await waitForHealth(port, 1000);
    const workerPidStillAlive = cleanStalePidFile() === 'alive';
    if (!workerStillHealthy && !workerPidStillAlive) {
      logger.error('SYSTEM', 'Live PID disappeared before readiness endpoint became available');
      return 'dead';
    }
    logger.warn('SYSTEM', 'Live PID detected but worker did not become ready before timeout');
    return 'warming';
  }

  if (await waitForHealth(port, 1000)) {
    clearWorkerSpawnAttempted();
    const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
    if (!ready) {
      logger.warn('SYSTEM', 'Worker is alive but readiness timed out — proceeding anyway');
    }
    logger.info('SYSTEM', 'Worker already running and healthy');
    return ready ? 'ready' : 'warming';
  }

  const portInUse = await isPortInUse(port);
  if (portInUse) {
    logger.info('SYSTEM', 'Port in use, waiting for worker to become healthy');
    const healthy = await waitForHealth(port, getPlatformTimeout(HOOK_TIMEOUTS.PORT_IN_USE_WAIT));
    if (healthy) {
      clearWorkerSpawnAttempted();
      const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
      logger.info('SYSTEM', 'Worker is now healthy');
      return ready ? 'ready' : 'warming';
    }
    // The port is bound but nothing answers health. Usually this is a dead
    // worker whose surviving chroma sidecar chain (uvx -> uv -> python) holds
    // the inherited listening socket — a ghost listener under a dead PID
    // (plan-15 #3603). Without a reclaim the launcher returns 'dead' forever
    // and the port stays blocked until a human tree-kills the chain by hand.
    // Reclaim only fires when the owner is provably dead and the survivors
    // are chroma sidecars; a live owner keeps the old 'dead' behavior.
    const reclaim = await reclaimGhostListeningPort(port);
    if (reclaim.reclaimed) {
      logger.info('SYSTEM', 'Reclaimed ghost listener left by a dead worker — proceeding to spawn', {
        port,
        killedPids: reclaim.killedPids,
      });
      // The cooldown marker may have been written by the very spawn attempts
      // this ghost blocked; the reason for those failures is now gone, so a
      // time-based cooldown would only delay the recovery that just became
      // possible (the plan-15 "cooldowns keyed to evidence, not time" rule).
      clearWorkerSpawnAttempted();
    } else {
      logger.error('SYSTEM', 'Port in use but worker not responding to health checks', {
        port,
        reclaimReason: reclaim.reason,
      });
      return 'dead';
    }
  }

  if (shouldSkipSpawnOnWindows()) {
    logger.warn('SYSTEM', 'Worker unavailable on Windows — skipping spawn (recent attempt failed within cooldown)');
    return 'dead';
  }

  // Spawn gate (src/shared/worker-spawn-gate.ts): only ONE gated launcher —
  // hook, MCP server, or the CLI restart fallback — may spawn at a time. (The
  // dying worker's restart handoff in worker-shutdown.ts is deliberately NOT
  // gated: it is the primary spawner on restart, and hooks wait for its
  // successor.) Losing the lock never fails this path; the loser skips its
  // spawn and waits for the holder's worker. The winner holds the lock through
  // the readiness wait and releases it in finally on every exit path.
  const spawnLockHeld = acquireSpawnLock();
  let spawnedPid: number | undefined;
  try {
    if (spawnLockHeld) {
      logger.info('SYSTEM', 'Starting worker daemon', { workerScriptPath });
      markWorkerSpawnAttempted();
      spawnedPid = spawnDaemon(workerScriptPath, port);
      if (spawnedPid === undefined) {
        logger.error('SYSTEM', 'Failed to spawn worker daemon');
        return 'dead';
      }
    } else {
      logger.info('SYSTEM', 'Another launcher holds the spawn lock — skipping duplicate spawn and waiting for its worker');
    }

    const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
    if (!ready) {
      const workerStillHealthy = await waitForHealth(port, 1000);
      const workerPidStillAlive = cleanStalePidFile() === 'alive';
      const spawnedProcessStillAlive = spawnedPid !== undefined && spawnedPid > 0 && isPidAlive(spawnedPid);
      if (!workerStillHealthy && !workerPidStillAlive && !spawnedProcessStillAlive) {
        if (!spawnLockHeld) {
          logger.error('SYSTEM', 'Spawn-lock holder never produced a live worker before readiness timed out');
          return 'dead';
        }
        // We launched it and it is gone, so the bundle itself is the suspect —
        // and its stderr went to a hidden window. Ask it again where we can
        // hear the answer.
        lastWorkerBootFailure = probeWorkerBootFailure(workerScriptPath);
        logger.error(
          'SYSTEM',
          'Worker exited before readiness endpoint became available',
          lastWorkerBootFailure ? { bootFailure: lastWorkerBootFailure } : {}
        );
        return 'dead';
      }
      logger.warn('SYSTEM', spawnLockHeld
        ? 'Worker spawned but readiness endpoint not responding within window'
        : 'Spawn-lock holder\'s worker not ready within window');
      return 'warming';
    }
    clearWorkerSpawnAttempted();
    // touchPidFile is existsSync-guarded and merely refreshes the live worker's
    // pid-file mtime — correct for lock losers too, since the worker IS up.
    touchPidFile();
    logger.info('SYSTEM', spawnLockHeld
      ? 'Worker started successfully'
      : 'Worker is up (started by another launcher)');
    return 'ready';
  } finally {
    if (spawnLockHeld) releaseSpawnLock();
  }
}
