
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import { CircuitBreaker, getBreakerStatePathForTesting } from '../../src/shared/worker-circuit-breaker.js';

function getStatePath(): string {
  return getBreakerStatePathForTesting();
}

function readState(): Record<string, unknown> {
  return JSON.parse(readFileSync(getStatePath(), 'utf-8')) as Record<string, unknown>;
}

function clearStateFile(): void {
  try { rmSync(getStatePath(), { force: true }); } catch { /* ignore */ }
}

function writeStateFile(state: Record<string, unknown>): void {
  const stateDir = dirname(getStatePath());
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(getStatePath(), JSON.stringify(state), 'utf-8');
}

describe('CircuitBreaker', () => {
  beforeEach(() => {
    CircuitBreaker.resetInstance();
    clearStateFile();
  });

  afterEach(() => {
    CircuitBreaker.resetInstance();
    clearStateFile();
    delete process.env.CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD;
    delete process.env.CLAUDE_MEM_BREAKER_RESET_TIMEOUT_MS;
    delete process.env.CLAUDE_MEM_BREAKER_LIFETIME_CAP;
  });

  describe('initial state', () => {
    it('should start CLOSED with zero failures', () => {
      const breaker = CircuitBreaker.getInstance();
      const state = breaker.getState();
      expect(state.state).toBe('CLOSED');
      expect(state.consecutiveFailures).toBe(0);
      expect(state.lifetimeFailures).toBe(0);
    });

    it('canAttempt() should return true when CLOSED', () => {
      expect(CircuitBreaker.getInstance().canAttempt()).toBe(true);
    });
  });

  describe('recordSuccess', () => {
    it('should keep state CLOSED as no-op when already CLOSED with zero failures', () => {
      const breaker = CircuitBreaker.getInstance();
      breaker.recordSuccess();
      expect(breaker.getState().state).toBe('CLOSED');
      expect(breaker.getState().consecutiveFailures).toBe(0);
    });

    it('should reset consecutiveFailures to 0 and stay CLOSED', () => {
      process.env.CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD = '10';
      CircuitBreaker.resetInstance();
      const breaker = CircuitBreaker.getInstance();

      breaker.recordFailure('test');
      expect(breaker.getState().consecutiveFailures).toBe(1);

      breaker.recordSuccess();
      const state = breaker.getState();
      expect(state.state).toBe('CLOSED');
      expect(state.consecutiveFailures).toBe(0);
    });
  });

  describe('recordFailure — threshold behavior', () => {
    it('should stay CLOSED below the threshold', () => {
      process.env.CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD = '3';
      CircuitBreaker.resetInstance();
      const breaker = CircuitBreaker.getInstance();

      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState().state).toBe('CLOSED');
      expect(breaker.getState().consecutiveFailures).toBe(2);
    });

    it('should open the breaker at the threshold', () => {
      process.env.CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD = '3';
      CircuitBreaker.resetInstance();
      const breaker = CircuitBreaker.getInstance();

      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState().state).toBe('CLOSED');
      breaker.recordFailure(); // 3rd failure = threshold
      expect(breaker.getState().state).toBe('OPEN');
    });

    it('canAttempt() should return false when OPEN and timeout not elapsed', () => {
      process.env.CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD = '1';
      process.env.CLAUDE_MEM_BREAKER_RESET_TIMEOUT_MS = '60000';
      CircuitBreaker.resetInstance();
      const breaker = CircuitBreaker.getInstance();

      breaker.recordFailure();
      expect(breaker.getState().state).toBe('OPEN');
      expect(breaker.canAttempt()).toBe(false);
    });

    it('canAttempt() should return true (HALF_OPEN) when OPEN and timeout has elapsed', async () => {
      process.env.CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD = '1';
      process.env.CLAUDE_MEM_BREAKER_RESET_TIMEOUT_MS = '1000';
      CircuitBreaker.resetInstance();
      const breaker = CircuitBreaker.getInstance();

      breaker.recordFailure();
      expect(breaker.getState().state).toBe('OPEN');
      expect(breaker.canAttempt()).toBe(false);

      await new Promise<void>(resolve => setTimeout(resolve, 1100));

      expect(breaker.canAttempt()).toBe(true);
      expect(breaker.getState().state).toBe('HALF_OPEN');
    }, 3000);
  });

  describe('HALF_OPEN transitions', () => {
    it('should close on success from HALF_OPEN', () => {
      writeStateFile({
        state: 'HALF_OPEN', consecutiveFailures: 3, lifetimeFailures: 3,
        openedAt: Date.now() - 60000, lastFailureAt: Date.now() - 60000,
        lastSuccessAt: null, lastTrippedAt: Date.now() - 60000,
      });
      CircuitBreaker.resetInstance();
      const breaker = CircuitBreaker.getInstance();

      expect(breaker.getState().state).toBe('HALF_OPEN');
      breaker.recordSuccess();
      expect(breaker.getState().state).toBe('CLOSED');
      expect(breaker.getState().consecutiveFailures).toBe(0);
    });

    it('should reopen on failure from HALF_OPEN', () => {
      process.env.CLAUDE_MEM_BREAKER_LIFETIME_CAP = '100';
      writeStateFile({
        state: 'HALF_OPEN', consecutiveFailures: 3, lifetimeFailures: 3,
        openedAt: Date.now() - 60000, lastFailureAt: Date.now() - 60000,
        lastSuccessAt: null, lastTrippedAt: Date.now() - 60000,
      });
      CircuitBreaker.resetInstance();
      const breaker = CircuitBreaker.getInstance();

      expect(breaker.getState().state).toBe('HALF_OPEN');
      breaker.recordFailure('probe-failed');
      expect(breaker.getState().state).toBe('OPEN');
    });
  });

  describe('lifetime cap', () => {
    it('should transition to OPEN_PERMANENT when lifetime cap is reached', () => {
      process.env.CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD = '100';
      process.env.CLAUDE_MEM_BREAKER_LIFETIME_CAP = '3';
      CircuitBreaker.resetInstance();
      const breaker = CircuitBreaker.getInstance();

      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState().state).toBe('CLOSED');
      breaker.recordFailure();
      expect(breaker.getState().state).toBe('OPEN_PERMANENT');
    });

    it('canAttempt() should return false permanently when OPEN_PERMANENT', () => {
      process.env.CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD = '100';
      process.env.CLAUDE_MEM_BREAKER_LIFETIME_CAP = '1';
      CircuitBreaker.resetInstance();
      const breaker = CircuitBreaker.getInstance();

      breaker.recordFailure();
      expect(breaker.getState().state).toBe('OPEN_PERMANENT');
      expect(breaker.canAttempt()).toBe(false);
    });

    it('lifetime cap of 0 disables the cap — regular threshold still applies', () => {
      process.env.CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD = '3';
      process.env.CLAUDE_MEM_BREAKER_LIFETIME_CAP = '0';
      CircuitBreaker.resetInstance();
      const breaker = CircuitBreaker.getInstance();

      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure(); // meets threshold → OPEN (not OPEN_PERMANENT)

      const state = breaker.getState();
      expect(state.state).toBe('OPEN');
      expect(state.lifetimeFailures).toBe(3);
    });
  });

  describe('forceReset', () => {
    it('should reset to CLOSED from OPEN', () => {
      process.env.CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD = '1';
      CircuitBreaker.resetInstance();
      const breaker = CircuitBreaker.getInstance();

      breaker.recordFailure();
      expect(breaker.getState().state).toBe('OPEN');

      breaker.forceReset();
      const state = breaker.getState();
      expect(state.state).toBe('CLOSED');
      expect(state.consecutiveFailures).toBe(0);
      expect(state.lifetimeFailures).toBe(1); // lifetime counter preserved
    });

    it('should reset to CLOSED from OPEN_PERMANENT', () => {
      process.env.CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD = '100';
      process.env.CLAUDE_MEM_BREAKER_LIFETIME_CAP = '1';
      CircuitBreaker.resetInstance();
      const breaker = CircuitBreaker.getInstance();

      breaker.recordFailure();
      expect(breaker.getState().state).toBe('OPEN_PERMANENT');

      breaker.forceReset();
      expect(breaker.getState().state).toBe('CLOSED');
      expect(breaker.canAttempt()).toBe(true);
    });
  });

  describe('state persistence', () => {
    it('should persist state to disk', () => {
      process.env.CLAUDE_MEM_BREAKER_FAILURE_THRESHOLD = '1';
      CircuitBreaker.resetInstance();
      const breaker = CircuitBreaker.getInstance();

      breaker.recordFailure('disk-test');
      expect(existsSync(getStatePath())).toBe(true);

      const state = readState();
      expect(state.state).toBe('OPEN');
      expect(typeof state.consecutiveFailures).toBe('number');
    });

    it('should migrate from legacy hook-failures.json', () => {
      const stateDir = dirname(getStatePath());
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        stateDir + '/hook-failures.json',
        JSON.stringify({ consecutiveFailures: 2, lastFailureAt: Date.now() - 5000 })
      );

      CircuitBreaker.resetInstance();
      const breaker = CircuitBreaker.getInstance();
      const state = breaker.getState();
      expect(state.lifetimeFailures).toBe(2);
      expect(state.state).toBe('CLOSED');
    });
  });
});
