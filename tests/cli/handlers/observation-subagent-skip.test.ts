import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn, mock } from 'bun:test';

import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';

const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };

let mockSettings: Record<string, string> = {
  CLAUDE_MEM_EXCLUDED_PROJECTS: '',
  CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'false',
  CLAUDE_MEM_SKIP_AGENT_TYPES: '',
};

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => mockSettings,
}));

const workerCallLog: Array<{ path: string; method: string; body: unknown }> = [];
mock.module('../../../src/shared/worker-utils.js', () => ({
  ...realWorkerUtilsSnapshot,
  executeWithWorkerFallback: (path: string, method: string, body: unknown) => {
    workerCallLog.push({ path, method, body });
    return Promise.resolve({ status: 'queued' });
  },
  isWorkerFallback: () => false,
}));

const recordEventLog: unknown[] = [];
let mockRuntime: Record<string, unknown> = { runtime: 'worker' };
const serverRuntime = () => ({
  runtime: 'server',
  projectId: 'proj-test',
  serverBaseUrl: 'http://127.0.0.1:0',
  client: {
    recordEvent: (event: unknown) => {
      recordEventLog.push(event);
      return Promise.resolve();
    },
  },
});

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  resolveRuntimeContext: () => mockRuntime,
  logServerFallback: () => {},
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCallLog.length = 0;
  recordEventLog.length = 0;
  mockRuntime = { runtime: 'worker' };
  mockSettings = {
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS: 'false',
    CLAUDE_MEM_SKIP_AGENT_TYPES: '',
  };
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
});

afterAll(() => {
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 'session-abc',
  cwd: '/tmp',
  platform: 'claude-code',
  toolName: 'Bash',
  toolInput: { command: 'ls' },
  toolResponse: { stdout: '' },
  ...overrides,
});

describe('observationHandler subagent observation filtering', () => {
  it('dispatches main-session observations by default', async () => {
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(baseInput());
    expect(result.continue).toBe(true);
    expect(workerCallLog.length).toBe(1);
    expect(workerCallLog[0].path).toBe('/api/sessions/observations');
  });

  it('dispatches subagent observations by default', async () => {
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(
      baseInput({ agentId: 'agent-1', agentType: 'workflow-subagent' }),
    );
    expect(result.continue).toBe(true);
    expect(workerCallLog.length).toBe(1);
  });

  it('skips subagent observations when the global toggle is true', async () => {
    mockSettings.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS = 'true';
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(
      baseInput({ agentId: 'agent-1', agentType: 'workflow-subagent' }),
    );
    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(workerCallLog.length).toBe(0);
  });

  it('does not skip main-session observations when the global toggle is true', async () => {
    mockSettings.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS = 'true';
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(baseInput());
    expect(result.continue).toBe(true);
    expect(workerCallLog.length).toBe(1);
  });

  it('skips only listed agentType values', async () => {
    mockSettings.CLAUDE_MEM_SKIP_AGENT_TYPES = 'workflow-subagent,Explore';
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');

    const skipped = await observationHandler.execute(
      baseInput({ agentId: 'agent-1', agentType: 'workflow-subagent' }),
    );
    expect(skipped.continue).toBe(true);
    expect(workerCallLog.length).toBe(0);

    const kept = await observationHandler.execute(
      baseInput({ agentId: 'agent-2', agentType: 'Plan' }),
    );
    expect(kept.continue).toBe(true);
    expect(workerCallLog.length).toBe(1);
  });

  it('skips before the server runtime branch', async () => {
    mockRuntime = serverRuntime();
    mockSettings.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS = 'true';
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(
      baseInput({ agentId: 'agent-1', agentType: 'workflow-subagent' }),
    );
    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(recordEventLog.length).toBe(0);
    expect(workerCallLog.length).toBe(0);
  });

  it('still records main-session observations on the server runtime', async () => {
    mockRuntime = serverRuntime();
    mockSettings.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS = 'true';
    const { observationHandler } = await import('../../../src/cli/handlers/observation.js');
    const result = await observationHandler.execute(baseInput());
    expect(result.continue).toBe(true);
    expect(recordEventLog.length).toBe(1);
    expect(workerCallLog.length).toBe(0);
  });
});
