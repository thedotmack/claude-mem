import { createConnection } from 'node:net';
import { isConnectionRefusedError } from '../../shared/connection-errors.js';
import { readLocalApiToken } from '../../shared/hook-settings.js';
import { localApiTokenHeaders } from '../../shared/local-api-token.js';
import { readOwnedWorkerPidInfo, verifyWorkerPidFileOwnership, type PidInfo } from '../../supervisor/process-registry.js';
import { TERMINATE_THEN_FORCE_KILL_WAIT_MS } from '../../supervisor/shutdown.js';
import { getPlatformTimeout } from '../infrastructure/ProcessManager.js';
import { TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS } from '../telemetry/common.js';
import { WORKER_GRACEFUL_SHUTDOWN_DEADLINE_BASE_MS } from '../worker-shutdown.js';

/**
 * Why a stop did not complete, so callers can name the fix:
 * - `worker-still-running`: the worker this stop targeted is demonstrably
 *   still alive after the wait. Either the PID file's owner is alive and still
 *   verified (PID plus start token), and then `pid` is set and safe to tell
 *   the user to end; or, with no PID file, the same process answers the
 *   worker's /api/health before the stop and at the deadline, and then `pid`
 *   is null: an HTTP answer does not verify a PID (it may be a container's).
 * - `port-rebound`: the worker this stop targeted has exited, yet the port
 *   still accepts connections: a hook's lazy spawn or a process manager bound
 *   it again, or a leftover process still holds the socket. That is not a stop
 *   that failed. `ownerPid` is the verified PID-file owner now on the port,
 *   when there is one.
 * - `port-held-by-other-process`: something accepts connections on the port,
 *   but no live claude-mem worker owns it and it never accepted a shutdown.
 */
export type ShutdownBlocker =
  | { kind: 'worker-still-running'; pid: number | null }
  | { kind: 'port-rebound'; ownerPid: number | null }
  | { kind: 'port-held-by-other-process' };

export type ShutdownResult =
  /** No claude-mem worker was running on the port, or the targeted one exited and freed it. */
  | { stopped: true; workerWasRunning: boolean }
  | { stopped: false; workerWasRunning: boolean; blocker: ShutdownBlocker };

/** A raw TCP connect: `open` only when a connection completed. */
export type PortProbeResult = 'open' | 'refused' | 'no-answer';

/** The evidence sources, injectable so tests never touch real ports or PIDs. */
export interface ShutdownProbes {
  /** The live, verified claude-mem worker that owns the PID file, or null. Read again at the deadline. */
  readOwnedWorker: () => PidInfo | null;
  /** Whether that worker's process is still alive (it may exit while we wait). */
  isOwnedWorkerAlive: (worker: PidInfo) => boolean;
  probePort: (port: number, timeoutMs: number) => Promise<PortProbeResult>;
  /** The pid the worker on the port reports from /api/health, or null when no such answer could be read. */
  readAnsweringWorkerPid: (port: number, timeoutMs: number) => Promise<number | null>;
}

const SHUTDOWN_REQUEST_TIMEOUT_MS = 5000;
const HEALTH_PID_TIMEOUT_MS = 2000;
/** Generous per attempt, so a slow refusal (WSL2 mirrored networking) still reads as a refusal (#4107). */
const PORT_PROBE_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 500;

/**
 * How long a caller that cannot go on while the old worker lives (the installer, before it overwrites that worker's
 * files) waits for it to exit after it accepted the stop: as long as the worker's own shutdown may take. A shorter wait
 * reports a worker that is still shutting down, inside its own bounds, as stuck. The flat 10 s this replaces was
 * shorter than the worker's 10 s drain deadline plus the steps after it, so `npx claude-mem update` aborted on every
 * worker that reached that deadline (#6450).
 *
 * It is the sum of the bounds of the steps a stop runs once it has answered the request (worker-service.ts shutdown,
 * worker-shutdown.ts runShutdownSequence), in the order they run:
 *  1. the telemetry flush that ends the pre-shutdown bookkeeping: TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS (3 s);
 *  2. the graceful shutdown: getPlatformTimeout(WORKER_GRACEFUL_SHUTDOWN_DEADLINE_BASE_MS) (10 s, 20 s on Windows);
 *  3. the force stop of the commands still running, and
 *  4. the supervisor's cascade, run when the graceful shutdown did not finish: TERMINATE_THEN_FORCE_KILL_WAIT_MS each
 *     (5 s after SIGTERM, then 1 s after SIGKILL);
 * plus one POLL_INTERVAL_MS, so that one check of the worker runs after the last step's bound has passed.
 * 3 s + 10 s + 6 s + 6 s + 0.5 s = 25.5 s (35.5 s on Windows).
 *
 * It is not a bound on the worker: the Codex app-server close in the pre-shutdown bookkeeping has no deadline of its
 * own. A worker still alive after this wait is reported as `worker-still-running`, never waited for again.
 */
export const WORKER_EXIT_WAIT_MS = TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS
  + getPlatformTimeout(WORKER_GRACEFUL_SHUTDOWN_DEADLINE_BASE_MS)
  + 2 * TERMINATE_THEN_FORCE_KILL_WAIT_MS
  + POLL_INTERVAL_MS;

export function probeLoopbackPort(port: number, timeoutMs: number): Promise<PortProbeResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (result: PortProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish('open'));
    socket.once('error', (error) => finish(isConnectionRefusedError(error) ? 'refused' : 'no-answer'));
    socket.setTimeout(timeoutMs, () => finish('no-answer'));
  });
}

