
export interface ShutdownResult {
  workerWasRunning: boolean;
  confirmedStopped: boolean;
}

export async function shutdownWorkerAndWait(
  port: number | string,
  timeoutMs: number = 10000,
): Promise<ShutdownResult> {
  const baseUrl = `http://127.0.0.1:${port}`;
  let workerWasRunning = false;

  try {
    await fetch(`${baseUrl}/api/admin/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    workerWasRunning = true;
  } catch {
    return { workerWasRunning: false, confirmedStopped: true };
  }

  const pollIntervalMs = 500;
  const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    try {
      await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      // Health endpoint still responding — worker is still alive, keep waiting.
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') continue;
      return { workerWasRunning, confirmedStopped: true };
    }
  }

  return { workerWasRunning, confirmedStopped: false };
}
