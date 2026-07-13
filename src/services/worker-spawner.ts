
import path from 'path';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { logger } from '../utils/logger.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import {
  cleanStalePidFile,
  getPlatformTimeout,
  reclaimStaleWorkerPort,
  spawnDaemon,
  touchPidFile,
} from './infrastructure/ProcessManager.js';
import {
  isPortInUse,
  probePortBind,
  waitForHealth,
  waitForReadiness,
} from './infrastructure/HealthMonitor.js';
import { acquireSpawnLock, releaseSpawnLock } from '../shared/worker-spawn-gate.js';
import { getWorkerHost } from '../shared/worker-utils.js';

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
    const reclaimed = await reclaimStaleWorkerPort(port);
    if (!reclaimed) {
      logger.error('SYSTEM', 'Port in use but worker not responding and reclaim failed');
      return 'dead';
    }
    clearWorkerSpawnAttempted();
  }

  // Before spawning a detached daemon, verify the port can actually be bound —
  // here, in the user-facing parent, where a failure is visible. A stale or
  // unrelated LISTEN socket would otherwise make the daemon hit EADDRINUSE and
  // exit in the background while this parent reports 'warming'. Detect it here
  // and either reclaim a proven stale claude-mem worker or surface a real
  // 'dead' result.
  const workerHost = getWorkerHost();
  let bindProbe = await probePortBind(port, workerHost);
  if (bindProbe === 'EADDRINUSE') {
    // Retry briefly — transient holders (TIME_WAIT) often clear — and defer to
    // any worker that becomes healthy on the port while we wait.
    const STALE_SOCKET_RETRIES = 3;
    const STALE_SOCKET_RETRY_DELAY_MS = 1000;
    for (let attempt = 1; attempt <= STALE_SOCKET_RETRIES && bindProbe === 'EADDRINUSE'; attempt++) {
      await new Promise(r => setTimeout(r, STALE_SOCKET_RETRY_DELAY_MS));
      if (await waitForHealth(port, 1000)) {
        clearWorkerSpawnAttempted();
        const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
        logger.info('SYSTEM', 'Worker became healthy while waiting on a busy port');
        return ready ? 'ready' : 'warming';
      }
      bindProbe = await probePortBind(port, workerHost);
    }
    if (bindProbe === 'EADDRINUSE') {
      const reclaimed = await reclaimStaleWorkerPort(port);
      if (reclaimed) {
        clearWorkerSpawnAttempted();
        bindProbe = await probePortBind(port, workerHost);
      }
    }
    if (bindProbe === 'EADDRINUSE') {
      logger.error('SYSTEM',
        `Worker cannot bind port ${port}: it is held by a stale socket with no healthy worker behind it — ` +
        `an orphaned listener left by a previous worker that exited uncleanly (common on Windows, where the ` +
        `socket can outlive its dead PID). Reboot to release the socket, or set CLAUDE_MEM_WORKER_PORT to a ` +
        `free port in ~/.claude-mem/settings.json.`,
        { port });
      return 'dead';
    }
  }
  if (bindProbe && bindProbe !== 'EADDRINUSE') {
    // A genuine bind error (e.g. EADDRNOTAVAIL from an invalid
    // CLAUDE_MEM_WORKER_HOST, EACCES from a privileged port) — surface it as
    // itself instead of misreporting it as a stale socket.
    logger.error('SYSTEM',
      `Worker cannot bind ${workerHost}:${port} (${bindProbe}) — check CLAUDE_MEM_WORKER_HOST / ` +
      `CLAUDE_MEM_WORKER_PORT in ~/.claude-mem/settings.json.`,
      { host: workerHost, port, code: bindProbe });
    return 'dead';
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
