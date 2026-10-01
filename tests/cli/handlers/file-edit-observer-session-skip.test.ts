import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

const dataDir = join(tmpdir(), 'claude-mem-file-edit-observer-test');
const workerCallLog: Array<{ path: string; method: string; body: unknown }> = [];

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return dataDir;
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '' }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: (apiPath: string, method: string, body: unknown) => {
    workerCallLog.push({ path: apiPath, method, body });
    throw new Error(`worker must not be called for internal observer sessions: ${apiPath}`);
  },
  isWorkerFallback: () => false,
}));

import { OBSERVER_SESSIONS_DIR } from '../../../src/shared/paths.js';
import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCallLog.length = 0;
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
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

describe('fileEditHandler internal observer sessions', () => {
  it('skips file edit observations before calling the worker', async () => {
    const { fileEditHandler } = await import('../../../src/cli/handlers/file-edit.js');

    const result = await fileEditHandler.execute({
      sessionId: 'observer-session-file-edit',
      cwd: OBSERVER_SESSIONS_DIR,
      platform: 'claude-code',
      filePath: join(OBSERVER_SESSIONS_DIR, 'transcript.jsonl'),
      edits: [{ oldText: 'before', newText: 'after' }],
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(workerCallLog).toEqual([]);
  });
});
