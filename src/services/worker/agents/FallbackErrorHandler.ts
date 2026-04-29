
import { FALLBACK_ERROR_PATTERNS } from './types.js';
import { logger } from '../../../utils/logger.js';

export function shouldFallbackToClaude(error: unknown): boolean {
  const message = getErrorMessage(error);

  return FALLBACK_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

function getErrorMessage(error: unknown): string {
  if (error === null || error === undefined) {
    return '';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }

  return String(error);
}

export function isAbortError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }

  if (typeof error === 'object' && 'name' in error) {
    return (error as { name: unknown }).name === 'AbortError';
  }

  return false;
}
