/**
 * Handles fetch errors by providing user-friendly messages for connection issues
 * @throws Error with helpful message if worker is unreachable, re-throws original otherwise
 */
export function handleWorkerError(error: any): never {
  if (error.cause?.code === 'ECONNREFUSED' ||
      error.name === 'TimeoutError' ||
      error.message?.includes('fetch failed')) {
    throw new Error(
      "There's a problem with the worker. If you just updated, type `pm2 restart claude-mem-worker` in your terminal to continue"
    );
  }
  throw error;
}
