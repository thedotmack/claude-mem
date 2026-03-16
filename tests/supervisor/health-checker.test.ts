import { afterEach, describe, expect, it, mock } from 'bun:test';
import { startHealthChecker, stopHealthChecker } from '../../src/supervisor/health-checker.js';

describe('health-checker', () => {
  afterEach(() => {
    // Always stop the checker to avoid leaking intervals between tests
    stopHealthChecker();
  });

  it('startHealthChecker sets up an interval without throwing', () => {
    expect(() => startHealthChecker()).not.toThrow();
  });

  it('stopHealthChecker clears the interval without throwing', () => {
    startHealthChecker();
    expect(() => stopHealthChecker()).not.toThrow();
  });

  it('stopHealthChecker is safe to call when no checker is running', () => {
    expect(() => stopHealthChecker()).not.toThrow();
  });

  it('multiple startHealthChecker calls do not create multiple intervals', () => {
    // Track setInterval calls
    const originalSetInterval = globalThis.setInterval;
    let setIntervalCallCount = 0;

    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      setIntervalCallCount++;
      return originalSetInterval(...args);
    }) as typeof setInterval;

    try {
      // Stop any existing checker first to ensure clean state
      stopHealthChecker();
      setIntervalCallCount = 0;

      startHealthChecker();
      startHealthChecker();
      startHealthChecker();

      // Only one interval should have been created due to the guard
      expect(setIntervalCallCount).toBe(1);
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });

  it('stopHealthChecker after start allows restarting', () => {
    const originalSetInterval = globalThis.setInterval;
    let setIntervalCallCount = 0;

    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      setIntervalCallCount++;
      return originalSetInterval(...args);
    }) as typeof setInterval;

    try {
      stopHealthChecker();
      setIntervalCallCount = 0;

      startHealthChecker();
      expect(setIntervalCallCount).toBe(1);

      stopHealthChecker();

      startHealthChecker();
      expect(setIntervalCallCount).toBe(2);
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });
});
