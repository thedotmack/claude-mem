
import { AppError } from '../../server/ErrorHandler.js';

export class ChromaUnavailableError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 503, 'CHROMA_UNAVAILABLE', cause ? { cause: cause.message } : undefined);
    this.name = 'ChromaUnavailableError';
  }
}
