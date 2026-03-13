import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { isRunningUnderSystemd } from '../../src/services/infrastructure/index.js';

/**
 * Tests for systemd detection and foreground mode (#1245).
 *
 * Problem: Under systemd, the 'start' command forks a daemon via spawnDaemon()
 * and exits. systemd's default KillMode=control-group kills ALL processes in
 * the cgroup when the parent exits, including the forked worker.
 *
 * Fix: Detect systemd via the INVOCATION_ID env var (set by systemd for every
 * service process). When detected, redirect 'start' to '--daemon' behavior
 * so the worker runs in the foreground and systemd tracks the correct PID.
 */
describe('Systemd foreground mode (#1245)', () => {
  let originalInvocationId: string | undefined;

  beforeEach(() => {
    originalInvocationId = process.env.INVOCATION_ID;
  });

  afterEach(() => {
    if (originalInvocationId !== undefined) {
      process.env.INVOCATION_ID = originalInvocationId;
    } else {
      delete process.env.INVOCATION_ID;
    }
  });

  describe('isRunningUnderSystemd', () => {
    it('returns true when INVOCATION_ID is set', () => {
      process.env.INVOCATION_ID = 'ab4f3c2e-1234-5678-9abc-def012345678';
      expect(isRunningUnderSystemd()).toBe(true);
    });

    it('returns false when INVOCATION_ID is not set', () => {
      delete process.env.INVOCATION_ID;
      expect(isRunningUnderSystemd()).toBe(false);
    });

    it('returns false when INVOCATION_ID is empty string', () => {
      process.env.INVOCATION_ID = '';
      expect(isRunningUnderSystemd()).toBe(false);
    });
  });
});
