
export interface ShutdownResult {
  workerWasRunning: boolean;
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
    return { workerWasRunning: false };
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
      if (err instanceof Error && err.name === 'AbortError') continue;
      return { workerWasRunning };
    }
  }

  return { workerWasRunning };
}