export async function readAnsweringWorkerPid(port: number, timeoutMs: number): Promise<number | null> {
  try {
    // A degraded worker answers 503 with the same payload, so the status is not checked.
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await response.json()) as { pid?: unknown };
    return typeof body.pid === 'number' && Number.isInteger(body.pid) && body.pid > 0 ? body.pid : null;
  } catch {
    return null;
  }
}

const DEFAULT_PROBES: ShutdownProbes = {
  readOwnedWorker: () => readOwnedWorkerPidInfo(),
  isOwnedWorkerAlive: (worker) => verifyWorkerPidFileOwnership(worker),
  probePort: probeLoopbackPort,
  readAnsweringWorkerPid,
};

/**
 * Stop the claude-mem worker on `port` and wait until it is gone.
 *
 * Liveness comes from the ownership record (the worker PID file plus its start
 * token, plan-15), not from network error classes: HTTP timeouts, resets and
 * dropped SYNs are ambiguous, and on WSL2 mirrored networking a refused
 * loopback connect can arrive slowly or not at all (#4107). So:
 * - an explicit refusal, however slow, means nothing listens: stopped;
 * - an owned, live worker is running until its process exits;
 * - with no owned worker, only a completed TCP connect counts as a listener.
 *
 * The stop targets the worker that answers on the port when it begins: the
 * PID file's verified owner, or, with no PID file, the process that answers
 * /api/health. Only that worker, still alive at the deadline, is a worker that
 * did not stop. Once it has exited, a port that answers again belongs to a new
 * process (a hook's lazy spawn, a process manager restarting it, a leftover
 * socket), so the result is `port-rebound`. No PID that has not been verified
 * is ever reported: on Windows a dead worker's PID is soon reused.
 */
export async function shutdownWorkerAndWait(
  port: number | string,
  timeoutMs: number = 10000,
  probes: ShutdownProbes = DEFAULT_PROBES,
): Promise<ShutdownResult> {
  const portNumber = Number(port);
  // A worker the PID file places on another port is not the one this call stops.
  const readOwnedWorkerOnPort = (): PidInfo | null => {
    const recorded = probes.readOwnedWorker();
    return recorded && (!recorded.port || Number(recorded.port) === portNumber) ? recorded : null;
  };
  const ownedWorker = readOwnedWorkerOnPort();
  // With no PID file to go by, note which process answers as the worker, so
  // the deadline can tell that same worker still running from a new one.
  const answeringPidBefore = ownedWorker ? null : await probes.readAnsweringWorkerPid(portNumber, HEALTH_PID_TIMEOUT_MS);

  let shutdownAccepted = false;
  try {
    // /api/admin/shutdown is not an open route in local-api-token mode (#5141).
    const localApiToken = readLocalApiToken();
    const response = await fetch(`http://127.0.0.1:${portNumber}/api/admin/shutdown`, {
      method: 'POST',
      ...(localApiToken ? { headers: localApiTokenHeaders(localApiToken) } : {}),
      signal: AbortSignal.timeout(SHUTDOWN_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Something answered but refused to shut down: fail closed, never wait.
      return ownedWorker
        ? { workerWasRunning: true, stopped: false, blocker: { kind: 'worker-still-running', pid: ownedWorker.pid } }
        : { workerWasRunning: false, stopped: false, blocker: { kind: 'port-held-by-other-process' } };
    }
    shutdownAccepted = true;
  } catch (error) {
    if (isConnectionRefusedError(error)) return { workerWasRunning: false, stopped: true };
    // A timeout, a reset (a worker may reset the socket while exiting) or any
    // other failure is ambiguous: decide from the PID file and the port below.
  }

  const identifiedAsWorker = shutdownAccepted || ownedWorker !== null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await workerIsGone(portNumber, ownedWorker, probes)) {
      return { workerWasRunning: identifiedAsWorker, stopped: true };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  if (ownedWorker && probes.isOwnedWorkerAlive(ownedWorker)) {
    return {
      workerWasRunning: true,
      stopped: false,
      blocker: { kind: 'worker-still-running', pid: ownedWorker.pid },
    };
  }
  if (!identifiedAsWorker) {
    return { workerWasRunning: false, stopped: false, blocker: { kind: 'port-held-by-other-process' } };
  }
  if (
    !ownedWorker
    && answeringPidBefore !== null
    && (await probes.readAnsweringWorkerPid(portNumber, HEALTH_PID_TIMEOUT_MS)) === answeringPidBefore
  ) {
    return { workerWasRunning: true, stopped: false, blocker: { kind: 'worker-still-running', pid: null } };
  }
  // The targeted worker is gone, yet the port answers: whoever holds it now
  // is a different process. Name it only when the PID file verifies a new
  // claude-mem worker on this port.
  const currentOwner = readOwnedWorkerOnPort();
  return {
    workerWasRunning: true,
    stopped: false,
    blocker: {
      kind: 'port-rebound',
      ownerPid: currentOwner && currentOwner.pid !== ownedWorker?.pid ? currentOwner.pid : null,
    },
  };
}

/** Gone: its owned process (if any) has exited and nothing completes a connect on the port. */
async function workerIsGone(port: number, ownedWorker: PidInfo | null, probes: ShutdownProbes): Promise<boolean> {
  if (ownedWorker && probes.isOwnedWorkerAlive(ownedWorker)) return false;
  return (await probes.probePort(port, PORT_PROBE_TIMEOUT_MS)) !== 'open';
}
