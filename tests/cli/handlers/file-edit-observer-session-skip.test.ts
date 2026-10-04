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

// FileEdit spools and exits: no awaited worker call on any path. The nudge is
// recorded separately (fire-and-forget).
const nudgeLog: string[] = [];
mock.module('../../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  executeWithWorkerFallback: (apiPath: string, method: string, body: unknown) => {
    workerCallLog.push({ path: apiPath, method, body });
    throw new Error(`file-edit hook must not await the worker: ${apiPath}`);
  },
  workerHttpRequest: (apiPath: string) => {
    nudgeLog.push(apiPath);
    return Promise.resolve(new Response('{"status":"draining"}', { status: 202 }));
  },
}));

import { OBSERVER_SESSIONS_DIR } from '../../../src/shared/paths.js';
import { logger } from '../../../src/utils/logger.js';
import { spooledEntries, useTempHookSpoolDataDir } from '../../helpers/temp-hook-spool.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let tempSpool: ReturnType<typeof useTempHookSpoolDataDir>;

beforeEach(() => {
  tempSpool = useTempHookSpoolDataDir();
  workerCallLog.length = 0;
  nudgeLog.length = 0;
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  tempSpool.restore();
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
    expect(spooledEntries()).toEqual([]);
    expect(nudgeLog).toEqual([]);
  });

  it('spools a tracked file edit and nudges the worker without awaiting it', async () => {
    const { fileEditHandler } = await import('../../../src/cli/handlers/file-edit.js');

    const result = await fileEditHandler.execute({
      sessionId: 'user-session-file-edit',
      cwd: '/tmp/file-edit-project',
      platform: 'Cursor',
      filePath: '/tmp/file-edit-project/a.ts',
      edits: [{ oldText: 'before', newText: 'after' }],
    });

    expect(result.continue).toBe(true);
    expect(workerCallLog).toEqual([]);
    expect(nudgeLog).toEqual(['/api/spool/nudge']);
    expect(spooledEntries()).toEqual([{
      kind: 'file_edit',
      payload: {
        contentSessionId: 'user-session-file-edit',
        platformSource: 'cursor',
        toolName: 'write_file',
        toolInput: { filePath: '/tmp/file-edit-project/a.ts', edits: [{ oldText: 'before', newText: 'after' }] },
        toolResponse: { success: true },
        cwd: '/tmp/file-edit-project',
      },
      enqueuedAtEpochMs: expect.any(Number),
    }]);
  });
});
