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
let mcpMode: 'success' | 'throw' | 'error' | 'empty' = 'success';
let contextShowTerminalOutput = 'false';

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: contextShowTerminalOutput,
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
    if (mcpMode === 'empty') {
      return { text: '   \n  ' };
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
  contextShowTerminalOutput = 'false';
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

  it('does not duplicate Codex context into systemMessage when terminal output is enabled', async () => {
    contextShowTerminalOutput = 'true';
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-mcp-context-terminal-output',
      cwd: '/tmp/repo',
      platform: 'codex',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from mcp');
    expect(result.systemMessage).toBeUndefined();
    expect(mcpCalls).toEqual([{
      name: 'session_start_context',
      args: {
        projects: ['parent-project', 'repo-project'],
        platformSource: 'codex',
      },
    }]);
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

  it('falls back to worker HTTP when the MCP call succeeds but returns nothing', async () => {
    // An empty body used to be accepted as context, which suppressed the
    // fallback and left Codex with no memory at all.
    mcpMode = 'empty';
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-mcp-empty',
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

  it('injects context on Codex compact rather than skipping the session', async () => {
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-codex-compact',
      cwd: '/tmp/repo',
      platform: 'codex',
      sessionSource: 'compact',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from mcp');
    expect(mcpCalls).toHaveLength(1);
  });

  it('prepends the upgrade notice instead of letting it replace the context', async () => {
    process.env.CLAUDE_MEM_UPGRADE_NOTICE = 'claude-mem: upgraded to v9.9.9 - run: npx claude-mem@latest install';
    try {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');

      const result = await contextHandler.execute({
        sessionId: 'session-upgrade-notice',
        cwd: '/tmp/repo',
        platform: 'codex',
      });

      expect(result.hookSpecificOutput?.additionalContext).toBe(
        'claude-mem: upgraded to v9.9.9 - run: npx claude-mem@latest install\n\ncontext from mcp',
      );
    } finally {
      delete process.env.CLAUDE_MEM_UPGRADE_NOTICE;
    }
  });

  it('still surfaces the upgrade notice when there is no context to inject', async () => {
    process.env.CLAUDE_MEM_UPGRADE_NOTICE = 'claude-mem: runtime not yet set up';
    try {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');

      const result = await contextHandler.execute({
        sessionId: 'session-upgrade-notice-only',
        cwd: '/tmp/repo',
        platform: 'codex',
      });

      expect(result.hookSpecificOutput?.additionalContext).toContain('claude-mem: runtime not yet set up');
    } finally {
      delete process.env.CLAUDE_MEM_UPGRADE_NOTICE;
    }
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
