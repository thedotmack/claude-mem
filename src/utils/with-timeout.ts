/**
 * Generic timeout wrapper utility
 *
 * Races a promise against a timeout, rejecting with a descriptive error
 * if the timeout fires first. Cleans up the timer on completion.
 *
 * Extracted from worker-service.ts where this pattern was duplicated 3+ times.
 */

export class TimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Race a promise against a timeout.
 *
 * @param promise - The promise to race
 * @param timeoutMs - Maximum time in milliseconds before rejecting
 * @param label - Descriptive label for error messages (e.g. 'Database initialization')
 * @returns The resolved value of the promise
 * @throws TimeoutError if the timeout fires first
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string = 'Operation'
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`${label} timeout after ${timeoutMs}ms`, timeoutMs)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}
