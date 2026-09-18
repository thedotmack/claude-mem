import { createConnection } from 'node:net';

export interface ShutdownResult {
  workerWasRunning: boolean;
  /** True only when no worker was present or health stopped responding. */
  stopped: boolean;
}

function hasErrorCode(error: unknown, code: string, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const candidate = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (candidate.code === code) return true;
  if (hasErrorCode(candidate.cause, code, seen)) return true;
  return Array.isArray(candidate.errors)
    && candidate.errors.some((nested) => hasErrorCode(nested, code, seen));
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function isConnectionRefused(error: unknown): boolean {
  return hasErrorCode(error, 'ECONNREFUSED');
}

type PortProbeResult = 'open' | 'refused' | 'unknown';

function probeLoopbackPort(port: number | string, timeoutMs = 1000): Promise<PortProbeResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) });
    let settled = false;
    const finish = (result: PortProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.once('connect', () => finish('open'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' ? 'refused' : 'unknown');
    });
    socket.setTimeout(timeoutMs, () => finish('unknown'));
  });
}

async function healthProbeConfirmsStopped(baseUrl: string): Promise<boolean> {
  try {
    await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return false;
  } catch (error) {
    // Only an explicit refusal proves that nothing owns the loopback port.
    // Resets, timeouts, and protocol failures are ambiguous and fail closed.
    return isConnectionRefused(error);
  }
}

export async function shutdownWorkerAndWait(
  port: number | string,
  timeoutMs: number = 10000,
): Promise<ShutdownResult> {
  const baseUrl = `http://127.0.0.1:${port}`;
  let workerWasRunning = false;

  try {
    const response = await fetch(`${baseUrl}/api/admin/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    workerWasRunning = true;
    if (!response.ok) return { workerWasRunning, stopped: false };
  } catch (error) {
    // A timeout is ambiguous at the HTTP layer. Confirm the TCP port is closed
    // before treating it as a clean install with no worker to stop.
    if (isTimeoutError(error)) {
      const stopped = (await probeLoopbackPort(port)) === 'refused';
      return { workerWasRunning: !stopped, stopped };
    }
    // A worker may reset the shutdown socket while exiting, and a generic
    // fetch error can mean many other things. Confirm the loopback port is
    // actually closed before treating this as a no-worker case.
    const stopped = await healthProbeConfirmsStopped(baseUrl);
    return { workerWasRunning: !stopped, stopped };
  }

  const pollIntervalMs = 500;
  const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    try {
      await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
    } catch (err) {
      if (isConnectionRefused(err)) return { workerWasRunning, stopped: true };
      // A reset can happen while shutdown is still in progress. Keep polling;
      // if the port never reaches an explicit refusal, return stopped:false.
      continue;
    }
  }

  return { workerWasRunning, stopped: false };
}
