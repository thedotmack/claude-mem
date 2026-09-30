
import path from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, statSync } from 'fs';
import { logger } from '../utils/logger.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { captureCliEvent } from './telemetry/cli-telemetry.js';
import { SettingsDefaultsManager } from '../shared/SettingsDefaultsManager.js';
import {
  cleanStalePidFile,
  getPlatformTimeout,
  probeWorkerBootFailure,
  readPidFile,
  removePidFileIfOwner,
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
import { isWorkerAutostartDisabled } from '../shared/worker-autostart.js';

/**
 * Windows spawn cooldown, keyed to evidence rather than time (plan-15 step 7,
 * #2996). The marker is written ONLY when a worker this launcher started
 * provably crashed during boot (probeWorkerBootFailure returned its error):
 * respawning an install that crashes on start just repeats the crash (and a
 * console flash) on every hook, so launchers stand down for the cooldown.
 * Every other failure (port held by something else, a reclaimed ghost, a lost
 * spawn lock, a readiness timeout with no proven crash) writes nothing, so the
 * next launcher that finds the port free retries immediately. The marker is
 * cleared whenever a worker is seen healthy.
 */
const WINDOWS_SPAWN_COOLDOWN_MS = 2 * 60 * 1000;

function getWorkerSpawnLockPath(): string {
  return path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), '.worker-start-attempted');
}

/**
 * The boot failure recorded by a provable crash inside the cooldown window, or
 * null when a spawn is allowed. An empty string means a crash was recorded
 * without readable detail.
 */
function readSpawnCooldownOnWindows(): string | null {
  if (process.platform !== 'win32') return null;
  const lockPath = getWorkerSpawnLockPath();
  if (!existsSync(lockPath)) return null;
  try {
    const modifiedTimeMs = statSync(lockPath).mtimeMs;
    if (Date.now() - modifiedTimeMs >= WINDOWS_SPAWN_COOLDOWN_MS) return null;
    return readFileSync(lockPath, 'utf-8');
  } catch (error) {
    if (error instanceof Error) {
      logger.debug('SYSTEM', 'Could not read worker spawn cooldown marker', {}, error);
    } else {
      logger.debug('SYSTEM', 'Could not read worker spawn cooldown marker', { error: String(error) });
    }
    return null;
  }
}

