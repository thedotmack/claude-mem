import { getWorkerRestartInstructions } from '../utils/error-messages.js';

/**
 * Handles fetch errors by providing user-friendly messages for connection issues
 * @throws Error with helpful message if worker is unreachable, re-throws original otherwise
 */
export function handleWorkerError(error: any): never {
  if (error.cause?.code === 'ECONNREFUSED' ||
      error.code === 'ConnectionRefused' ||  // Bun-specific error format
      error.name === 'TimeoutError' ||
      error.message?.includes('fetch failed') ||
      error.message?.includes('Unable to connect')) {
    throw new Error(getWorkerRestartInstructions());
  }
  throw error;
}
