
import path from 'path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { logger } from '../utils/logger.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import {
  cleanStalePidFile,
  getPlatformTimeout,
  readPidFile,
  spawnDaemon,
  touchPidFile,
} from './infrastructure/ProcessManager.js';
import {
  isPortInUse,
  waitForHealth,
  waitForReadiness,
} from './infrastructure/HealthMonitor.js';
import { reclaimWorkerPort } from './infrastructure/PortReclaim.js';
import { acquireSpawnLock, releaseSpawnLock } from '../shared/worker-spawn-gate.js';
import { isPidAlive } from '../supervisor/process-registry.js';
import {
  findFailoverPort,
  recordFailoverPort,
  reconcileFailoverPort,
} from '../shared/worker-port-failover.js';

const WINDOWS_SPAWN_COOLDOWN_MS = 2 * 60 * 1000;

/**
 * The port the user configured, ignoring any failover currently in effect.
 *
 * Read straight from settings rather than through worker-utils' getWorkerPort:
 * that module pulls in the whole hook/runtime graph, and this file is a leaf
 * that the spawner tests mock ProcessManager underneath. Keeping the
 * dependency local keeps that seam intact.
 */
function getConfiguredWorkerPort(): number {
  return parseInt(SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT'), 10);
}

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

type ReclaimResolution =
  | { action: 'spawn'; port: number }
  | { action: 'return'; result: WorkerStartResult };

/**
 * Decide what to do about a worker port that is occupied by nothing healthy.
 *
 * Delegates the ownership question to PortReclaim — which never signals a
 * process it cannot tie to claude-mem's own records by start token — and turns
 * its verdict into an action:
 *
 *   reclaimed         -> spawn here, the port is ours again
 *   owner-initializing-> leave it alone, report 'warming'
 *   failed            -> we owned it and could not clear it, report 'dead'
 *   unprovable        -> touch nothing, move to a different port
 *
 * The `unprovable` branch is what makes this safe to ship: when the occupant
 * might be an unrelated local service, we relocate rather than kill.
 */
async function resolveOccupiedPort(port: number): Promise<ReclaimResolution> {
  const outcome = await reclaimWorkerPort(port, readPidFile());

  switch (outcome.kind) {
    case 'reclaimed':
      logger.info('SYSTEM', 'Reclaimed the worker port — spawning a fresh worker', {
        port,
        via: outcome.via,
      });
      return { action: 'spawn', port };

    case 'owner-initializing':
      return { action: 'return', result: 'warming' };

    case 'failed':
      logger.error('SYSTEM', 'Could not reclaim the worker port from our own worker', {
        port,
        reason: outcome.reason,
      });
      return { action: 'return', result: 'dead' };

    case 'unprovable': {
      const configuredPort = getConfiguredWorkerPort();
      const failoverPort = await findFailoverPort(configuredPort);
      if (failoverPort === null) {
        logger.error('SYSTEM', 'Worker port is occupied and no alternate port is bindable', {
          port,
          reason: outcome.reason,
        });
        return { action: 'return', result: 'dead' };
      }
      // Nothing to invalidate: getWorkerPort() resolves the failover record on
      // every call precisely so a port change cannot be missed by a client
      // holding a stale cache.
      recordFailoverPort(failoverPort, configuredPort, outcome.reason);
      return { action: 'spawn', port: failoverPort };
    }
  }
}

export async function ensureWorkerStarted(
  port: number,
  workerScriptPath: string
): Promise<WorkerStartResult> {
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

  // Reclaim is bounded to ONE attempt per invocation (#3448): if the worker we
  // just cleared the way for also wedges, it is reported as 'warming' and left
  // for the next call, so this can never become a kill/respawn loop.
  let reclaimAttempted = false;
  // The port we will actually spawn on. Diverges from `port` only when the
  // configured port is held by something we cannot prove is ours.
  let activePort = port;

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
    // #3448: a live owner that never answers health leaves this branch
    // returning 'warming' forever — memory capture stays down until someone
    // restarts the worker by hand. Escalate instead. reclaimWorkerPort re-probes
    // health itself and refuses to touch an owner that is merely initializing,
    // so a slow cold boot is still safe.
    if (!workerStillHealthy && workerPidStillAlive && !reclaimAttempted) {
      logger.warn('SYSTEM', 'Live PID owns the worker port but never became healthy — escalating to reclaim');
      reclaimAttempted = true;
      const resolution = await resolveOccupiedPort(port);
      if (resolution.action === 'return') return resolution.result;
      activePort = resolution.port;
      clearWorkerSpawnAttempted();
    } else {
      logger.warn('SYSTEM', 'Live PID detected but worker did not become ready before timeout');
      return 'warming';
    }
  }

  if (activePort === port && (await waitForHealth(port, 1000))) {
    clearWorkerSpawnAttempted();
    const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
    if (!ready) {
      logger.warn('SYSTEM', 'Worker is alive but readiness timed out — proceeding anyway');
    }
    logger.info('SYSTEM', 'Worker already running and healthy');
    return ready ? 'ready' : 'warming';
  }

  if (activePort === port && (await isPortInUse(port))) {
    logger.info('SYSTEM', 'Port in use, waiting for worker to become healthy');
    const healthy = await waitForHealth(port, getPlatformTimeout(HOOK_TIMEOUTS.PORT_IN_USE_WAIT));
    if (healthy) {
      clearWorkerSpawnAttempted();
      const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
      logger.info('SYSTEM', 'Worker is now healthy');
      return ready ? 'ready' : 'warming';
    }
    // The port is held but nothing healthy answers (#3073, #3450). Previously
    // this returned `dead` and the port stayed wedged until the OS released it,
    // blocking every subsequent restart. Now: reclaim it if we can prove it is
    // ours, and move to a different port if we cannot.
    if (reclaimAttempted) {
      logger.error('SYSTEM', 'Port still unhealthy after this invocation already attempted a reclaim');
      return 'dead';
    }
    logger.warn('SYSTEM', 'Port in use but no healthy worker responded — attempting recovery');
    reclaimAttempted = true;
    const resolution = await resolveOccupiedPort(port);
    if (resolution.action === 'return') return resolution.result;
    activePort = resolution.port;
    // A stale Windows cooldown marker from the failed attempt must not now
    // suppress the fresh spawn we just cleared the way for.
    clearWorkerSpawnAttempted();
  }

  // Nothing is squatting the configured port any more, so a failover record
  // left over from a previous incident should not keep pinning clients
  // elsewhere (#3484).
  if (activePort === port) {
    reconcileFailoverPort(getConfiguredWorkerPort(), !(await isPortInUse(getConfiguredWorkerPort())));
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
      logger.info('SYSTEM', 'Starting worker daemon', { workerScriptPath, port: activePort });
      markWorkerSpawnAttempted();
      spawnedPid = spawnDaemon(workerScriptPath, activePort);
      if (spawnedPid === undefined) {
        logger.error('SYSTEM', 'Failed to spawn worker daemon');
        return 'dead';
      }
    } else {
      logger.info('SYSTEM', 'Another launcher holds the spawn lock — skipping duplicate spawn and waiting for its worker');
    }

    const ready = await waitForReadiness(activePort, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
    if (!ready) {
      const workerStillHealthy = await waitForHealth(activePort, 1000);
      const workerPidStillAlive = cleanStalePidFile() === 'alive';
      const spawnedProcessStillAlive = spawnedPid !== undefined && spawnedPid > 0 && isPidAlive(spawnedPid);
      if (!workerStillHealthy && !workerPidStillAlive && !spawnedProcessStillAlive) {
        logger.error('SYSTEM', spawnLockHeld
          ? 'Worker exited before readiness endpoint became available'
          : 'Spawn-lock holder never produced a live worker before readiness timed out');
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
