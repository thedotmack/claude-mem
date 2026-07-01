import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realMcpClient from '../../../src/shared/mcp-client.js';
import * as realOauthToken from '../../../src/shared/oauth-token.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

const realHookSettingsSnapshot = { ...realHookSettings };
const realMcpClientSnapshot = { ...realMcpClient };
const realOauthTokenSnapshot = { ...realOauthToken };
const realProjectNameSnapshot = { ...realProjectName };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

const mcpCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const workerCalls: Array<{ path: string; method: string }> = [];
let mcpMode: 'success' | 'throw' | 'error' = 'success';

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false',
  }),
}));

mock.module('../../../src/shared/mcp-client.js', () => ({
  callMcpToolOnce: async (name: string, args: Record<string, unknown>) => {
    mcpCalls.push({ name, args });
    if (mcpMode === 'throw') {
      throw new Error('mcp unavailable');
    }
    if (mcpMode === 'error') {
      return { text: 'mcp tool error', isError: true };
    }
    return { text: 'context from mcp' };
  },
}));

mock.module('../../../src/shared/oauth-token.js', () => ({
  readStaleMarker: () => null,
}));

mock.module('../../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'repo-project',
    parent: null,
    isWorktree: false,
    allProjects: ['parent-project', 'repo-project'],
  }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (apiPath: string, method: 'GET' | 'POST') => {
    workerCalls.push({ path: apiPath, method });
    return 'context from worker';
  },
  getWorkerPort: () => 37777,
  isWorkerFallback: () => false,
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  mcpCalls.length = 0;
  workerCalls.length = 0;
  mcpMode = 'success';
  loggerSpies.forEach(spy => spy.mockRestore());
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterAll(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/mcp-client.js', () => realMcpClientSnapshot);
  mock.module('../../../src/shared/oauth-token.js', () => realOauthTokenSnapshot);
  mock.module('../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('contextHandler Codex SessionStart MCP path', () => {
  it('loads Codex SessionStart context through MCP instead of direct worker HTTP', async () => {
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-mcp-context',
      cwd: '/tmp/repo',
      platform: 'codex',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from mcp');
    expect(mcpCalls).toEqual([{
      name: 'session_start_context',
      args: {
        projects: ['parent-project', 'repo-project'],
        platformSource: 'codex',
      },
    }]);
    expect(workerCalls).toHaveLength(0);
  });

  it('falls back to worker HTTP when the MCP call fails', async () => {
    mcpMode = 'throw';
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-mcp-fallback',
      cwd: '/tmp/repo',
      platform: 'codex',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    expect(mcpCalls).toHaveLength(1);
    expect(workerCalls).toEqual([{
      path: '/api/context/inject?projects=parent-project%2Crepo-project&platformSource=codex',
      method: 'GET',
    }]);
  });

  it('keeps non-Codex startup on the existing worker path', async () => {
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-claude-context',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    expect(mcpCalls).toHaveLength(0);
    expect(workerCalls).toEqual([{
      path: '/api/context/inject?projects=parent-project%2Crepo-project&platformSource=claude',
      method: 'GET',
    }]);
  });
});
