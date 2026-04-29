import { afterEach, describe, expect, it, mock } from 'bun:test';
import { startHealthChecker, stopHealthChecker } from '../../src/supervisor/health-checker.js';

describe('health-checker', () => {
  afterEach(() => {
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
      startHealthChecker();
      startHealthChecker();

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
