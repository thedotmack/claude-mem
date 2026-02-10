/**
 * Tests for hook error recovery behavior (Issue #897)
 *
 * Verifies that hook errors exit with code 0 (SUCCESS) instead of code 2
 * (BLOCKING_ERROR) to prevent confusing error messages shown to users
 * and Windows Terminal tab accumulation.
 */

import { describe, it, expect } from 'bun:test';
import { HOOK_EXIT_CODES } from '../../src/shared/hook-constants.js';
import { hookCommand } from '../../src/cli/hook-command.js';

describe('Hook Error Recovery (Issue #897)', () => {
  it('should exit with SUCCESS (0) when handler throws, not BLOCKING_ERROR (2)', async () => {
    // Use an invalid event name to trigger an error in getEventHandler
    const exitCode = await hookCommand('claude-code', 'nonexistent-event', { skipExit: true });

    // Must return SUCCESS (0), not BLOCKING_ERROR (2)
    expect(exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
  });

  it('should exit with SUCCESS (0) when platform adapter is invalid', async () => {
    const exitCode = await hookCommand('nonexistent-platform', 'SessionStart', { skipExit: true });

    expect(exitCode).toBe(HOOK_EXIT_CODES.SUCCESS);
  });

  it('HOOK_EXIT_CODES.SUCCESS should be 0', () => {
    expect(HOOK_EXIT_CODES.SUCCESS).toBe(0);
  });

  it('HOOK_EXIT_CODES.BLOCKING_ERROR should be 2', () => {
    expect(HOOK_EXIT_CODES.BLOCKING_ERROR).toBe(2);
  });
});
