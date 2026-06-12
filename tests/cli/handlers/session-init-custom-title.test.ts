import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

const workerCallLog: Array<{ path: string; method: string; body: any }> = [];

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

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_RUNTIME: 'worker',
    CLAUDE_MEM_SEMANTIC_INJECT: 'false',
  }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (apiPath: string, method: string, body: unknown) => {
    workerCallLog.push({ path: apiPath, method, body });
    return { sessionDbId: 1, promptNumber: 1 };
  },
  isWorkerFallback: () => false,
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

function postedBody(): any {
  expect(workerCallLog).toHaveLength(1);
  return workerCallLog[0].body;
}

describe('sessionInitHandler customTitle privacy', () => {
  it('derives customTitle from the privacy-stripped prompt', async () => {
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    await sessionInitHandler.execute({
      sessionId: 'sess-title-privacy',
      cwd: '/tmp',
      platform: 'claude-code',
      prompt: '<private>SECRET-TITLE-CONTENT</private>\nHelp me write tests',
    });

    const body = postedBody();
    expect(body.prompt).toContain('SECRET-TITLE-CONTENT');
    expect(body.customTitle).toBe('Help me write tests');
    expect(body.customTitle).not.toContain('SECRET-TITLE-CONTENT');
  });

  it('omits customTitle when stripping leaves no prompt content', async () => {
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');

    await sessionInitHandler.execute({
      sessionId: 'sess-title-private-only',
      cwd: '/tmp',
      platform: 'claude-code',
      prompt: '<private>SECRET-ONLY</private>',
    });

    const body = postedBody();
    expect(body.customTitle).toBeUndefined();
  });
});
