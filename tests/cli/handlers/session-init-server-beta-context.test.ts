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
const originalInternalEnv = process.env.CLAUDE_MEM_INTERNAL;

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
      CLAUDE_MEM_RUNTIME: 'server',
      CLAUDE_MEM_SEMANTIC_INJECT: 'true',
      CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '7',
    }),
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_RUNTIME: 'server',
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
    runtime: 'server',
    projectId: 'server-project-1',
    serverBaseUrl: 'http://server.test',
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
  logServerFallback: () => {},
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  delete process.env.CLAUDE_MEM_INTERNAL;
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
  if (originalInternalEnv === undefined) {
    delete process.env.CLAUDE_MEM_INTERNAL;
  } else {
    process.env.CLAUDE_MEM_INTERNAL = originalInternalEnv;
  }
  loggerSpies.forEach(spy => spy.mockRestore());
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

describe('sessionInitHandler server semantic injection', () => {
  it('starts the server session and skips worker semantic injection in server mode', async () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;
    const prompt = 'Please restore platform-aware context for this Cursor session.';
    const script = `
      const serverCalls = { startSession: [], contextObservations: [] };
      let workerFallbackCalled = false;
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'server',
          CLAUDE_MEM_SEMANTIC_INJECT: 'true',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '7',
        }),
        resolveRuntimeContext: () => ({
          runtime: 'server',
          projectId: 'server-project-1',
          serverBaseUrl: 'http://server.test',
          client: {
            startSession: async (input) => {
              serverCalls.startSession.push(input);
              return { session: { id: 'server-session-1' } };
            },
            contextObservations: async (input) => {
              serverCalls.contextObservations.push(input);
              return { observations: [], context: 'server semantic context' };
            },
          },
        }),
        shouldTrackProject: () => true,
        executeWithWorkerFallback: async () => {
          workerFallbackCalled = true;
          throw new Error('worker fallback should not be called in server success path');
        },
        isWorkerFallback: () => false,
        logServerFallback: () => {},
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-server-context',
        cwd: '/tmp/session-init-server-context-test',
        platform: 'Cursor CLI',
        prompt: ${JSON.stringify(prompt)},
      });
      if (workerFallbackCalled) throw new Error('worker fallback was called');
      if (serverCalls.startSession.length !== 1) throw new Error('startSession count mismatch: ' + serverCalls.startSession.length);
      const start = serverCalls.startSession[0];
      if (start.projectId !== 'server-project-1' || start.externalSessionId !== 'session-server-context' || start.contentSessionId !== 'session-server-context' || start.platformSource !== 'cursor') {
        throw new Error('startSession body mismatch: ' + JSON.stringify(start));
      }
      if (serverCalls.contextObservations.length !== 0) throw new Error('contextObservations should not be called');
      if (!result.continue || !result.suppressOutput) throw new Error('unexpected result ' + JSON.stringify(result));
    `;

    const result = Bun.spawnSync({
      cmd: [process.execPath, '--eval', script],
      cwd: process.cwd(),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(new TextDecoder().decode(result.stderr)).toBe('');
    expect(new TextDecoder().decode(result.stdout)).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
