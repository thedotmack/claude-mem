import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshots in afterAll so these mocks do not leak into later
// test files (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
  },
}));

// loadFromFileOnce() module-caches its result, so mocking SettingsDefaultsManager
// alone is not enough — an earlier test may have already cached real settings.
// Mock hook-settings directly so shouldTrackProject() always sees a string
// CLAUDE_MEM_EXCLUDED_PROJECTS regardless of global mock/cache state.
mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
}));

const workerCallLog: Array<{ path: string; options: any }> = [];
mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 37777,
  workerHttpRequest: (apiPath: string, options?: any) => {
    workerCallLog.push({ path: apiPath, options });
    throw new Error(
      `workerHttpRequest MUST NOT be called in subagent context (called with ${apiPath})`
    );
  },
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCallLog.length = 0;
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
  loggerSpies.forEach(spy => spy.mockRestore());
});

afterAll(() => {
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('summarizeHandler — subagent short-circuit', () => {
  it('skips summary and returns SUCCESS when agentId is set', async () => {
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    const result = await summarizeHandler.execute({
      sessionId: 'session-abc',
      cwd: '/tmp',
      platform: 'claude-code',
      transcriptPath: '/tmp/does-not-matter.jsonl',
      agentId: 'agent-abc',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(workerCallLog.length).toBe(0);
  });

  it('does NOT skip when only agentType is set (--agent main session still owns its summary)', async () => {
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    const result = await summarizeHandler.execute({
      sessionId: 'session-def',
      cwd: '/tmp',
      platform: 'claude-code',
      agentType: 'Explore',
      // transcriptPath intentionally omitted
    });

    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(workerCallLog.length).toBe(0);
  });

  it('skips summary when both agentId and agentType are set', async () => {
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    const result = await summarizeHandler.execute({
      sessionId: 'session-both',
      cwd: '/tmp',
      platform: 'claude-code',
      transcriptPath: '/tmp/does-not-matter.jsonl',
      agentId: 'agent-xyz',
      agentType: 'Plan',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(workerCallLog.length).toBe(0);
  });

  it('falls through to existing no-transcriptPath guard in main-session context', async () => {
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    const result = await summarizeHandler.execute({
      sessionId: 'session-main',
      cwd: '/tmp',
      platform: 'claude-code',
      // transcriptPath intentionally omitted
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(workerCallLog.length).toBe(0);
  });
});
