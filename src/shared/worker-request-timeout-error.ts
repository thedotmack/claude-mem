/**
 * The local worker did not answer an HTTP request within its deadline.
 * Import-free so adapters such as progressive search can recognize it by type
 * instead of matching message text, which other backends also produce.
 * The message keeps the historical "Request timed out after <n>ms" wording that
 * existing callers match on.
 */
export class WorkerRequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = 'WorkerRequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
