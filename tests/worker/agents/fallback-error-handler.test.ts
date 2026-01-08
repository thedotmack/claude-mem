/**
 * Tests for fallback error classification logic
 *
 * Mock Justification: NONE (0% mock code)
 * - Tests pure functions directly with no external dependencies
 * - shouldFallbackToClaude: Pattern matching on error messages
 * - isAbortError: Simple type checking
 *
 * High-value tests: Ensure correct provider fallback behavior for transient errors
 */
import { describe, it, expect } from 'bun:test';

// Import directly from specific files to avoid worker-service import chain
import { shouldFallbackToClaude, isAbortError } from '../../../src/services/worker/agents/FallbackErrorHandler.js';
import { FALLBACK_ERROR_PATTERNS } from '../../../src/services/worker/agents/types.js';

describe('FallbackErrorHandler', () => {
  describe('FALLBACK_ERROR_PATTERNS', () => {
    it('should contain all 7 expected patterns', () => {
      expect(FALLBACK_ERROR_PATTERNS).toHaveLength(7);
      expect(FALLBACK_ERROR_PATTERNS).toContain('429');
      expect(FALLBACK_ERROR_PATTERNS).toContain('500');
      expect(FALLBACK_ERROR_PATTERNS).toContain('502');
      expect(FALLBACK_ERROR_PATTERNS).toContain('503');
      expect(FALLBACK_ERROR_PATTERNS).toContain('ECONNREFUSED');
      expect(FALLBACK_ERROR_PATTERNS).toContain('ETIMEDOUT');
      expect(FALLBACK_ERROR_PATTERNS).toContain('fetch failed');
    });
  });

  describe('shouldFallbackToClaude', () => {
    describe('returns true for fallback patterns', () => {
      it('should return true for 429 rate limit errors', () => {
        expect(shouldFallbackToClaude('Rate limit exceeded: 429')).toBe(true);
        expect(shouldFallbackToClaude(new Error('429 Too Many Requests'))).toBe(true);
      });

      it('should return true for 500 internal server errors', () => {
        expect(shouldFallbackToClaude('500 Internal Server Error')).toBe(true);
        expect(shouldFallbackToClaude(new Error('Server returned 500'))).toBe(true);
      });

      it('should return true for 502 bad gateway errors', () => {
        expect(shouldFallbackToClaude('502 Bad Gateway')).toBe(true);
        expect(shouldFallbackToClaude(new Error('Upstream returned 502'))).toBe(true);
      });

      it('should return true for 503 service unavailable errors', () => {
        expect(shouldFallbackToClaude('503 Service Unavailable')).toBe(true);
        expect(shouldFallbackToClaude(new Error('Server is 503'))).toBe(true);
      });

      it('should return true for ECONNREFUSED errors', () => {
        expect(shouldFallbackToClaude('connect ECONNREFUSED 127.0.0.1:8080')).toBe(true);
        expect(shouldFallbackToClaude(new Error('ECONNREFUSED'))).toBe(true);
      });

      it('should return true for ETIMEDOUT errors', () => {
        expect(shouldFallbackToClaude('connect ETIMEDOUT')).toBe(true);
        expect(shouldFallbackToClaude(new Error('Request ETIMEDOUT'))).toBe(true);
      });

      it('should return true for fetch failed errors', () => {
        expect(shouldFallbackToClaude('fetch failed')).toBe(true);
        expect(shouldFallbackToClaude(new Error('fetch failed: network error'))).toBe(true);
      });
    });

    describe('returns false for non-fallback errors', () => {
      it('should return false for 400 Bad Request', () => {
        expect(shouldFallbackToClaude('400 Bad Request')).toBe(false);
        expect(shouldFallbackToClaude(new Error('400 Invalid argument'))).toBe(false);
      });

      it('should return false for 401 Unauthorized', () => {
        expect(shouldFallbackToClaude('401 Unauthorized')).toBe(false);
      });

      it('should return false for 403 Forbidden', () => {
        expect(shouldFallbackToClaude('403 Forbidden')).toBe(false);
      });

      it('should return false for 404 Not Found', () => {
        expect(shouldFallbackToClaude('404 Not Found')).toBe(false);
      });

      it('should return false for generic errors', () => {
        expect(shouldFallbackToClaude('Something went wrong')).toBe(false);
        expect(shouldFallbackToClaude(new Error('Unknown error'))).toBe(false);
      });
    });

    describe('handles various error types', () => {
      it('should handle string errors', () => {
        expect(shouldFallbackToClaude('429 rate limited')).toBe(true);
        expect(shouldFallbackToClaude('invalid input')).toBe(false);
      });

      it('should handle Error objects', () => {
        expect(shouldFallbackToClaude(new Error('429 Too Many Requests'))).toBe(true);
        expect(shouldFallbackToClaude(new Error('Bad Request'))).toBe(false);
      });

      it('should handle objects with message property', () => {
        expect(shouldFallbackToClaude({ message: '503 unavailable' })).toBe(true);
        expect(shouldFallbackToClaude({ message: 'ok' })).toBe(false);
      });

      it('should handle null and undefined', () => {
        expect(shouldFallbackToClaude(null)).toBe(false);
        expect(shouldFallbackToClaude(undefined)).toBe(false);
      });

      it('should handle non-error objects by stringifying', () => {
        expect(shouldFallbackToClaude({ code: 429 })).toBe(false); // toString won't include 429
        expect(shouldFallbackToClaude(429)).toBe(true); // number 429 stringifies to "429"
      });
    });
  });

  describe('isAbortError', () => {
    it('should return true for Error with name "AbortError"', () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      expect(isAbortError(abortError)).toBe(true);
    });

    it('should return true for objects with name "AbortError"', () => {
      expect(isAbortError({ name: 'AbortError', message: 'aborted' })).toBe(true);
    });

    it('should return false for regular Error objects', () => {
      expect(isAbortError(new Error('Some error'))).toBe(false);
      expect(isAbortError(new TypeError('Type error'))).toBe(false);
    });

    it('should return false for errors with other names', () => {
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      expect(isAbortError(error)).toBe(false);
    });

    it('should return false for null and undefined', () => {
      expect(isAbortError(null)).toBe(false);
      expect(isAbortError(undefined)).toBe(false);
    });

    it('should return false for strings', () => {
      expect(isAbortError('AbortError')).toBe(false);
    });

    it('should return false for objects without name property', () => {
      expect(isAbortError({ message: 'error' })).toBe(false);
      expect(isAbortError({})).toBe(false);
    });
  });
});
