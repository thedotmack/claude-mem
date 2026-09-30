import { createConnection } from 'node:net';
import { isConnectionRefusedError } from '../../shared/connection-errors.js';
import { readOwnedWorkerPidInfo, verifyPidFileOwnership, type PidInfo } from '../../supervisor/process-registry.js';

/**
 * Why a stop did not complete, so callers can name the fix:
 * - `worker-still-running`: a claude-mem worker (it owns the PID file, or it
 *   accepted the shutdown request) is still alive. `pid` is null when the
 *   worker could not be identified through the PID file.
 * - `port-held-by-other-process`: something accepts connections on the port,
 *   but no live claude-mem worker owns it and it never accepted a shutdown.
 */
export type ShutdownBlocker =
  | { kind: 'worker-still-running'; pid: number | null }
  | { kind: 'port-held-by-other-process' };

export interface ShutdownResult {
  workerWasRunning: boolean;
  /** True when no claude-mem worker was running on the port, or it exited. */
  stopped: boolean;
  /** Set exactly when `stopped` is false. */
  blocker?: ShutdownBlocker;
}

/** A raw TCP connect: `open` only when a connection completed. */
export type PortProbeResult = 'open' | 'refused' | 'no-answer';

/** The evidence sources, injectable so tests never touch real ports or PIDs. */
export interface ShutdownProbes {
  /** The live, verified claude-mem worker that owns the PID file, or null. */
  readOwnedWorker: () => PidInfo | null;
  /** Whether that worker's process is still alive (it may exit while we wait). */
  isOwnedWorkerAlive: (worker: PidInfo) => boolean;
  probePort: (port: number, timeoutMs: number) => Promise<PortProbeResult>;
}

const SHUTDOWN_REQUEST_TIMEOUT_MS = 5000;
/** Generous per attempt, so a slow refusal (WSL2 mirrored networking) still reads as a refusal (#4107). */
const PORT_PROBE_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 500;

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

const DEFAULT_PROBES: ShutdownProbes = {
  readOwnedWorker: () => readOwnedWorkerPidInfo(),
  isOwnedWorkerAlive: (worker) => verifyPidFileOwnership(worker),
  probePort: probeLoopbackPort,
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
 */
export async function shutdownWorkerAndWait(
  port: number | string,
  timeoutMs: number = 10000,
  probes: ShutdownProbes = DEFAULT_PROBES,
): Promise<ShutdownResult> {
  const portNumber = Number(port);
  const recorded = probes.readOwnedWorker();
  // A worker the PID file places on another port is not the one this call stops.
  const ownedWorker = recorded && (!recorded.port || Number(recorded.port) === portNumber) ? recorded : null;

  let shutdownAccepted = false;
  try {
    const response = await fetch(`http://127.0.0.1:${portNumber}/api/admin/shutdown`, {
      method: 'POST',
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

  return {
    workerWasRunning: identifiedAsWorker,
    stopped: false,
    blocker: identifiedAsWorker
      ? { kind: 'worker-still-running', pid: ownedWorker?.pid ?? null }
      : { kind: 'port-held-by-other-process' },
  };
}

/** Gone: its owned process (if any) has exited and nothing completes a connect on the port. */
async function workerIsGone(port: number, ownedWorker: PidInfo | null, probes: ShutdownProbes): Promise<boolean> {
  if (ownedWorker && probes.isOwnedWorkerAlive(ownedWorker)) return false;
  return (await probes.probePort(port, PORT_PROBE_TIMEOUT_MS)) !== 'open';
}
