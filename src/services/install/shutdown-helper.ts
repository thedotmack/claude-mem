
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
    // [ANTI-PATTERN IGNORED]: connection failure here is the expected outcome when no worker is
    // listening on the port (port probe); recovery is reporting workerWasRunning=false so the
    // installer skips the shutdown wait.
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
      // [ANTI-PATTERN IGNORED]: a failed health poll (non-timeout) is the expected signal that
      // the worker finished shutting down and the port is closed; recovery is exiting the poll
      // loop successfully.
      if (err instanceof Error && err.name === 'AbortError') continue;
      return { workerWasRunning };
    }
  }

  return { workerWasRunning };
}
