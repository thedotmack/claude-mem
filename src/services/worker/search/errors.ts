/**
 * Search-related error classes
 */

import { AppError } from '../../server/ErrorHandler.js';

/**
 * Thrown when Chroma is expected to be available but failed at query time.
 * Maps to HTTP 503 Service Unavailable.
 */
export class ChromaUnavailableError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 503, 'CHROMA_UNAVAILABLE', cause ? { cause: cause.message } : undefined);
    this.name = 'ChromaUnavailableError';
  }
}
