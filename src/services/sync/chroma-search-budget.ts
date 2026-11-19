import { ChromaUnavailableError } from '../worker/search/errors.js';

/**
 * How long one search waits on Chroma in total before it falls back to
 * SQLite/FTS5 (#6323).
 *
 * The MCP `search` tool gives the worker 30 s for `/api/search`. A Chroma read
 * inherits the MCP SDK's 60 s request deadline, so on a large collection a
 * query that took 30-60 s outlived the caller and the search failed even
 * though the worker would have fallen back a little later. A search makes
 * several reads (the strategy widens its window, a filtered query can retry,
 * SearchManager walks up to five windows), so they share this one deadline.
 * 20 s leaves the rest of the caller's 30 s for the fallback.
 */
export const CHROMA_SEARCH_BUDGET_MS = 20_000;

/**
 * Wait for `read` until the search's deadline, then stop waiting.
 *
 * The read itself is not cancelled: chroma-mcp keeps the SDK's longer request
 * deadline, past which ChromaMcpManager treats it as hung and restarts it.
 * Cancelling or restarting at the search budget instead would tear down a
 * slow-but-healthy chroma-mcp on every slow search, and a large collection that
 * needs longer than the budget to load would never warm up.
 */
export async function withinSearchBudget<T>(read: () => Promise<T>, deadlineMs: number | undefined): Promise<T> {
  if (deadlineMs === undefined) return read();
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new ChromaUnavailableError('chroma-mcp search budget spent before another query; using the keyword fallback');
  }
  const pending = read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ChromaUnavailableError(
      `chroma-mcp did not answer within the ${CHROMA_SEARCH_BUDGET_MS} ms search budget; using the keyword fallback`,
    )), remainingMs);
  });
  try {
    return await Promise.race([pending, budget]);
  } finally {
    clearTimeout(timer);
    // The abandoned read settles later; its failure is ChromaMcpManager's to
    // log and must not surface as an unhandled rejection.
    pending.catch(() => {});
  }
}
