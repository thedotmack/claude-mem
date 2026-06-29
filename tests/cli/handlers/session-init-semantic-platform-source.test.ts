import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

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
    loadFromFile: () => ({
      CLAUDE_MEM_EXCLUDED_PROJECTS: '',
      CLAUDE_MEM_RUNTIME: 'worker',
      CLAUDE_MEM_SEMANTIC_INJECT: 'true',
      CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '7',
    }),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_RUNTIME: 'worker',
    CLAUDE_MEM_SEMANTIC_INJECT: 'true',
    CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '7',
  }),
}));

const workerCallLog: Array<{ path: string; method: string; body: unknown }> = [];

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (apiPath: string, method: string, body: unknown) => {
    workerCallLog.push({ path: apiPath, method, body });
    if (apiPath === '/api/sessions/init') {
      return { sessionDbId: 42, promptNumber: 1 };
    }
    if (apiPath === '/api/context/semantic') {
      return { context: 'semantic context', count: 1 };
    }
    throw new Error(`Unexpected worker call: ${apiPath}`);
  },
  isWorkerFallback: () => false,
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCallLog.length = 0;
  loggerSpies.forEach(spy => spy.mockRestore());
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
  ];
});

afterAll(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('sessionInitHandler semantic injection platform source', () => {
  it('includes normalized platformSource in semantic context request payload', async () => {
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    const result = await sessionInitHandler.execute({
      sessionId: 'session-semantic-platform',
      cwd: '/tmp/session-init-semantic-platform-test',
      platform: 'codex-cli',
      prompt: 'Please restore the platform-specific context for semantic injection.',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);

    const semanticCall = workerCallLog.find(call => call.path === '/api/context/semantic');
    expect(semanticCall).toBeDefined();
    expect(semanticCall?.method).toBe('POST');
    expect(semanticCall?.body).toMatchObject({
      q: 'Please restore the platform-specific context for semantic injection.',
      limit: '7',
      platformSource: 'codex',
    });
  });
});
