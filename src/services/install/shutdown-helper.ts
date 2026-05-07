import { waitForPortFree } from '../infrastructure/HealthMonitor.js';

export interface ShutdownResult {
  workerWasRunning: boolean;
  healthStoppedResponding: boolean;
  portFreed: boolean;
  shutdownConfirmed: boolean;
}

export interface ShutdownWaitOptions {
  pollIntervalMs?: number;
  portSettleMs?: number;
  waitForPortFree?: (port: number, timeoutMs: number) => Promise<boolean>;
  workerWasObserved?: boolean;
}

// The worker closes HTTP before the rest of graceful shutdown completes. Treat
// shutdown as confirmed only after the health endpoint is gone, the port can be
// rebound, and the OS has had a brief chance to release lingering socket state.
export const POST_SHUTDOWN_PORT_SETTLE_MS = process.platform === 'win32' ? 500 : 150;

async function waitForHealthToStopResponding(
  baseUrl: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    try {
      await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) continue;
      return true;
    }
  }

  return false;
}

export async function shutdownWorkerAndWait(
  port: number | string,
  timeoutMs: number = 10000,
  options: ShutdownWaitOptions = {},
): Promise<ShutdownResult> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const numericPort = Number(port);
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const portSettleMs = options.portSettleMs ?? POST_SHUTDOWN_PORT_SETTLE_MS;
  const waitForPortFreeFn = options.waitForPortFree ?? waitForPortFree;
  let workerWasRunning = false;

  try {
    const response = await fetch(`${baseUrl}/api/admin/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`Shutdown request returned HTTP ${response.status}`);
    }
    workerWasRunning = true;
  } catch {
    if (options.workerWasObserved === true) {
      workerWasRunning = true;
      const healthStoppedResponding = await waitForHealthToStopResponding(baseUrl, timeoutMs, pollIntervalMs);
      const portFreed = healthStoppedResponding && await waitForPortFreeFn(numericPort, timeoutMs);
      return {
        workerWasRunning,
        healthStoppedResponding,
        portFreed,
        shutdownConfirmed: healthStoppedResponding && portFreed,
      };
    }

    return {
      workerWasRunning: false,
      healthStoppedResponding: true,
      portFreed: true,
      shutdownConfirmed: true,
    };
  }

  const healthStoppedResponding = await waitForHealthToStopResponding(baseUrl, timeoutMs, pollIntervalMs);
  const portFreed = healthStoppedResponding && await waitForPortFreeFn(numericPort, timeoutMs);
  if (portFreed && portSettleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, portSettleMs));
  }

  return {
    workerWasRunning,
    healthStoppedResponding,
    portFreed,
    shutdownConfirmed: healthStoppedResponding && portFreed,
  };
}
