
import { AppError } from '../../server/ErrorHandler.js';
import { logger, type Component } from '../../../utils/logger.js';

export class ChromaUnavailableError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 503, 'CHROMA_UNAVAILABLE', cause ? { cause: cause.message } : undefined);
    this.name = 'ChromaUnavailableError';
  }
}

export class ChromaCorruptCollectionError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 500, 'CHROMA_CORRUPT_COLLECTION', cause ? { cause: cause.message } : undefined);
    this.name = 'ChromaCorruptCollectionError';
  }
}

/**
 * Log a failed live Chroma write. A ChromaCorruptCollectionError only tells
 * the caller to stop writing: ChromaSync already logged the drop at error
 * level, so it is logged at warn level here to report each drop only once.
 */
export function logChromaWriteFailure(
  component: Component,
  message: string,
  context: Record<string, unknown>,
  error: unknown
): void {
  if (error instanceof ChromaCorruptCollectionError) {
    logger.warn(component, message, context, error);
    return;
  }
  logger.error(component, message, context, error);
}
