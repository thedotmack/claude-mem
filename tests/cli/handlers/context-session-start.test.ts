import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

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
let includeAllSources = false;
let showTerminalOutput = false;
let workerUnreachable = false;
let provider = 'claude';
let quotaFallbackProvider = '';
let proFallbackAt = '';
let openRouterBaseUrl = '';
let staleReason: string | null = null;
let memoryInstructions: string | undefined = 'false';
const outageNoticeRequests: Array<string | undefined> = [];

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: String(showTerminalOutput),
    CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: String(includeAllSources),
    CLAUDE_MEM_PROVIDER: provider,
    CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: quotaFallbackProvider,
    CLAUDE_MEM_PRO_FALLBACK_AT: proFallbackAt,
    CLAUDE_MEM_OPENROUTER_BASE_URL: openRouterBaseUrl,
    CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED: memoryInstructions,
  }),
}));

mock.module('../../../src/shared/oauth-token.js', () => ({ readStaleMarker: () => staleReason }));

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
  isWorkerFallback: () => workerUnreachable,
  consumeWorkerOutageNotice: async (sessionId: string | undefined) => {
    outageNoticeRequests.push(sessionId);
    return 'claude-mem worker unreachable for 3 consecutive hooks';
  },
}));

afterAll(() => {
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/oauth-token.js', () => realOauthTokenSnapshot);
  mock.module('../../../src/utils/project-name.js', () => realProjectNameSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

beforeEach(() => {
  provider = 'claude';
  quotaFallbackProvider = '';
  proFallbackAt = '';
  openRouterBaseUrl = '';
  staleReason = null;
  memoryInstructions = 'false';
});

describe('contextHandler SessionStart path', () => {
  it('steers note-taking to available plugin tools by default and still injects instructions during a worker outage', async () => {
    memoryInstructions = undefined;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const input = { sessionId: 'memory-instructions', cwd: '/tmp/repo', platform: 'codex' };
    const result = await contextHandler.execute(input);
    expect(result.hookSpecificOutput?.additionalContext).toContain('context from worker');
    expect(result.hookSpecificOutput?.additionalContext).toContain('save_memory tool is available');
    expect(result.hookSpecificOutput?.additionalContext).toContain('concise purpose-specific text');
    expect(result.hookSpecificOutput?.additionalContext).toContain('internal metadata out of model context');
    expect(result.hookSpecificOutput?.additionalContext).toContain('hosted read-only connector');
    workerUnreachable = true;
    try {
      const fallback = await contextHandler.execute(input);
      expect(fallback.hookSpecificOutput?.additionalContext).toContain('save_memory tool is available');
    } finally { workerUnreachable = false; }
  });
  it('skips the model and terminal timeline on Claude resume before contacting the worker', async () => {
    calls.length = 0;
    outageNoticeRequests.length = 0;
    showTerminalOutput = true;
    workerUnreachable = true;
    staleReason = 'expired keychain entry';
    try {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({
        sessionId: 'session-resume-claude',
        cwd: '/tmp/repo',
        platform: 'claude-code',
        sessionSource: 'resume',
      });

      expect(result).toEqual({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
        exitCode: 0,
      });
      expect(calls).toEqual([]);
      expect(outageNoticeRequests).toEqual([]);
    } finally {
      showTerminalOutput = false;
      workerUnreachable = false;
    }
  });

  for (const sessionSource of ['startup', 'clear', 'compact'] as const) {
    it(`keeps model and terminal context on Claude ${sessionSource}`, async () => {
      calls.length = 0;
      showTerminalOutput = true;
      try {
        const { contextHandler } = await import('../../../src/cli/handlers/context.js');
        const result = await contextHandler.execute({
          sessionId: `session-${sessionSource}-claude`,
          cwd: '/tmp/repo',
          platform: 'claude-code',
          sessionSource,
        });

        expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
        expect(result.systemMessage).toContain('context from worker');
        expect(calls.map(call => call[0])).toEqual([
          '/api/context/inject?projects=parent-project%2Crepo-project&platformSource=claude&cwd=%2Ftmp%2Frepo',
          '/api/context/inject?projects=parent-project%2Crepo-project&platformSource=claude&cwd=%2Ftmp%2Frepo&colors=true',
        ]);
      } finally {
        showTerminalOutput = false;
      }
    });
  }

  it('keeps context injection for Codex resume', async () => {
    calls.length = 0;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute({
      sessionId: 'session-resume-codex',
      cwd: '/tmp/repo',
      platform: 'codex',
      sessionSource: 'resume',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    expect(calls).toHaveLength(1);
  });

  for (const memoryProvider of ['codex', 'openai-compatible', 'openrouter', 'gemini']) {
    it(`does not request Claude login when memory uses ${memoryProvider} without Claude fallback`, async () => {
      provider = memoryProvider;
      staleReason = 'expired keychain entry';
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({
        sessionId: `session-stale-${memoryProvider}`,
        cwd: '/tmp/repo',
        platform: 'codex',
      });
      expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    });
  }

  for (const memoryProvider of ['claude', '']) {
    it(`keeps the Claude login hint for ${memoryProvider || 'default'} memory`, async () => {
      provider = memoryProvider;
      staleReason = 'expired keychain entry';
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({
        sessionId: 'session-stale-claude',
        cwd: '/tmp/repo',
        platform: 'codex',
      });
      expect(result.hookSpecificOutput?.additionalContext).toContain('Claude Code OAuth token is stale');
      expect(result.hookSpecificOutput?.additionalContext).toContain('claude auth login');
    });
  }

  it('keeps the Claude login hint for a configured Claude quota fallback', async () => {
    provider = 'codex';
    quotaFallbackProvider = ' claude ';
    staleReason = 'expired keychain entry';
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute({
      sessionId: 'session-stale-claude-fallback',
      cwd: '/tmp/repo',
      platform: 'codex',
    });
    expect(result.hookSpecificOutput?.additionalContext).toContain('claude auth login');
  });

  it('keeps the Claude login hint while the primary cmem gateway falls back to Claude', async () => {
    provider = 'openrouter';
    openRouterBaseUrl = 'https://cmem.ai/api/gateway';
    proFallbackAt = new Date().toISOString();
    staleReason = 'expired keychain entry';
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute({
      sessionId: 'session-stale-cmem-fallback',
      cwd: '/tmp/repo',
      platform: 'codex',
    });
    expect(result.hookSpecificOutput?.additionalContext).toContain('claude auth login');
  });

  it('injects Codex context with one bounded worker startup and request', async () => {
    calls.length = 0;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    const result = await contextHandler.execute({
      sessionId: 'session-context',
      cwd: '/tmp/repo',
      platform: 'codex',
    });

    expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
    expect(calls).toEqual([[
      '/api/context/inject?projects=parent-project%2Crepo-project&platformSource=codex&cwd=%2Ftmp%2Frepo',
      'GET',
      undefined,
      { workerStartupTimeoutMs: 15_000, timeoutMs: 2_000 },
    ]]);
  });

  it('keeps the existing worker lifecycle behavior for Claude', async () => {
    calls.length = 0;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');

    await contextHandler.execute({
      sessionId: 'session-context-claude',
      cwd: '/tmp/repo',
      platform: 'claude-code',
    });

    expect(calls).toEqual([[
      '/api/context/inject?projects=parent-project%2Crepo-project&platformSource=claude&cwd=%2Ftmp%2Frepo',
      'GET',
      undefined,
      undefined,
    ]]);
  });

  it('includes every source in both Claude startup renders when opted in', async () => {
    calls.length = 0;
    includeAllSources = true;
    showTerminalOutput = true;
    try {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({
        sessionId: 'session-all-sources',
        cwd: '/tmp/repo',
        platform: 'claude-code',
      });

      expect(result.hookSpecificOutput?.additionalContext).toBe('context from worker');
      expect(result.systemMessage).toContain('context from worker');
      expect(calls.map(call => call[0])).toEqual([
        '/api/context/inject?projects=parent-project%2Crepo-project&cwd=%2Ftmp%2Frepo',
        '/api/context/inject?projects=parent-project%2Crepo-project&cwd=%2Ftmp%2Frepo&colors=true',
      ]);
    } finally {
      includeAllSources = false;
      showTerminalOutput = false;
    }
  });

  it('shows the worker-outage notice as systemMessage when SessionStart falls back', async () => {
    calls.length = 0;
    outageNoticeRequests.length = 0;
    workerUnreachable = true;
    try {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({
        sessionId: 'session-outage',
        cwd: '/tmp/repo',
        platform: 'claude-code',
      });

      expect(result.hookSpecificOutput?.additionalContext).toBe('');
      expect(result.systemMessage).toBe('claude-mem worker unreachable for 3 consecutive hooks');
      expect(outageNoticeRequests).toEqual(['session-outage']);
    } finally {
      workerUnreachable = false;
    }
  });

  it('includes every source in Codex startup context when opted in', async () => {
    calls.length = 0;
    includeAllSources = true;
    try {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      await contextHandler.execute({
        sessionId: 'session-all-sources-codex',
        cwd: '/tmp/repo',
        platform: 'codex',
      });

      expect(calls.map(call => call[0])).toEqual([
        '/api/context/inject?projects=parent-project%2Crepo-project&cwd=%2Ftmp%2Frepo',
      ]);
    } finally {
      includeAllSources = false;
    }
  });
});
