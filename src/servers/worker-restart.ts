/**
 * MCP tool calls reach the worker over HTTP, and the MCP server outlives any
 * one worker: an idle exit (CLAUDE_MEM_IDLE_EXIT_SEC), a crash or
 * `claude-mem stop` leaves it talking to a closed port. When the worker
 * refuses the connection, start it once and send the request once more.
 *
 * Only a refused connection is retried. It means no worker received the
 * request, so the retry can never run it twice. Anything else (an HTTP error
 * status, a timeout, a reset) came from a worker that may have seen the
 * request, and passes through unchanged.
 */

import { isConnectionRefusedError } from '../shared/connection-errors.js';

export async function withWorkerRestartOnRefusedConnection<T>(
  sendRequest: () => Promise<T>,
  startWorker: () => Promise<boolean>,
): Promise<T> {
  try {
    return await sendRequest();
  } catch (error: unknown) {
    if (!isConnectionRefusedError(error)) throw error;
    if (!(await startWorker())) throw error;
    return await sendRequest();
  }
}
