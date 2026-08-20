import { execFile } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';
import { isPidAlive, waitForExit, type ManagedProcessRecord, type ProcessRegistry } from './process-registry.js';
import { paths } from '../shared/paths.js';

const execFileAsync = promisify(execFile);
const PID_FILE = paths.workerPid();

export interface ShutdownCascadeOptions {
  registry: ProcessRegistry;
  currentPid?: number;
  pidFilePath?: string;
  /**
   * Restart-safety latch: put this process's registry into read-only mode for
   * the rest of its life, keeping the kill side intact.
   *
   * This registry is process-local after a once-guarded initialize(), so its
   * map is a snapshot frozen at boot, and persist() rewrites supervisor.json in
   * full from that snapshot. Once a restart has handed off, the successor may
   * already have written its OWN 'worker' record to the shared file, so any
   * write from here can erase it.
   *
   * Implemented via registry.suspendWrites() rather than by skipping call sites
   * here, because signalling a child makes that child's 'exit' handler call
   * unregister() asynchronously, from outside this function.
   *
   * Same posture as removeOwnedPidFile() below: a dying process does not touch
   * what its successor now owns. The predecessor's stale records are left
   * behind, and the successor's periodic health check prunes them on a later
   * pass (pruneDeadEntries only persists when it removes something, and the
   * abandoned records supply exactly that trigger).
   */
  preserveRegistryForSuccessor?: boolean;
}

export async function runShutdownCascade(options: ShutdownCascadeOptions): Promise<void> {
  const currentPid = options.currentPid ?? process.pid;
  const pidFilePath = options.pidFilePath ?? PID_FILE;

  // Before the first read: getAll() can trigger initialize(), which persists.
  if (options.preserveRegistryForSuccessor) {
    options.registry.suspendWrites();
  }

  const allRecords = options.registry.getAll();
  const childRecords = [...allRecords]
    .filter(record => record.pid !== currentPid)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  for (const record of childRecords) {
    if (!isPidAlive(record.pid)) {
      options.registry.unregister(record.id);
      continue;
    }

    try {
      await signalProcess(record, 'SIGTERM');
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.debug('SYSTEM', 'Failed to send SIGTERM to child process', {
          pid: record.pid,
          pgid: record.pgid,
          type: record.type
        }, error);
      } else {
        logger.warn('SYSTEM', 'Failed to send SIGTERM to child process (non-Error)', {
          pid: record.pid,
          pgid: record.pgid,
          type: record.type,
          error: String(error)
        });
      }
    }
  }

  await waitForExit(childRecords, 5000);

  const survivors = childRecords.filter(record => isPidAlive(record.pid));
  for (const record of survivors) {
    try {
      await signalProcess(record, 'SIGKILL');
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.debug('SYSTEM', 'Failed to force kill child process', {
          pid: record.pid,
          pgid: record.pgid,
          type: record.type
        }, error);
      } else {
        logger.warn('SYSTEM', 'Failed to force kill child process (non-Error)', {
          pid: record.pid,
          pgid: record.pgid,
          type: record.type,
          error: String(error)
        });
      }
    }
  }

  await waitForExit(survivors, 1000);

  // These still run under preserveRegistryForSuccessor — suspendWrites() has
  // made them in-memory only, so the bookkeeping stays consistent while the
  // successor's file is left untouched.
  for (const record of childRecords) {
    options.registry.unregister(record.id);
  }
  for (const record of allRecords.filter(record => record.pid === currentPid)) {
    options.registry.unregister(record.id);
  }

  // Owner-guarded, so it is safe on both paths: it deletes only a PID file this
  // process actually owns and leaves a successor's file alone.
  removeOwnedPidFile(pidFilePath, currentPid);

  options.registry.pruneDeadEntries();
}

/**
 * Owner-guarded PID-file removal (Phase 5, worker-restart plan).
 *
 * The shutdown cascade is the dying worker's LAST act — during a restart the
 * successor worker has typically already written its OWN PID file by the time
 * this runs. Blindly rmSync'ing here clobbered that file and made
 * `worker status` report a healthy worker as not running. Deletion therefore
 * requires proof of ownership: the recorded pid must equal `currentPid`.
 *
 * With `deleteIfDead` (the CLI stop/restart cleanup policy — see
 * removePidFileIfOwner in ProcessManager.ts) a dead or missing recorded pid is
 * also deleted: a pid-less file can't belong to a live successor
 * (writePidFile always records a pid), so it is treated as a dead owner.
 * Without it, only the caller's own file is ever deleted.
 *
 * A missing file is a no-op. An unreadable/corrupt file cannot prove
 * ownership, so it is left in place (the safe default): readPidFile() and
 * validateWorkerPidFile() both treat unparseable files as ownerless, so a
 * leftover corrupt file never blocks a successor's boot and is cleaned up by
 * the next worker start.
 */
export function removeOwnedPidFile(pidFilePath: string, currentPid: number | null, deleteIfDead = false): void {
  if (!existsSync(pidFilePath)) return;

  let recordedPid: number | null = null;
  try {
    const parsed = JSON.parse(readFileSync(pidFilePath, 'utf-8')) as { pid?: unknown };
    recordedPid = typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'PID file unreadable — leaving it (cannot prove ownership)', {
      pidFilePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const owned = currentPid !== null && recordedPid === currentPid;
  const dead = recordedPid === null || !isPidAlive(recordedPid);
  if (!owned && !(deleteIfDead && dead)) {
    logger.debug('SYSTEM', 'PID file not owned by this process — leaving it for its owner (restart successor?)', {
      pidFilePath,
      recordedPid,
      currentPid
    });
    return;
  }

  try {
    rmSync(pidFilePath, { force: true });
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.debug('SYSTEM', 'Failed to remove PID file', { pidFilePath }, error);
    } else {
      logger.warn('SYSTEM', 'Failed to remove PID file (non-Error)', {
        pidFilePath,
        error: String(error)
      });
    }
  }
}

async function signalProcess(record: ManagedProcessRecord, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const { pid, pgid } = record;

  if (process.platform !== 'win32') {
    // Try the process group first when we have one — it reaches grandchildren
    // re-parented to init. If the group is already gone (ESRCH) the actual
    // root pid may still be alive (e.g. it survived its own group teardown);
    // fall through to the per-pid signal so shutdown isn't a no-op
    // (CodeRabbit review on PR #2282).
    if (typeof pgid === 'number') {
      try {
        process.kill(-pgid, signal);
        return;
      } catch (error: unknown) {
        const errno = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
        if (errno !== 'ESRCH') {
          throw error;
        }
        // ESRCH on the group — fall through and try the bare pid below.
      }
    }

    try {
      process.kill(pid, signal);
    } catch (error: unknown) {
      const errno = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (errno !== 'ESRCH') {
        throw error;
      }
    }
    return;
  }

  if (signal === 'SIGTERM') {
    try {
      process.kill(pid, signal);
    } catch (error: unknown) {
      if (error instanceof Error) {
        const errno = (error as NodeJS.ErrnoException).code;
        if (errno === 'ESRCH') {
          return;
        }
      }
      throw error;
    }
    return;
  }

  const args = ['/PID', String(pid), '/T'];
  if (signal === 'SIGKILL') {
    args.push('/F');
  }

  await execFileAsync('taskkill', args, {
    timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND,
    windowsHide: true
  });
}
