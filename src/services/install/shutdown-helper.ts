/**
 * Shared worker-shutdown helper used by both `install` (to clear out a
 * running worker before overwriting plugin files) and `uninstall` (to
 * release file locks before deletion).
 *
 * Posts to `/api/admin/shutdown`, then polls `/api/health` until the
 * connection is refused (= worker is gone) or the timeout elapses.
 *
 * Best-effort: if the worker is not running, the POST throws and we
 * return immediately. Callers should never depend on this throwing.
 */

export interface ShutdownResult {
  /** True if we actively shut down a worker; false if none was running. */
  workerWasRunning: boolean;
  /** True if we observed the worker stop responding before the timeout. */
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
    // Worker not running (connection refused) or shutdown POST timed out.
    // Either way, nothing more to do.
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
    } catch {
      // Connection refused = worker is gone (expected shutdown behavior).
      return { workerWasRunning, confirmedStopped: true };
    }
  }

  return { workerWasRunning, confirmedStopped: false };
}
