
import path from 'path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { logger } from '../utils/logger.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import {
  cleanStalePidFile,
  getPlatformTimeout,
  spawnDaemon,
  touchPidFile,
} from './infrastructure/ProcessManager.js';
import {
  isPortInUse,
  waitForHealth,
  waitForReadiness,
  waitForPortFree,
} from './infrastructure/HealthMonitor.js';
import { acquireSpawnLock, releaseSpawnLock } from '../shared/worker-spawn-gate.js';

const WINDOWS_SPAWN_COOLDOWN_MS = 30 * 1000;  // #2996: reduced from 2min to 30s

/**
 * #2996: On Windows, when the port is bound but health checks fail (zombie worker),
 * try to kill the stale process holding the port. Uses netstat to find the PID,
 * then taskkill to terminate it. Without this, the spawn attempt fails with
 * EADDRINUSE, the cooldown kicks in, and all concurrent sessions are blocked.
 */
async function reapStalePortHolderOnWindows(port: number): Promise<void> {
  if (process.platform !== 'win32') return;

  try {
    // Find PID holding the port using netstat
    // #2996: use raw netstat output and filter in JS to avoid findstr prefix matching
    // (e.g. findstr :3000 would falsely match :30000)
    const netstatResult = execSync(`netstat -ano`, {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5000,
    });

    // Parse and filter lines: must match exact port number and be in LISTENING state
    const portPattern = new RegExp(`\\b${port}\\b`);
    const lines = netstatResult
      .split('\n')
      .filter(line => {
        const parts = line.trim().split(/\s+/);
        // netstat format: Protocol Local Address Foreign Address State PID
        if (parts.length < 5) return false;
        const [_proto, localAddr, _foreign, state, _pid] = parts;
        return state === 'LISTENING' && portPattern.test(localAddr);
      });

    if (lines.length === 0) {
      logger.debug('SYSTEM', 'No process found holding exact port', { port });
      return;
    }

    // Parse PID from first matching line
    const firstLine = lines[0];
    const parts = firstLine.trim().split(/\s+/);
    const pid = parseInt(parts[parts.length - 1], 10);

    if (!pid || pid <= 0) {
      logger.debug('SYSTEM', 'Could not parse PID from netstat output', { port, output: firstLine });
      return;
    }

    // Verify ownership: check command line for claude-mem/worker
    // Try wmic first, fall back to tasklist if wmic is unavailable
    let isOurWorker: boolean = false;
    try {
      const wmicResult = execSync(`wmic process where ProcessId=${pid} get CommandLine /FORMAT:LIST`, {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 3000,
      });

      const cmdLine = wmicResult.toLowerCase();
      isOurWorker = cmdLine.includes('claude-mem') ||
                    cmdLine.includes('worker-service');
    } catch (wmicError) {
      // #2996: wmic may be unavailable on some Windows installs.
      // Fall back to tasklist to verify process name is bun or node.
      logger.debug('SYSTEM', 'wmic unavailable, falling back to tasklist', {
        port, pid,
        error: wmicError instanceof Error ? wmicError.message : String(wmicError),
      });
      try {
        const tasklistResult = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
          encoding: 'utf-8',
          windowsHide: true,
          timeout: 3000,
        });

        const procLine = tasklistResult.toLowerCase();
        isOurWorker = procLine.includes('bun') || procLine.includes('node');

        if (!isOurWorker) {
          logger.warn('SYSTEM', 'Port held by non-bun/node process, skipping reap', {
            port, pid, process: tasklistResult.trim(),
          });
          return;
        }
      } catch (tasklistError) {
        // #2996: both wmic and tasklist failed - verification is mandatory
        logger.warn('SYSTEM', 'Could not verify process ownership, skipping reap', {
          port, pid,
          error: tasklistError instanceof Error ? tasklistError.message : String(tasklistError),
        });
        return;
      }
    }

    if (!isOurWorker) {
      logger.warn('SYSTEM', 'Port held by non-claude-mem process, skipping reap', {
        port, pid,
      });
      return;
    }

    logger.warn('SYSTEM', 'Reaping stale claude-mem worker process holding port', { port, pid });

    // Kill the stale process
    execSync(`taskkill /PID ${pid} /F /T`, {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 5000,
    });

    // Wait a bit for the port to be released
    await new Promise<void>(resolve => setTimeout(resolve, 1000));

    logger.info('SYSTEM', 'Successfully reaped stale claude-mem worker process', { port, pid });
  } catch (error) {
    logger.debug('SYSTEM', 'Failed to reap stale port holder (non-critical)', {
      port,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
    logger.warn('SYSTEM', 'Live PID detected but worker did not become healthy before timeout—likely still starting');
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

    // #2996: Port is bound but health checks failed - likely a zombie worker.
    // On Windows, try to reap the stale process holding the port before giving up.
    // This prevents the spawn attempt from failing with EADDRINUSE and triggering
    // the cooldown that blocks all concurrent sessions.
    await reapStalePortHolderOnWindows(port);

    // After reaping, check if port is now free and worker can be spawned
    const portFree = await waitForPortFree(port, 3000);
    if (portFree) {
      // #2996: clear cooldown marker so shouldSkipSpawnOnWindows() won't block the respawn
      clearWorkerSpawnAttempted();
      logger.info('SYSTEM', 'Port freed after reaping stale process, proceeding with spawn');
      // Fall through to spawn logic below
    } else {
      logger.error('SYSTEM', 'Port in use but worker not responding to health checks (reap failed or port still held)');
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
  // spawn and falls through to the SAME wait-for-health/readiness logic
  // (someone else is spawning — wait for their worker). The winner holds the
  // lock through the post-spawn health wait (the spawn isn't "done" until the
  // worker owns the port) and releases in finally on every exit path.
  const spawnLockHeld = acquireSpawnLock();
  try {
    if (spawnLockHeld) {
      logger.info('SYSTEM', 'Starting worker daemon', { workerScriptPath });
      markWorkerSpawnAttempted();
      const pid = spawnDaemon(workerScriptPath, port);
      if (pid === undefined) {
        logger.error('SYSTEM', 'Failed to spawn worker daemon');
        return 'dead';
      }
    } else {
      logger.info('SYSTEM', 'Another launcher holds the spawn lock — skipping duplicate spawn and waiting for its worker');
    }

    const healthy = await waitForHealth(port, getPlatformTimeout(HOOK_TIMEOUTS.POST_SPAWN_WAIT));
    if (!healthy) {
      logger.warn('SYSTEM', spawnLockHeld
        ? 'Worker spawned but health endpoint not responding within window — likely still starting in background'
        : 'Spawn-lock holder\'s worker not healthy within window — likely still starting in background');
      return 'warming';
    }
  } finally {
    if (spawnLockHeld) releaseSpawnLock();
  }

  const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
  if (!ready) {
    logger.warn('SYSTEM', 'Worker is alive but readiness timed out — proceeding anyway');
  }

  clearWorkerSpawnAttempted();
  // touchPidFile is existsSync-guarded and merely refreshes the live worker's
  // pid-file mtime — correct for lock losers too, since the worker IS up.
  touchPidFile();
  logger.info('SYSTEM', spawnLockHeld
    ? 'Worker started successfully'
    : 'Worker is up (started by another launcher)');
  return ready ? 'ready' : 'warming';
}
