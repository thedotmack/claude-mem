import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';

const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };

const serverBetaCalls: {
  startSession: unknown[];
  contextObservations: unknown[];
} = {
  startSession: [],
  contextObservations: [],
};

let workerFallbackCalled = false;

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({
      CLAUDE_MEM_EXCLUDED_PROJECTS: '',
      CLAUDE_MEM_RUNTIME: 'server-beta',
      CLAUDE_MEM_SEMANTIC_INJECT: 'true',
      CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '7',
    }),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_RUNTIME: 'server-beta',
    CLAUDE_MEM_SEMANTIC_INJECT: 'true',
    CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '7',
  }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async () => {
    workerFallbackCalled = true;
    throw new Error('worker fallback should not be called in server-beta success path');
  },
  isWorkerFallback: () => false,
}));

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  resolveRuntimeContext: () => ({
    runtime: 'server-beta',
    projectId: 'server-project-1',
    serverBaseUrl: 'http://server-beta.test',
    client: {
      startSession: async (input: unknown) => {
        serverBetaCalls.startSession.push(input);
        return { session: { id: 'server-session-1' } };
      },
      contextObservations: async (input: unknown) => {
        serverBetaCalls.contextObservations.push(input);
        return {
          observations: [{ id: 'obs-1', projectId: 'server-project-1', content: 'context' }],
          context: 'server beta semantic context',
        };
      },
    },
  }),
  logServerBetaFallback: () => {},
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerFallbackCalled = false;
  serverBetaCalls.startSession.length = 0;
  serverBetaCalls.contextObservations.length = 0;
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
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

describe('sessionInitHandler server-beta semantic injection', () => {
  it('calls server-beta context endpoint with normalized platformSource and injects returned context', async () => {
    const { sessionInitHandler } = await import('../../../src/cli/handlers/session-init.js');
    const prompt = 'Please restore platform-aware context for this Cursor session.';

    const result = await sessionInitHandler.execute({
      sessionId: 'session-server-beta-context',
      cwd: '/tmp/session-init-server-beta-context-test',
      platform: 'Cursor CLI',
      prompt,
    });

    expect(workerFallbackCalled).toBe(false);
    expect(serverBetaCalls.startSession).toHaveLength(1);
    expect(serverBetaCalls.startSession[0]).toMatchObject({
      projectId: 'server-project-1',
      externalSessionId: 'session-server-beta-context',
      contentSessionId: 'session-server-beta-context',
      platformSource: 'cursor',
    });
    expect(serverBetaCalls.contextObservations).toHaveLength(1);
    expect(serverBetaCalls.contextObservations[0]).toEqual({
      projectId: 'server-project-1',
      query: prompt,
      limit: 7,
      platformSource: 'cursor',
    });
    expect(result).toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'server beta semantic context',
      },
    });
  });
});
