import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

const workerCallLog: Array<{ path: string; method: string; body: unknown; options: unknown }> = [];
const nudgeLog: string[] = [];
let useServerRuntime = false;

// SessionEnd spools and exits: any awaited worker call is a regression.
mock.module('../../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  executeWithWorkerFallback: async (path: string, method: string, body: unknown, options: unknown) => {
    workerCallLog.push({ path, method, body, options });
    return { status: 'accepted' };
  },
  ensureWorkerRunning: async () => {
    workerCallLog.push({ path: 'ensureWorkerRunning', method: '', body: null, options: null });
    return true;
  },
  workerHttpRequest: (path: string) => {
    nudgeLog.push(path);
    return Promise.resolve(new Response('{"status":"draining"}', { status: 202 }));
  },
}));

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  ...realRuntimeSelectorSnapshot,
  resolveRuntimeContext: () => useServerRuntime
    ? { runtime: 'server', projectId: 'server-project', serverBaseUrl: 'http://server.test', client: {} }
    : { runtime: 'worker' },
}));

import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';
import { logger } from '../../../src/utils/logger.js';
import { spooledEntries, useTempHookSpoolDataDir } from '../../helpers/temp-hook-spool.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];
let tempSpool: ReturnType<typeof useTempHookSpoolDataDir>;

beforeEach(() => {
  tempSpool = useTempHookSpoolDataDir();
  workerCallLog.length = 0;
  nudgeLog.length = 0;
  useServerRuntime = false;
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  tempSpool.restore();
});

afterAll(() => {
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

describe('sessionEndHandler', () => {
  it('spools the normalized SessionEnd and nudges the worker without awaiting it', async () => {
    const { sessionEndHandler } = await import('../../../src/cli/handlers/session-end.js');
    const input = claudeCodeAdapter.normalizeInput({
      session_id: 'session-end-123',
      cwd: '/tmp/session-end-project',
      reason: 'logout',
    });
    input.platform = 'claude-code';

    const result = await sessionEndHandler.execute(input);

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCallLog).toHaveLength(0);
    expect(nudgeLog).toEqual(['/api/spool/nudge']);
    expect(spooledEntries()).toEqual([{
      kind: 'session_end',
      payload: { contentSessionId: 'session-end-123', platformSource: 'claude' },
      enqueuedAtEpochMs: expect.any(Number),
    }]);
  });

  it('keeps one idempotent entry when SessionEnd is delivered twice', async () => {
    const { sessionEndHandler } = await import('../../../src/cli/handlers/session-end.js');
    const input = { sessionId: 'session-end-twice', cwd: '/tmp/p', platform: 'claude-code', reason: 'other' };

    await sessionEndHandler.execute(input);
    await sessionEndHandler.execute({ ...input, reason: 'logout' });

    expect(workerCallLog).toHaveLength(0);
    expect(spooledEntries('session_end')).toHaveLength(1);
  });

  it('does not call the worker in server runtime', async () => {
    const { sessionEndHandler } = await import('../../../src/cli/handlers/session-end.js');
    useServerRuntime = true;

    const result = await sessionEndHandler.execute({
      sessionId: 'server-session-end',
      cwd: '/tmp/session-end-project',
      platform: 'claude-code',
      reason: 'other',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(workerCallLog).toHaveLength(0);
    expect(spooledEntries()).toHaveLength(0);
  });
});
