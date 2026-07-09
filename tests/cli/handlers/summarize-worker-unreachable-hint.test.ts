import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
}));

const WORKER_FALLBACK_BRAND = Symbol.for('claude-mem/worker-fallback');
// Per-test control of what executeWithWorkerFallback resolves to.
let nextFallback: Record<string | symbol, unknown> | null = null;

mock.module('../../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  executeWithWorkerFallback: () => Promise.resolve(nextFallback),
}));

import { logger } from '../../../src/utils/logger.js';
import { summarizeHandler } from '../../../src/cli/handlers/summarize.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  nextFallback = null;
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(s => s.mockRestore());
});

afterAll(() => {
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

const baseInput = {
  sessionId: 'test-session',
  cwd: '/tmp/summarize-hint-test',
  lastAssistantMessage: 'final answer',
  platform: 'claude-code',
};

describe('#3161 — tripped fail-loud streak surfaces as a USER_HINT on the Stop hook', () => {
  it('attaches systemMessage when the worker fallback carries consecutiveFailures', async () => {
    nextFallback = {
      continue: true,
      reason: 'worker_unreachable',
      consecutiveFailures: 3,
      [WORKER_FALLBACK_BRAND]: true,
    };
    const result = await summarizeHandler.execute({ ...baseInput });
    expect(result.systemMessage).toContain('unreachable for 3 consecutive hooks');
    expect(result.systemMessage).toContain('npx claude-mem restart');
    // The hint must never change the non-blocking contract.
    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('stays silent below the fail-loud threshold (fallback without consecutiveFailures)', async () => {
    nextFallback = {
      continue: true,
      reason: 'worker_unreachable',
      [WORKER_FALLBACK_BRAND]: true,
    };
    const result = await summarizeHandler.execute({ ...baseInput });
    expect(result.systemMessage).toBeUndefined();
    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});
