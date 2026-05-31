
import path from 'path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { logger } from '../utils/logger.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import {
  cleanStalePidFile,
  getPlatformTimeout,
  spawnDaemon,
  touchPidFile,
  readPidFile,
  isProcessAlive,
} from './infrastructure/ProcessManager.js';
import {
  isPortInUse,
  waitForHealth,
  waitForReadiness,
  waitForPortFree,
  httpShutdown,
  checkVersionMatch,
  type VersionCheckResult,
} from './infrastructure/HealthMonitor.js';
import type { PidInfo } from '../supervisor/process-registry.js';

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

const GRACEFUL_SHUTDOWN_PORT_WAIT_MS = 5000;
const POST_KILL_PORT_WAIT_MS = 5000;

export interface StaleWorkerDeps {
  httpShutdown: (port: number) => Promise<boolean>;
  waitForPortFree: (port: number, ms: number) => Promise<boolean>;
  readPidFile: () => PidInfo | null;
  killProcess: (pid: number, signal: NodeJS.Signals) => void;
  isProcessAlive: (pid: number) => boolean;
}

const defaultStaleWorkerDeps: StaleWorkerDeps = {
  httpShutdown,
  waitForPortFree,
  readPidFile,
  killProcess: (pid, signal) => { process.kill(pid, signal); },
  isProcessAlive,
};

/**
 * Terminate a worker that is running but reports a stale version, freeing the
 * port so a current worker can take over (#2601). Tries graceful HTTP shutdown
 * first, then SIGKILL on the PID-file pid as a fallback. Returns true iff the
 * port is free afterwards.
 */
export async function terminateStaleWorker(
  port: number,
  deps: StaleWorkerDeps = defaultStaleWorkerDeps
): Promise<boolean> {
  await deps.httpShutdown(port);
  if (await deps.waitForPortFree(port, GRACEFUL_SHUTDOWN_PORT_WAIT_MS)) {
    return true;
  }

  const pidInfo = deps.readPidFile();
  if (!pidInfo || !deps.isProcessAlive(pidInfo.pid)) {
    logger.warn('SYSTEM', 'Stale worker did not release port and no live pid to kill', { port });
    return false;
  }

  try {
    deps.killProcess(pidInfo.pid, 'SIGKILL');
  } catch (error) {
    logger.warn('SYSTEM', 'SIGKILL on stale worker failed', { pid: pidInfo.pid }, error as Error);
    return false;
  }
  return await deps.waitForPortFree(port, POST_KILL_PORT_WAIT_MS);
}

export interface VersionGateDeps {
  checkVersionMatch: (port: number) => Promise<VersionCheckResult>;
  terminateStaleWorker: (port: number) => Promise<boolean>;
}

const defaultVersionGateDeps: VersionGateDeps = {
  checkVersionMatch,
  terminateStaleWorker: (port) => terminateStaleWorker(port),
};

export type VersionGateOutcome = 'reuse' | 'replace' | 'keep';

/**
 * Gate a healthy worker on `port` before reuse: if it reports a stale version
 * (#2601), terminate it so a current worker can take over. Conservative — only
 * replaces on a CONFIRMED version mismatch; if the running version is unknowable
 * (`checkVersionMatch` returns matches:true for that case) it reuses.
 */
export async function reuseOrReplaceStaleWorker(
  port: number,
  deps: VersionGateDeps = defaultVersionGateDeps
): Promise<VersionGateOutcome> {
  const check = await deps.checkVersionMatch(port);
  if (check.matches) return 'reuse';

  logger.info('SYSTEM', 'Healthy worker is running a stale version — replacing', {
    pluginVersion: check.pluginVersion,
    workerVersion: check.workerVersion,
  });

  const freed = await deps.terminateStaleWorker(port);
  if (!freed) {
    logger.warn('SYSTEM', 'Could not free port from stale worker — keeping existing worker', { port });
    return 'keep';
  }
  return 'replace';
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

  const pidFileStatus = cleanStalePidFile();
  if (pidFileStatus === 'alive') {
    logger.info('SYSTEM', 'Worker PID file points to a live process, skipping duplicate spawn');
    const healthy = await waitForHealth(port, getPlatformTimeout(HOOK_TIMEOUTS.PORT_IN_USE_WAIT));
    if (healthy) {
      clearWorkerSpawnAttempted();
      const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
      logger.info('SYSTEM', 'Worker became healthy while waiting on live PID');
      return ready ? 'ready' : 'warming';
    }
    logger.warn('SYSTEM', 'Live PID detected but worker did not become healthy before timeout — likely still starting');
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
    logger.error('SYSTEM', 'Port in use but worker not responding to health checks');
    return 'dead';
  }

  if (shouldSkipSpawnOnWindows()) {
    logger.warn('SYSTEM', 'Worker unavailable on Windows — skipping spawn (recent attempt failed within cooldown)');
    return 'dead';
  }

  logger.info('SYSTEM', 'Starting worker daemon', { workerScriptPath });
  markWorkerSpawnAttempted();
  const pid = spawnDaemon(workerScriptPath, port);
  if (pid === undefined) {
    logger.error('SYSTEM', 'Failed to spawn worker daemon');
    return 'dead';
  }

  const healthy = await waitForHealth(port, getPlatformTimeout(HOOK_TIMEOUTS.POST_SPAWN_WAIT));
  if (!healthy) {
    logger.warn('SYSTEM', 'Worker spawned but health endpoint not responding within window — likely still starting in background');
    return 'warming';
  }

  const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
  if (!ready) {
    logger.warn('SYSTEM', 'Worker is alive but readiness timed out — proceeding anyway');
  }

  clearWorkerSpawnAttempted();
  touchPidFile();
  logger.info('SYSTEM', 'Worker started successfully');
  return ready ? 'ready' : 'warming';
}
