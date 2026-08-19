import { existsSync, readFileSync, rmSync } from 'fs';
import { logger } from '../utils/logger.js';
import { captureProcessStartToken, isPidAlive, waitForExit, type ManagedProcessRecord, type ProcessRegistry } from './process-registry.js';
import { paths } from '../shared/paths.js';
import { killProcessTree, collectDescendantPids } from '../shared/kill-process-tree.js';

const PID_FILE = paths.workerPid();

export interface ShutdownCascadeOptions {
  registry: ProcessRegistry;
  currentPid?: number;
  pidFilePath?: string;
}

export async function runShutdownCascade(options: ShutdownCascadeOptions): Promise<void> {
  const currentPid = options.currentPid ?? process.pid;
  const pidFilePath = options.pidFilePath ?? PID_FILE;
  const allRecords = options.registry.getAll();
  const childRecords = [...allRecords]
    .filter(record => record.pid !== currentPid)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

  // Descendants snapshotted BEFORE the SIGTERM phase.
  //
  // The survivor scan below used to test `isPidAlive(record.pid)` — the ROOT
  // only. When uvx accepts the initial SIGTERM and exits cleanly, the record
  // stops looking like a survivor, so the SIGKILL phase never runs even though
  // uv/python/chroma-mcp have re-parented and are still alive. That made the
  // force phase unreachable in exactly the case it exists for (#3482), so
  // liveness has to be evaluated over the whole tree, and the tree has to be
  // recorded while the root is still around to enumerate it from.
  const descendantsByRecord = new Map<string, Array<{ pid: number; startToken: string | null }>>();

  for (const record of childRecords) {
    if (!isPidAlive(record.pid)) {
      options.registry.unregister(record.id);
      continue;
    }

    const descendantPids = await collectDescendantPids(record.pid);
    descendantsByRecord.set(
      record.id,
      descendantPids.map(pid => ({ pid, startToken: captureProcessStartToken(pid) }))
    );

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

  // A record survives if its root OR any of its snapshotted descendants is
  // still alive — a dead root with live descendants is precisely the orphan
  // case the force phase must handle.
  const survivors = childRecords.filter(record =>
    isPidAlive(record.pid) ||
    (descendantsByRecord.get(record.id) ?? []).some(entry => isPidAlive(entry.pid))
  );

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
    } finally {
      // MUST run even when signalProcess threw: a Windows taskkill failure
      // (access denied) raises ProcessTreeKillError, and skipping the per-pid
      // fallback there would strand exactly the descendants this reap exists
      // for. signalProcess tree-kills from the ROOT, so a root that is already
      // gone leaves its re-parented children reachable only this way.
      reapSnapshotDescendants(descendantsByRecord.get(record.id) ?? [], record.pid);
    }
  }

  await waitForExit(survivors, 1000);

  for (const record of childRecords) {
    options.registry.unregister(record.id);
  }
  for (const record of allRecords.filter(record => record.pid === currentPid)) {
    options.registry.unregister(record.id);
  }

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

/**
 * SIGKILL descendants that outlived the root of their tree.
 *
 * Only reached in the force phase, after the caller's full SIGTERM grace
 * window has already elapsed, so there is nothing left to be graceful about.
 *
 * Identity is re-verified before every kill. A snapshotted descendant can exit
 * DURING the 5s grace window and have its PID reissued by the OS; `isPidAlive`
 * would then report the number as live and we would SIGKILL a stranger. Only a
 * start token that was read successfully AND differs proves reuse, so a token
 * that cannot be re-read leaves the entry eligible (matching the snapshot-side
 * bias, and preserving the reap this function exists for).
 */
function reapSnapshotDescendants(
  entries: Array<{ pid: number; startToken: string | null }>,
  rootPid: number
): void {
  for (const { pid, startToken } of entries) {
    if (pid === rootPid || !isPidAlive(pid)) continue;

    if (startToken !== null) {
      const currentToken = captureProcessStartToken(pid);
      if (currentToken !== null && currentToken !== startToken) {
        logger.debug('SYSTEM', 'Skipping reap: PID was recycled during the grace window', {
          pid,
          rootPid,
        });
        continue;
      }
    }

    try {
      process.kill(pid, 'SIGKILL');
      logger.debug('SYSTEM', 'Reaped orphaned descendant during shutdown cascade', { pid, rootPid });
    } catch (error: unknown) {
      const errno = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (errno !== 'ESRCH') {
        logger.warn('SYSTEM', 'Failed to reap orphaned descendant during shutdown cascade', {
          pid,
          rootPid,
          errno,
        });
      }
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

    // Per-pid fallback. This is NOT hypothetical for the chroma record: its
    // pgid is recorded as the child's own pid, but chroma-mcp is spawned
    // WITHOUT `detached`, so it shares the worker's group and is not a group
    // leader — kill(-pid) therefore ESRCHes and always lands here. A bare
    // per-pid signal orphans the uvx -> uv -> python chain exactly like the
    // recycle path did (#3482).
    //
    // The SIGTERM phase stays a single signal so the caller's 5s grace window
    // means something. The SIGKILL phase is the force phase — that window has
    // already elapsed by the time it runs — so it tree-kills instead, reaping
    // descendants rather than stranding them. 'immediate' keeps it SIGKILL-only.
    if (signal === 'SIGKILL') {
      await killProcessTree(pid, { signalMode: 'immediate' });
      return;
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

  // Windows: both phases tree-kill. process.kill(pid, 'SIGTERM') is a
  // single-PID TerminateProcess — never a graceful signal — so the old
  // SIGTERM branch bought no grace period, it just left the descendants
  // running. Once the root exits, waitForExit() sees it gone and the
  // survivor scan never escalates to the SIGKILL taskkill branch, so the
  // orphans were never reaped at all. killProcessTree() runs the same
  // `taskkill /PID n /T /F` the SIGKILL branch used to build inline.
  await killProcessTree(pid);
}
