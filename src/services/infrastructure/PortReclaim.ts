import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { isPidAlive } from '../../supervisor/process-registry.js';
import { waitForPortFree } from './HealthMonitor.js';

const execFileAsync = promisify(execFile);

/**
 * Find the PID currently bound to a local TCP port in LISTEN state.
 *
 * Ghost-socket recovery (#3073): after an unclean teardown the worker port can
 * stay bound to a process that is no longer a healthy worker (an orphaned or
 * wedged daemon). ensureWorkerStarted needs the owning PID so it can reclaim
 * the port instead of giving up with `dead`.
 *
 * Best-effort and cross-platform. Returns null when nothing owns the port or
 * the owner cannot be determined (in which case the caller must not kill
 * anything — a null result is treated as "not reclaimable").
 */
export async function findPidOnPort(port: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      // Get-NetTCPConnection is the reliable Windows API. Filter to Listen so we
      // match the daemon's server socket, not a transient client connection.
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
        ],
        { timeout: 5_000, windowsHide: true }
      );
      const pid = parseInt(stdout.trim(), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    }

    // POSIX: prefer lsof, which prints the owning PID directly.
    const { stdout } = await execFileAsync(
      'lsof',
      ['-ti', `tcp:${port}`, '-sTCP:LISTEN'],
      { timeout: 5_000 }
    );
    const pid = parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    // Non-zero exit means "no match" for both powershell (empty) and lsof, or
    // the tool is unavailable. Either way we cannot identify an owner.
    logger.debug('SYSTEM', 'Could not determine PID owning port', {
      port,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Kill the process tree rooted at `pid`. Windows uses `taskkill /T /F` (the
 * daemon spawns a chroma-mcp child tree that must go with it); POSIX sends
 * SIGKILL to the process group, falling back to the bare PID.
 */
async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 5_000,
        windowsHide: true,
      });
    } catch (error) {
      // taskkill exits non-zero when the process is already gone — fine.
      logger.debug('SYSTEM', 'taskkill during port reclaim finished (may already be dead)', {
        pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone — fine.
    }
  }
}

/**
 * Reclaim an orphaned worker port: identify the owning process, kill its tree,
 * and wait for the port to free. Returns true only when the port is confirmed
 * free afterwards.
 *
 * Callers MUST only invoke this after confirming no HEALTHY worker answers on
 * the port (see ensureWorkerStarted): this kills whatever holds the port.
 */
export async function reclaimOrphanedPort(port: number, waitMs: number = 5_000): Promise<boolean> {
  const ownerPid = await findPidOnPort(port);

  if (ownerPid === null) {
    // Nothing identifiable owns it. It may be a lingering socket the OS will
    // release shortly; give it the wait window rather than killing blindly.
    logger.warn('SYSTEM', 'Port is in use but no owning process could be identified — waiting for OS to release it', { port });
    return waitForPortFree(port, waitMs);
  }

  if (ownerPid === process.pid) {
    logger.error('SYSTEM', 'Refusing to reclaim port owned by the current process', { port, ownerPid });
    return false;
  }

  if (!isPidAlive(ownerPid)) {
    // Owner already dead but the socket is still bound (the classic ghost
    // socket). Nothing to kill — just wait for the OS to reclaim it.
    logger.warn('SYSTEM', 'Port bound by a dead PID (ghost socket) — waiting for OS to release it', { port, ownerPid });
    return waitForPortFree(port, waitMs);
  }

  logger.warn('SYSTEM', 'Reclaiming orphaned worker port by killing the unresponsive owner process tree', { port, ownerPid });
  await killTree(ownerPid);

  const freed = await waitForPortFree(port, waitMs);
  if (!freed) {
    logger.error('SYSTEM', 'Port did not free after reclaiming the owner process', { port, ownerPid });
  }
  return freed;
}
