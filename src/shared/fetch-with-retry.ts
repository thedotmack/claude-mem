/**
 * Fetch with retry for transient network errors
 *
 * Handles ECONNRESET and ECONNREFUSED which occur when the worker
 * is restarting or multiple sessions race to connect.
 */

import { logger } from '../utils/logger.js';

const TRANSIENT_ERROR_CODES = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'];

interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Check if an error is a transient network error that should be retried
 */
function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: { code?: string } }).cause;
    if (cause?.code && TRANSIENT_ERROR_CODES.includes(cause.code)) {
      return true;
    }
    // Also check the error message for these codes
    if (TRANSIENT_ERROR_CODES.some(code => error.message.includes(code))) {
      return true;
    }
  }
  return false;
}

/**
 * Fetch with automatic retry for transient network errors
 * Uses exponential backoff: 100ms, 200ms, 400ms by default
 */
export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retryOptions?: RetryOptions
): Promise<Response> {
  const { retries = 3, baseDelayMs = 100, maxDelayMs = 1000 } = retryOptions ?? {};

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < retries && isTransientError(error)) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        logger.debug('FETCH', `Transient error, retrying in ${delay}ms`, {
          attempt: attempt + 1,
          maxRetries: retries,
          errorCode: (error as Error & { cause?: { code?: string } }).cause?.code
        });
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error('fetchWithRetry failed without error');
}
