/**
 * Tests for the unrecoverable-error pattern matcher used by the worker
 * generator-error `.catch` branch (see worker-service.ts:713-730).
 *
 * Mock Justification: NONE (0% mock code)
 * - Imports a pure helper (isUnrecoverableError) + the backing pattern list.
 * - No IO, no timers, no module-level side effects.
 *
 * Covers Phase 3 of PLAN-windows-max-plan-drain-fix.md:
 *   - Each newly added OAuth/OpenRouter pattern matches a realistic error.
 *   - Bare '401' is intentionally NOT a pattern (avoids request-id false positives).
 *   - All pre-existing patterns still match realistic messages (no regression).
 */

import { describe, it, expect } from 'bun:test';

import {
  isUnrecoverableError,
  UNRECOVERABLE_ERROR_PATTERNS,
} from '../../src/services/worker/unrecoverable-patterns.js';

describe('isUnrecoverableError', () => {
  describe('newly added OAuth / auth patterns (Phase 3)', () => {
    it('matches "OAuth token expired"', () => {
      expect(
        isUnrecoverableError('OAuth token expired at 2026-04-20T00:00:00Z')
      ).toBe(true);
    });

    it('matches "token has been revoked"', () => {
      expect(
        isUnrecoverableError('API token has been revoked by the user')
      ).toBe(true);
    });

    it('matches "Unauthorized"', () => {
      expect(isUnrecoverableError('401 Unauthorized')).toBe(true);
      expect(isUnrecoverableError('Request failed: Unauthorized')).toBe(true);
    });

    it('matches "OpenRouter API error: 401"', () => {
      expect(
        isUnrecoverableError('OpenRouter API error: 401 - invalid API key')
      ).toBe(true);
    });

    it('matches "OpenRouter API error: 403"', () => {
      expect(
        isUnrecoverableError('OpenRouter API error: 403 - forbidden')
      ).toBe(true);
    });
  });

  describe('bare "401" is intentionally NOT a pattern', () => {
    it('does NOT match a request-id-like string that merely contains "401"', () => {
      // Locks in the decision to avoid bare '401' (too broad).
      expect(isUnrecoverableError('request-id-401xyz')).toBe(false);
      expect(isUnrecoverableError('correlation: abc-401-def')).toBe(false);
      expect(isUnrecoverableError('log: job 401 completed ok')).toBe(false);
    });

    it('DOES match "401 Unauthorized" via the "Unauthorized" pattern', () => {
      // This is correct and intended — when the status code is paired with
      // the "Unauthorized" string, we know it's really an auth failure.
      expect(isUnrecoverableError('401 Unauthorized')).toBe(true);
    });

    it('does NOT match a bare "403" either (same reasoning)', () => {
      expect(isUnrecoverableError('request-id-403abc')).toBe(false);
    });
  });

  describe('pre-existing patterns still match (no regressions)', () => {
    it('matches "Claude executable not found"', () => {
      expect(
        isUnrecoverableError("Claude executable not found at /usr/bin/claude")
      ).toBe(true);
    });

    it('matches "Invalid API key"', () => {
      expect(isUnrecoverableError('Invalid API key provided')).toBe(true);
    });

    it('matches "Gemini API error: 401"', () => {
      expect(
        isUnrecoverableError('Gemini API error: 401 - unauthorized')
      ).toBe(true);
    });

    it('matches "FOREIGN KEY constraint failed"', () => {
      expect(
        isUnrecoverableError('SQLITE_CONSTRAINT: FOREIGN KEY constraint failed')
      ).toBe(true);
    });

    it('matches "ENOENT"', () => {
      expect(
        isUnrecoverableError('spawn ENOENT no such file or directory')
      ).toBe(true);
    });

    it('matches "API_KEY_INVALID"', () => {
      expect(
        isUnrecoverableError('Error code: API_KEY_INVALID')
      ).toBe(true);
    });

    it('matches "PERMISSION_DENIED"', () => {
      expect(
        isUnrecoverableError('RPC failed: PERMISSION_DENIED')
      ).toBe(true);
    });
  });

  describe('falsy / non-unrecoverable inputs', () => {
    it('returns false for null, undefined, and empty string', () => {
      expect(isUnrecoverableError(null)).toBe(false);
      expect(isUnrecoverableError(undefined)).toBe(false);
      expect(isUnrecoverableError('')).toBe(false);
    });

    it('returns false for transient/recoverable errors', () => {
      // These are handled by fallback/restart logic, not unrecoverable path
      expect(isUnrecoverableError('429 Too Many Requests')).toBe(false);
      expect(isUnrecoverableError('500 Internal Server Error')).toBe(false);
      expect(isUnrecoverableError('503 Service Unavailable')).toBe(false);
      expect(isUnrecoverableError('ECONNRESET')).toBe(false);
      expect(isUnrecoverableError('fetch failed: network error')).toBe(false);
      expect(isUnrecoverableError('Something went wrong')).toBe(false);
    });
  });

  describe('UNRECOVERABLE_ERROR_PATTERNS shape', () => {
    it('contains every pattern the matcher relies on', () => {
      // Spot-check: the new Phase-3 patterns must be present literally
      expect(UNRECOVERABLE_ERROR_PATTERNS).toContain('OAuth token expired');
      expect(UNRECOVERABLE_ERROR_PATTERNS).toContain('token has been revoked');
      expect(UNRECOVERABLE_ERROR_PATTERNS).toContain('Unauthorized');
      expect(UNRECOVERABLE_ERROR_PATTERNS).toContain('OpenRouter API error: 401');
      expect(UNRECOVERABLE_ERROR_PATTERNS).toContain('OpenRouter API error: 403');
    });

    it('does NOT contain bare "401" or "403"', () => {
      // Explicit regression guard: the plan forbids adding these.
      expect(UNRECOVERABLE_ERROR_PATTERNS).not.toContain('401');
      expect(UNRECOVERABLE_ERROR_PATTERNS).not.toContain('403');
    });
  });
});
