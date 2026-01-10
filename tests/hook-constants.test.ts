/**
 * Tests for hook timeout and exit code constants
 *
 * Mock Justification (~12% mock code):
 * - process.platform: Only mocked to test cross-platform timeout multiplier
 *   logic - ensures Windows users get appropriate longer timeouts
 *
 * Value: Prevents regressions in timeout values that could cause
 * hook failures on slow systems or Windows
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { HOOK_TIMEOUTS, HOOK_EXIT_CODES, getTimeout } from '../src/shared/hook-constants.js';

describe('hook-constants', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    // Restore original platform after each test
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true
    });
  });

  describe('HOOK_TIMEOUTS', () => {
    it('should define DEFAULT timeout', () => {
      expect(HOOK_TIMEOUTS.DEFAULT).toBe(300000);
    });

    it('should define HEALTH_CHECK timeout', () => {
      expect(HOOK_TIMEOUTS.HEALTH_CHECK).toBe(30000);
    });

    it('should define WORKER_STARTUP_WAIT', () => {
      expect(HOOK_TIMEOUTS.WORKER_STARTUP_WAIT).toBe(1000);
    });

    it('should define WORKER_STARTUP_RETRIES', () => {
      expect(HOOK_TIMEOUTS.WORKER_STARTUP_RETRIES).toBe(300);
    });

    it('should define PRE_RESTART_SETTLE_DELAY', () => {
      expect(HOOK_TIMEOUTS.PRE_RESTART_SETTLE_DELAY).toBe(2000);
    });

    it('should define WINDOWS_MULTIPLIER', () => {
      expect(HOOK_TIMEOUTS.WINDOWS_MULTIPLIER).toBe(1.5);
    });

    it('should define POWERSHELL_COMMAND timeout as 10000ms', () => {
      expect(HOOK_TIMEOUTS.POWERSHELL_COMMAND).toBe(10000);
    });
  });

  describe('HOOK_EXIT_CODES', () => {
    it('should define SUCCESS exit code', () => {
      expect(HOOK_EXIT_CODES.SUCCESS).toBe(0);
    });

    it('should define FAILURE exit code', () => {
      expect(HOOK_EXIT_CODES.FAILURE).toBe(1);
    });

    it('should define BLOCKING_ERROR exit code', () => {
      expect(HOOK_EXIT_CODES.BLOCKING_ERROR).toBe(2);
    });
  });

  describe('getTimeout', () => {
    it('should return base timeout on non-Windows platforms', () => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
        configurable: true
      });

      expect(getTimeout(1000)).toBe(1000);
      expect(getTimeout(5000)).toBe(5000);
    });

    it('should apply Windows multiplier on Windows platform', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      });

      expect(getTimeout(1000)).toBe(1500);
      expect(getTimeout(2000)).toBe(3000);
    });

    it('should round Windows timeout to nearest integer', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      });

      // 333 * 1.5 = 499.5, should round to 500
      expect(getTimeout(333)).toBe(500);
    });

    it('should return base timeout on Linux', () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        writable: true,
        configurable: true
      });

      expect(getTimeout(1000)).toBe(1000);
    });
  });
});
