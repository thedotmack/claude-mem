/**
 * Tests for worker-spawner.ts validation guards.
 *
 * These tests cover the entry-point defensive guards in `ensureWorkerStarted`
 * (empty workerScriptPath, non-existent workerScriptPath). The deeper spawn
 * lifecycle (PID file cleanup, health checks, daemon spawn, readiness wait)
 * is not unit-tested here because it requires injectable I/O and a broader
 * refactor — see PR #1645 review feedback discussion.
 */

import { describe, it, expect } from 'bun:test';
import { ensureWorkerStarted } from '../../src/services/worker-spawner.js';

describe('ensureWorkerStarted validation guards', () => {
  // The port arguments here are arbitrary — both tests short-circuit on the
  // workerScriptPath validation guards before any network/health-check I/O,
  // so the port is never actually bound or contacted. Picked from an unlikely
  // range to prevent confusion if a future test ever does run real health
  // checks against these instances.

  it('returns false when workerScriptPath is empty string', async () => {
    const result = await ensureWorkerStarted(39001, '');
    expect(result).toBe(false);
  });

  it('returns false when workerScriptPath does not exist on disk', async () => {
    const bogusPath = '/tmp/__claude-mem-test-nonexistent-worker-script-' + Date.now() + '.cjs';
    const result = await ensureWorkerStarted(39002, bogusPath);
    expect(result).toBe(false);
  });
});
