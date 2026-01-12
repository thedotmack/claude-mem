/**
 * FallbackErrorHandler: Error detection for provider fallback
 *
 * Responsibility:
 * - Determine if an error should trigger fallback to Claude SDK
 * - Distinguish auth errors (should NOT fallback) from quota/server errors (SHOULD fallback)
 * - Provide consistent error classification across Gemini and OpenRouter
 *
 * Error Handling Strategy:
 * - AUTH errors (401/403): Do NOT fallback - user needs to fix configuration
 * - QUOTA errors (429): DO fallback - try next model/provider
 * - SERVER errors (5xx): DO fallback - provider having issues
 * - NETWORK errors: DO fallback - could be temporary
 */

import {
  FALLBACK_ERROR_PATTERNS,
  AUTH_ERROR_PATTERNS,
  QUOTA_ERROR_PATTERNS
} from './types.js';
import { logger } from '../../../utils/logger.js';

/**
 * Check if an error should trigger fallback to Claude SDK
 *
 * Errors that trigger fallback:
 * - 429: Rate limit exceeded
 * - 500/502/503: Server errors
 * - ECONNREFUSED: Connection refused (server down)
 * - ETIMEDOUT: Request timeout
 * - fetch failed: Network failure
 *
 * @param error - Error object to check
 * @returns true if the error should trigger fallback to Claude
 */
export function shouldFallbackToClaude(error: unknown): boolean {
  const message = getErrorMessage(error);

  return FALLBACK_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

/**
 * Extract error message from various error types
 */
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

/**
 * Check if error is an AbortError (user cancelled)
 *
 * @param error - Error object to check
 * @returns true if this is an abort/cancellation error
 */
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

/**
 * Check if an error is an authentication/authorization error
 * These errors should NOT trigger fallback - user needs to fix their configuration
 *
 * @param error - Error object to check
 * @returns true if this is an auth error (401, 403, invalid api key, etc.)
 */
export function isAuthError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return AUTH_ERROR_PATTERNS.some(pattern =>
    message.includes(pattern.toLowerCase())
  );
}

/**
 * Check if an error is a quota/rate limit error
 * These errors SHOULD trigger fallback to next model
 *
 * @param error - Error object to check
 * @returns true if this is a quota/rate limit error
 */
export function isQuotaError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return QUOTA_ERROR_PATTERNS.some(pattern =>
    message.includes(pattern.toLowerCase())
  );
}

/**
 * Get a user-friendly error message for auth errors
 * Helps users understand what went wrong and how to fix it
 *
 * @param error - Error object
 * @returns User-friendly error message with fix suggestions
 */
export function getAuthErrorMessage(error: unknown): string {
  const message = getErrorMessage(error).toLowerCase();

  if (message.includes('401') || message.includes('unauthorized') || message.includes('invalid api key')) {
    return 'Authentication failed: Invalid or missing API key. Please check your CLAUDE_MEM_OPENROUTER_API_KEY in ~/.claude-mem/settings.json';
  }

  if (message.includes('403') || message.includes('forbidden')) {
    return 'Authorization failed: Your API key does not have permission for this model. Please check your OpenRouter subscription or try a different model.';
  }

  if (message.includes('no cookie auth')) {
    return 'Authentication failed: The API endpoint requires authentication. Please verify your API key and base URL configuration.';
  }

  return `Authentication error: ${getErrorMessage(error)}. Please check your API credentials in ~/.claude-mem/settings.json`;
}
