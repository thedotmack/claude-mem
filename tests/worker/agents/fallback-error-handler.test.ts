import { describe, it, expect } from 'bun:test';

import { isAbortError } from '../../../src/services/worker/agents/FallbackErrorHandler.js';
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
