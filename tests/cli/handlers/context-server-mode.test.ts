// SPDX-License-Identifier: Apache-2.0
//
// Server-runtime SessionStart context injection (plans/2026-07-13-session-
// start-context-injection-server-mode.md, closes #2991). Mirrors the
// conventions in context-mcp-session-start.test.ts (worker/mcp path) and
// session-init-server-beta-context.test.ts (runtime-selector mocking).

import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realMcpClient from '../../../src/shared/mcp-client.js';
import * as realOauthToken from '../../../src/shared/oauth-token.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
import { ServerClientError } from '../../../src/services/hooks/server-client.js';

const realHookSettingsSnapshot = { ...realHookSettings };
const realMcpClientSnapshot = { ...realMcpClient };
const realOauthTokenSnapshot = { ...realOauthToken };
const realProjectNameSnapshot = { ...realProjectName };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };

const workerCalls: Array<{ path: string; method: string }> = [];
const contextObservationsCalls: unknown[] = [];

// Mutable per-test behavior for the mocked server client / runtime selection.
let runtimeMode: 'worker' | 'server' = 'server';
let serverContextBuildable = true;
let contextObservationsBehavior: 'success' | 'throw-client-error' | 'throw-plain-error' = 'success';
let contextObservationsError: unknown = null;
let showTerminalOutput = 'false';

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: showTerminalOutput,
  }),
}));

mock.module('../../../src/shared/mcp-client.js', () => ({
  callMcpToolOnce: async () => {
    throw new Error('callMcpToolOnce should not be called for non-codex platforms');
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
    throw new Error('worker fallback should not be reached from the server-runtime branch');
  },
  getWorkerPort: () => 37777,
  isWorkerFallback: () => false,
}));

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  selectRuntime: () => runtimeMode,
  buildServerContext: () => {
    if (!serverContextBuildable) return null;
    return {
      runtime: 'server',
      projectId: 'server-project-1',
      serverBaseUrl: 'http://server.test',
      client: {
        contextObservations: async (input: unknown) => {
          contextObservationsCalls.push(input);
          if (contextObservationsBehavior === 'throw-client-error') {
            throw contextObservationsError;
          }
          if (contextObservationsBehavior === 'throw-plain-error') {
            throw new Error('boom');
          }
          return { observations: [], context: 'server recency context' };
        },
      },
    };
  },
  logServerFallback: () => {},
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCalls.length = 0;
  contextObservationsCalls.length = 0;
  runtimeMode = 'server';
  serverContextBuildable = true;
  contextObservationsBehavior = 'success';
  contextObservationsError = null;
  showTerminalOutput = 'false';
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
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

describe('contextHandler server-runtime path', () => {
  it('injects recency-mode server context with no query, and never touches the worker path', async () => {
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-server-context',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('server recency context');
    expect(contextObservationsCalls).toEqual([{ projectId: 'server-project-1' }]);
    expect(workerCalls).toHaveLength(0);
  });

  it('returns empty context (not a worker-fallback attempt) when server config is incomplete', async () => {
    serverContextBuildable = false;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-server-missing-config',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('');
    expect(contextObservationsCalls).toHaveLength(0);
    expect(workerCalls).toHaveLength(0);
  });

  it('returns empty context (not a worker-fallback attempt) when the server client throws a ServerClientError', async () => {
    contextObservationsBehavior = 'throw-client-error';
    contextObservationsError = new ServerClientError('timeout', 'Server GET /v1/context failed: Request timed out after 30000ms');
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-server-timeout',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('');
    expect(contextObservationsCalls).toHaveLength(1);
    expect(workerCalls).toHaveLength(0);
  });

  it('returns empty context when the server client throws a non-ServerClientError', async () => {
    contextObservationsBehavior = 'throw-plain-error';
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-server-plain-error',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('');
    expect(workerCalls).toHaveLength(0);
  });

  it('keeps worker-runtime sessions on the existing worker path (server branch not taken)', async () => {
    runtimeMode = 'worker';
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    await expect(
      contextHandler.execute({
        sessionId: 'session-worker-runtime',
        cwd: '/tmp/repo',
        platform: 'claude-code',
      }),
    ).rejects.toThrow('worker fallback should not be reached from the server-runtime branch');

    expect(contextObservationsCalls).toHaveLength(0);
    expect(workerCalls).toEqual([{
      path: '/api/context/inject?projects=parent-project%2Crepo-project&platformSource=claude',
      method: 'GET',
    }]);
  });

  // Regression: CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT defaults to 'true'
  // (SettingsDefaultsManager) — discovered via a real end-to-end run against
  // a live server-runtime stack, not by unit tests alone (the existing
  // fixture at the top of this file overrides it to 'false'). Without the
  // usedServerRuntime guard, every SessionStart hook in a server-runtime
  // deployment would still call executeWithWorkerFallback here and lazily
  // spawn a local worker it has no business running.
  it('does not touch the worker path for the colored terminal-output variant either, when server runtime succeeded', async () => {
    showTerminalOutput = 'true';
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-server-colored-output',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('server recency context');
    expect(workerCalls).toHaveLength(0);
    expect(contextObservationsCalls).toEqual([{ projectId: 'server-project-1' }]);
    // No server-side "colors" variant exists — falls back to the plain
    // (uncolored) context for terminal display rather than a worker call.
    expect(result.systemMessage).toContain('server recency context');
  });
});
