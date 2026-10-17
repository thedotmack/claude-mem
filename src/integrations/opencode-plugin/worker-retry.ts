/**
 * Retry for capture POSTs that find the worker not listening yet.
 *
 * Nothing in OpenCode starts claude-mem's worker directly: the MCP server
 * OpenCode launches from opencode.json (#3621) starts it through the shared
 * ensureWorkerStarted, which takes a few seconds. A capture POST refused in
 * that window would be lost, so it is retried in the background with growing
 * delays (about 10 s in all) and then dropped quietly. Nothing awaits the
 * retries, so no OpenCode hook waits on a worker that is still booting.
 *
 * Kept out of the plugin entry module, which may export only its factory.
 */
export const REFUSED_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 3_000, 4_000];

/**
 * Re-run `attempt` after each delay until it no longer reports a refused
 * connection (`attempt` resolves true while the worker still refuses).
 */
export async function retryWhileRefused(
  attempt: () => Promise<boolean>,
  delaysMs: readonly number[] = REFUSED_RETRY_DELAYS_MS,
): Promise<void> {
  for (const delayMs of delaysMs) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (!(await attempt())) return;
  }
}
