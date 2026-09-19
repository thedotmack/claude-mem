import { afterAll, describe, expect, it, mock } from 'bun:test';

import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realOauthToken from '../../../src/shared/oauth-token.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

/**
 * Snapshot the real namespaces EAGERLY, before the mock.module calls below.
 * `import * as x` yields a live namespace object that bun re-points when the
 * module is mocked, so spreading it later (inside afterAll) would copy the
 * stubs back in and leak them into every test file that runs after this one.
 */
const realHookSettingsSnapshot = { ...realHookSettings };
const realOauthTokenSnapshot = { ...realOauthToken };
const realProjectNameSnapshot = { ...realProjectName };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

const calls: unknown[][] = [];
let troubleNotice: string | null = null;
let workerFallback = false;

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({ CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false' }),
}));

mock.module('../../../src/shared/oauth-token.js', () => ({ readStaleMarker: () => null }));

mock.module('../../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'repo-project',
    parent: 'parent-project',
    isWorktree: true,
    allProjects: ['parent-project', 'repo-project'],
  }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (...args: unknown[]) => {
    calls.push(args);
    return 'context from worker';
  },
  getWorkerPort: () => 37777,
  isWorkerFallback: () => workerFallback,
  readWorkerTroubleNotice: () => troubleNotice,
}));

afterAll(() => {
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/oauth-token.js', () => realOauthTokenSnapshot);
  mock.module('../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('contextHandler SessionStart path', () => {
  it('injects Codex context with one bounded worker startup and request', async () => {
    calls.length = 0;
    troubleNotice = null;
    workerFallback = false;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-context',
      cwd: '/tmp/repo',
      platform: 'codex',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    expect(calls).toEqual([[
      '/api/context/inject?projects=parent-project%2Crepo-project&platformSource=codex',
      'GET',
      undefined,
      { workerStartupTimeoutMs: 15_000, timeoutMs: 2_000 },
    ]]);
  });

  it('keeps the existing worker lifecycle behavior for Claude', async () => {
    calls.length = 0;
    troubleNotice = null;
    workerFallback = false;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    await contextHandler.execute({
      sessionId: 'session-context-claude',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    expect(calls).toEqual([[
      '/api/context/inject?projects=parent-project%2Crepo-project&platformSource=claude',
      'GET',
      undefined,
      undefined,
    ]]);
  });

  it('prepends the worker-trouble notice to the injected context (#4127)', async () => {
    calls.length = 0;
    troubleNotice = 'claude-mem: the memory worker is unreachable.';
    workerFallback = false;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-context-trouble',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe(
      'claude-mem: the memory worker is unreachable.\n\ncontext from worker'
    );
  });

  it('still surfaces the notice when the worker is unreachable (fail open)', async () => {
    calls.length = 0;
    troubleNotice = 'claude-mem: the memory worker is unreachable.';
    workerFallback = true;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-context-fallback',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    expect(result.exitCode).toBe(0);
    expect(result.hookSpecificOutput?.additionalContext).toBe(
      'claude-mem: the memory worker is unreachable.'
    );
  });
});
