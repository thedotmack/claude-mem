import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
import * as realDeferredSessionEnd from '../../../src/shared/deferred-session-end.js';

const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realDeferredSessionEndSnapshot = { ...realDeferredSessionEnd };

const workerCallLog: Array<{ path: string; method: string; body: unknown; options: unknown }> = [];
const deferredSessionEndLog: Array<{ contentSessionId: string; platformSource: string }> = [];
let useServerRuntime = false;
let useWorkerFallback = false;

mock.module('../../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  executeWithWorkerFallback: async (path: string, method: string, body: unknown, options: unknown) => {
    workerCallLog.push({ path, method, body, options });
    return useWorkerFallback ? { continue: true } : { status: 'accepted' };
  },
  isWorkerFallback: () => useWorkerFallback,
}));

mock.module('../../../src/shared/deferred-session-end.js', () => ({
  ...realDeferredSessionEndSnapshot,
  enqueueDeferredSessionEnd: (input: { contentSessionId: string; platformSource: string }) => {
    deferredSessionEndLog.push(input);
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

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCallLog.length = 0;
  deferredSessionEndLog.length = 0;
  useServerRuntime = false;
  useWorkerFallback = false;
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
});

afterAll(() => {
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
  mock.module('../../../src/shared/deferred-session-end.js', () => realDeferredSessionEndSnapshot);
});

describe('sessionEndHandler', () => {
  it('posts the normalized SessionEnd fields without reading a transcript', async () => {
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
    expect(workerCallLog).toEqual([{
      path: '/api/sessions/session-end',
      method: 'POST',
      body: {
        contentSessionId: 'session-end-123',
        platformSource: 'claude',
        reason: 'logout',
        cwd: '/tmp/session-end-project',
      },
      options: { workerStartupTimeoutMs: 150, timeoutMs: 750 },
    }]);
  });

  it('persists an idempotent replay entry when the worker is unavailable', async () => {
    const { sessionEndHandler } = await import('../../../src/cli/handlers/session-end.js');
    useWorkerFallback = true;

    const result = await sessionEndHandler.execute({
      sessionId: 'session-end-deferred',
      cwd: '/tmp/session-end-project',
      platform: 'claude-code',
      reason: 'other',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(deferredSessionEndLog).toEqual([{
      contentSessionId: 'session-end-deferred',
      platformSource: 'claude',
    }]);
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
  });
});
