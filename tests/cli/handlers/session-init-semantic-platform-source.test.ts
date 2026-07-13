import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

const realSettingsSnapshot = { ...realSettingsDefaultsManager };
const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const originalInternalEnv = process.env.CLAUDE_MEM_INTERNAL;

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
  delete process.env.CLAUDE_MEM_INTERNAL;
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
  if (originalInternalEnv === undefined) {
    delete process.env.CLAUDE_MEM_INTERNAL;
  } else {
    process.env.CLAUDE_MEM_INTERNAL = originalInternalEnv;
  }
  loggerSpies.forEach(spy => spy.mockRestore());
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('sessionInitHandler semantic injection platform source', () => {
  it('includes normalized platformSource in semantic context request payload', async () => {
    const env = { ...process.env };
    delete env.CLAUDE_MEM_INTERNAL;
    const prompt = 'Please restore the platform-specific context for semantic injection.';
    const script = `
      const workerCallLog = [];
      const { sessionInitHandler, setSessionInitDependenciesForTesting } = await import('./src/cli/handlers/session-init.ts');
      setSessionInitDependenciesForTesting({
        loadFromFileOnce: () => ({
          CLAUDE_MEM_EXCLUDED_PROJECTS: '',
          CLAUDE_MEM_RUNTIME: 'worker',
          CLAUDE_MEM_SEMANTIC_INJECT: 'true',
          CLAUDE_MEM_SEMANTIC_INJECT_LIMIT: '7',
        }),
        resolveRuntimeContext: () => ({ runtime: 'worker' }),
        shouldTrackProject: () => true,
        executeWithWorkerFallback: async (apiPath, method, body) => {
          workerCallLog.push({ path: apiPath, method, body });
          if (apiPath === '/api/sessions/init') return { sessionDbId: 42, promptNumber: 1 };
          if (apiPath === '/api/context/semantic') return { context: 'semantic context', count: 1 };
          throw new Error('Unexpected worker call: ' + apiPath);
        },
        isWorkerFallback: () => false,
      });
      const result = await sessionInitHandler.execute({
        sessionId: 'session-semantic-platform',
        cwd: '/tmp/session-init-semantic-platform-test',
        platform: 'codex-cli',
        prompt: ${JSON.stringify(prompt)},
      });
      const semanticCall = workerCallLog.find(call => call.path === '/api/context/semantic');
      if (!result.continue || !result.suppressOutput) throw new Error('unexpected result ' + JSON.stringify(result));
      if (!semanticCall) throw new Error('semantic call missing: ' + JSON.stringify(workerCallLog));
      if (semanticCall.method !== 'POST') throw new Error('semantic method mismatch: ' + semanticCall.method);
      const body = semanticCall.body;
      if (body.q !== ${JSON.stringify(prompt)} || body.limit !== '7' || body.platformSource !== 'codex') {
        throw new Error('semantic body mismatch: ' + JSON.stringify(body));
      }
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