function markWorkerBootCrashed(bootFailure: string): void {
  if (process.platform !== 'win32') return;
  try {
    const lockPath = getWorkerSpawnLockPath();
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, bootFailure, 'utf-8');
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
 * A worker we spawned is dead and not serving after boot (#3557). This covers
 * both a worker that never bound the port and one that bound, then crashed —
 * this path cannot tell them apart, so the diagnosis stays neutral rather than
 * claiming "never bound". Drop the durable markers so the next session start
 * can tell the user, and emit the telemetry event that closes the measurement
 * hole — every other boot dies silently today. Best-effort: capture must never
 * break because a marker or an event could not be written.
 *
 * `bootFailure` is probeWorkerBootFailure's reproduction of the crash, when it
 * got one; it goes into the local marker only (telemetry stays a closed enum).
 */
async function recordWorkerBootFailure(
  port: number,
  spawnedPid: number | undefined,
  bootFailure: string | undefined,
): Promise<void> {
  const diagnostic = [
    `[worker-spawner] worker is dead and unreachable on port ${port} after boot — issue #3557`,
    `  spawned pid: ${spawnedPid ?? 'n/a'}`,
    `  platform: ${process.platform}`,
    `  timestamp: ${new Date().toISOString()}`,
    ...(bootFailure ? ['  boot failure (reproduced):', ...bootFailure.split('\n').map((line) => `    ${line}`)] : []),
  ].join('\n');

  try {
    const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
    const logsDir = path.join(dataDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(path.join(logsDir, 'runner-errors.log'), diagnostic + '\n\n');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, 'CAPTURE_BROKEN'), diagnostic + '\n');
  } catch (error) {
    logger.warn('SYSTEM', 'Failed to persist worker boot-failure marker', {},
      error instanceof Error ? error : new Error(String(error)));
  }

  try {
    await captureCliEvent('worker_start_failed', {
      outcome: 'dead',
      error_category: bootFailure ? 'boot_crash' : 'unreachable_after_boot',
    });
  } catch (error) {
    // Telemetry is best-effort and must never turn a diagnosed failure into a throw.
    logger.debug('SYSTEM', 'worker_start_failed telemetry not sent', {},
      error instanceof Error ? error : new Error(String(error)));
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

  // CLAUDE_MEM_WORKER_AUTOSTART=false: the worker is managed externally. Report
  // on it, but never launch, kill or reclaim anything (and leave its PID file
  // alone). Read fresh: this runs in long-lived processes (the MCP server).
  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  if (isWorkerAutostartDisabled(SettingsDefaultsManager.loadFromFile(settingsPath))) {
    if (await waitForHealth(port, 1000)) {
      const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
      return ready ? 'ready' : 'warming';
    }
    logger.info('SYSTEM', 'CLAUDE_MEM_WORKER_AUTOSTART=false and no worker is running — not launching one');
    return 'dead';
  }

  // I-4 (bwrap --unshare-pid): don't delete the pid file on a 'stale'
  // verdict until we know whether the port is actually unhealthy — under a
  // PID namespace a perfectly healthy host worker's pid reads back as
  // invisible (ESRCH), not dead. removeStale:false defers the rmSync.
  let pidFileStatus = cleanStalePidFile({ removeStale: false });
  // #3224 (health first): set when the PID file names a live process whose
  // worker never answers health. A reused PID or a wedged worker looks like
  // that, and neither is a worker to wait on, so it must not park every
  // launcher in 'warming' forever.
  let livePidNeverHealthy = false;
  // The pid that file recorded when it was judged, so the cleanup below never
  // deletes a PID file a restart successor wrote in the meantime.
  let livePidNeverHealthyPid: number | null = null;
  if (pidFileStatus === 'alive') {
    logger.info('SYSTEM', 'Worker PID file points to a live process, skipping duplicate spawn');
    const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
    if (ready) {
      clearWorkerSpawnAttempted();
      logger.info('SYSTEM', 'Worker became ready while waiting on live PID');
      return 'ready';
    }
    if (await waitForHealth(port, 1000)) {
      // Health answers, so this is a slow boot: keep its PID file and wait.
      logger.warn('SYSTEM', 'Live PID detected but worker did not become ready before timeout');
      return 'warming';
    }
    if (cleanStalePidFile() !== 'alive') {
      logger.error('SYSTEM', 'Live PID disappeared before readiness endpoint became available');
      return 'dead';
    }
    // The PID file stays for now: if the port turns out to be held, the
    // reclaim below needs it as proof that the listener is our worker.
    logger.warn('SYSTEM', 'PID file names a live process whose worker never answered health; checking the port instead of waiting on it');
    livePidNeverHealthy = true;
    livePidNeverHealthyPid = readPidFile()?.pid ?? null;
  }

  if (await waitForHealth(port, 1000)) {
    if (pidFileStatus === 'stale') {
      logger.debug('SYSTEM', 'pid not visible (likely pid namespace); keeping pid file');
    }
    clearWorkerSpawnAttempted();
    const ready = await waitForReadiness(port, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT));
    if (!ready) {
      logger.warn('SYSTEM', 'Worker is alive but readiness timed out — proceeding anyway');
    }
    logger.info('SYSTEM', 'Worker already running and healthy');
    return ready ? 'ready' : 'warming';
  }

  if (pidFileStatus === 'stale') {
    // Health genuinely failed above, so the pid file was not shielding a
    // healthy-but-invisible worker after all — remove it now (this is the
    // deferred rmSync from the removeStale:false call above).
    pidFileStatus = cleanStalePidFile();
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
    // The port is bound but nothing answers health. Two cases the reclaim
    // handles: (1) a wedged worker WE own that stopped answering /health but
    // still holds the port (#4127), and (2) a dead worker whose chroma sidecar
    // chain holds the inherited listening socket — a ghost listener under a
    // dead PID (plan-15 #3603). Without a reclaim the launcher returns 'dead'
    // forever and the port stays blocked until a human intervenes. A live
    // FOREIGN owner (a process our PID file does not claim) keeps the old
    // 'dead' behavior.
    const reclaim = await reclaimGhostListeningPort(port);
    if (reclaim.reclaimed) {
      logger.info('SYSTEM', 'Reclaimed the worker port (wedged or dead-owner ghost listener) — proceeding to spawn', {
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
  } else if (livePidNeverHealthy) {
    // Nothing listens on the port, so the live process in the PID file is
    // not this worker (a reused PID, or a worker that already let the port
    // go). A new worker refuses to boot while the PID file names a live
    // process, so clear the file before spawning. Only the pid judged above
    // is cleared: if a restart successor rewrote the file since the port
    // check, removePidFileIfOwner leaves the successor's record in place.
    logger.warn('SYSTEM', 'Clearing a PID file whose live process holds no worker port', {
      port,
      pid: livePidNeverHealthyPid,
    });
    removePidFileIfOwner(livePidNeverHealthyPid);
  }

  const recentBootCrash = readSpawnCooldownOnWindows();
  if (recentBootCrash !== null) {
    // Report the recorded crash, not a generic "dead": the caller surfaces
    // getLastWorkerBootFailure() to the user.
    lastWorkerBootFailure = recentBootCrash || undefined;
    logger.warn('SYSTEM', 'Worker crashed on boot within the cooldown window — skipping spawn on Windows', {
      cooldownMs: WINDOWS_SPAWN_COOLDOWN_MS,
      ...(lastWorkerBootFailure ? { bootFailure: lastWorkerBootFailure } : {}),
    });
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
      spawnedPid = spawnDaemon(workerScriptPath, port);
      if (spawnedPid === undefined) {
        logger.error('SYSTEM', 'Failed to spawn worker daemon');
        // The launch itself failed (no Bun runtime, Start-Process refused):
        // as deterministic as a boot crash, so it also starts the cooldown.
        markWorkerBootCrashed('The worker daemon could not be launched (see the claude-mem log for the spawn error).');
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
          // A lock loser never spawned this worker, so the holder owns the
          // failure record; writing it here too would double-report it.
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
        // Only a crash the probe reproduced starts the cooldown; an unexplained
        // exit leaves the next launcher free to retry right away.
        if (lastWorkerBootFailure) markWorkerBootCrashed(lastWorkerBootFailure);
        await recordWorkerBootFailure(port, spawnedPid, lastWorkerBootFailure);
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
