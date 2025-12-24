/**
 * Silent debug utilities for non-critical logging
 * Used for happy-path debugging that shouldn't throw or block
 */

import { logger } from './logger.js';

/**
 * Log a message in debug mode, optionally with a fallback value
 * Never throws - silently logs and returns fallback if provided
 */
export function happy_path_error__with_fallback<T>(
  message: string,
  data?: unknown,
  fallback?: T
): T | undefined {
  try {
    if (data !== undefined) {
      logger.debug('DEBUG', message, { data });
    } else {
      logger.debug('DEBUG', message);
    }
  } catch {
    // Silently ignore logging errors
  }
  return fallback;
}
