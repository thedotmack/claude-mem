import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { rmSync } from 'fs';
import path from 'path';

import { PRO_FALLBACK_NOTICE_MARKER } from '../../../src/shared/cmem-gateway.js';
import { paths } from '../../../src/shared/paths.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realOauthToken from '../../../src/shared/oauth-token.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
import * as runtimeSelector from '../../../src/services/hooks/runtime-selector.js';
import * as contextBuilder from '../../../src/services/context/ContextBuilder.js';
import { ServerClient } from '../../../src/services/hooks/server-client.js';

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
let contextProjects = 'current';
let excludedProjects = '';
let projectCatalog: string[] | 'reject' = ['other-project', 'repo-project', 'third-project'];
let showTerminalOutput = false;
let workerUnreachable = false;
let provider = 'claude';
let providerBySource = '';
let quotaFallbackProvider = '';
let proFallbackAt = '';
let openRouterBaseUrl = '';
let staleReason: string | null = null;
let workerContext = 'context from worker';
const outageNoticeRequests: Array<string | undefined> = [];

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: String(showTerminalOutput),
    CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: String(includeAllSources),
    CLAUDE_MEM_CONTEXT_PROJECTS: contextProjects,
    CLAUDE_MEM_EXCLUDED_PROJECTS: excludedProjects,
    CLAUDE_MEM_PROVIDER: provider,
    CLAUDE_MEM_PROVIDER_BY_SOURCE: providerBySource,
    CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: quotaFallbackProvider,
    CLAUDE_MEM_PRO_FALLBACK_AT: proFallbackAt,
    CLAUDE_MEM_OPENROUTER_BASE_URL: openRouterBaseUrl,
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
    if (args[0] === '/api/projects') {
      if (projectCatalog === 'reject') throw new Error('catalog unavailable');
      return { projects: projectCatalog };
    }
    return workerContext;
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
  providerBySource = '';
  quotaFallbackProvider = '';
  proFallbackAt = '';
  openRouterBaseUrl = '';
  staleReason = null;
  workerContext = 'context from worker';
});

describe('contextHandler SessionStart path', () => {
  it('reads only this checkout by default and every project, this checkout last, when CLAUDE_MEM_CONTEXT_PROJECTS is all', async () => {
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const injectUrl = () => String(calls.filter(call => String(call[0]).startsWith('/api/context/inject')).at(-1)?.[0]);
    const projectsOf = (url: string) => decodeURIComponent(new URL(url, 'http://x').searchParams.get('projects') ?? '');

    calls.length = 0;
    await contextHandler.execute({ sessionId: 'projects-current', cwd: '/tmp/repo', platform: 'claude-code' });
    expect(projectsOf(injectUrl())).toBe('parent-project,repo-project');
    expect(calls.some(call => call[0] === '/api/projects')).toBe(false);

    contextProjects = 'all';
    try {
      calls.length = 0;
      await contextHandler.execute({ sessionId: 'projects-all', cwd: '/tmp/repo', platform: 'claude-code' });
      expect(projectsOf(injectUrl())).toBe('other-project,third-project,parent-project,repo-project');
    } finally { contextProjects = 'current'; }
  });
  describe('CLAUDE_MEM_CONTEXT_PROJECTS=all', () => {
    const injectedProjects = () => {
      const url = String(calls.filter(call => String(call[0]).startsWith('/api/context/inject')).at(-1)?.[0]);
      return decodeURIComponent(new URL(url, 'http://x').searchParams.get('projects') ?? '');
    };
    const runAll = async (sessionId: string) => {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      calls.length = 0;
      return contextHandler.execute({ sessionId, cwd: '/tmp/repo', platform: 'claude-code' });
    };
    beforeEach(() => { contextProjects = 'all'; });
    afterAll(() => {
      contextProjects = 'current';
      excludedProjects = '';
      projectCatalog = ['other-project', 'repo-project', 'third-project'];
    });

    it('asks the catalog with a bounded timeout and falls back to this checkout when it rejects', async () => {
      projectCatalog = 'reject';
      await runAll('catalog-rejects');
      expect(injectedProjects()).toBe('parent-project,repo-project');
      const catalogCall = calls.find(call => call[0] === '/api/projects');
      expect(catalogCall?.[3]).toMatchObject({ timeoutMs: 2_000 });
    });

    it('keeps the projects param stable whatever order the catalog returns', async () => {
      projectCatalog = ['zeta', 'alpha'];
      await runAll('catalog-order-1');
      const first = injectedProjects();
      projectCatalog = ['alpha', 'zeta'];
      await runAll('catalog-order-2');
      expect(injectedProjects()).toBe(first);
      expect(first).toBe('alpha,zeta,parent-project,repo-project');
    });

    it('drops catalog projects matched by CLAUDE_MEM_EXCLUDED_PROJECTS', async () => {
      projectCatalog = ['alpha', 'secret-client', 'zeta'];
      excludedProjects = 'secret-*';
      try {
        await runAll('catalog-excluded');
        expect(injectedProjects()).toBe('alpha,zeta,parent-project,repo-project');
      } finally { excludedProjects = ''; }
    });

    it('does not ask the local catalog in server runtime', async () => {
      const { resolveSessionStartProjects } = await import('../../../src/cli/handlers/context.js');
      calls.length = 0;
      const projects = await resolveSessionStartProjects(
        { CLAUDE_MEM_CONTEXT_PROJECTS: 'all', CLAUDE_MEM_EXCLUDED_PROJECTS: '' },
        ['parent-project', 'repo-project'],
        'server',
      );
      expect(projects).toEqual(['parent-project', 'repo-project']);
      expect(calls.some(call => call[0] === '/api/projects')).toBe(false);
    });
  });
  it('explicitly omits an oversized old-worker body without cutting its records', async () => {
    staleReason = 'expired keychain entry';
    workerContext = 'recent observation\n'.repeat(600).slice(0, 10_000);
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute({ sessionId: 'full-context', cwd: '/tmp/repo', platform: 'codex' });
    const output = result.hookSpecificOutput!.additionalContext!;
    expect(output.length).toBeLessThanOrEqual(10_000);
    expect(output).toContain('claude auth login');
    expect(output).toContain('Recent context omitted');
    const url = new URL(String(calls.at(-1)![0]), 'http://worker');
    expect(Number(url.searchParams.get('reserveChars'))).toBeGreaterThan(0);
    expect(output).not.toContain('save_memory tool is available');
  });

  it('bounds an oversized stale reason without losing its login remedy', async () => {
    staleReason = 'expired '.repeat(2_000);
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute({ sessionId: 'long-stale-reason', cwd: '/tmp/repo', platform: 'codex' });
    expect(result.hookSpecificOutput!.additionalContext!.length).toBeLessThanOrEqual(10_000);
    expect(result.hookSpecificOutput!.additionalContext).toContain('claude auth login');
  });

  it('keeps the gateway notice when the body fills the budget', async () => {
    const marker = path.join(paths.dataDir(), PRO_FALLBACK_NOTICE_MARKER);
    rmSync(marker, { force: true });
    providerBySource = '{"codex":"openrouter"}';
    openRouterBaseUrl = 'https://cmem.ai/api/inference/v1';
    proFallbackAt = new Date().toISOString();
    staleReason = 'expired keychain entry';
    workerContext = 'recent observation\n'.repeat(600).slice(0, 10_000);
    try {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({ sessionId: 'full-context-fallback', cwd: '/tmp/repo', platform: 'codex' });
      const output = result.hookSpecificOutput!.additionalContext!;
      expect(output.length).toBeLessThanOrEqual(10_000);
      expect(output).toContain('Memory is using your Anthropic plan for now.');
      expect(output).toContain('claude auth login');
    } finally { rmSync(marker, { force: true }); }
  });

  it('preserves exact fits and fits TeamBrain after accounting for every separator', async () => {
    const { composeSessionStartContext } = await import('../../../src/cli/handlers/context.js');
    // The timeline body comes last, so later updates can append rows to it.
    expect(composeSessionStartContext('body', 'notice', 'team', 18))
      .toBe('notice\n\nteam\n\nbody');
    const body = Array.from({ length: 200 }, () => 'row').join('\n');
    const output = composeSessionStartContext(body, 'notice', 'brief '.repeat(300), 1_000);
    expect(output.length).toBeLessThanOrEqual(1_000);
    expect(output.startsWith('notice\n\n')).toBe(true);
    expect(output).toContain('TeamBrain brief left out');
    expect(output.endsWith(body)).toBe(true);
    expect(composeSessionStartContext('x'.repeat(1_100), 'notice', '', 1_000))
      .toContain('Recent context omitted');
  });

  it('preserves complete records and code fences when they fit, and never cuts them when they do not', async () => {
    const { composeSessionStartContext } = await import('../../../src/cli/handlers/context.js');
    const body = '# old\n# newest\n```js\nconst emoji = "😀";\n```';
    expect(composeSessionStartContext(body, 'notice', '', 200))
      .toBe('notice\n\n' + body);
    const omitted = composeSessionStartContext(body.repeat(100), 'notice', '', 200);
    expect(omitted).toContain('Recent context omitted');
    expect(omitted).not.toContain('```');
    expect(omitted).not.toContain('# old');
    expect(omitted.startsWith('notice\n\n')).toBe(true);
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

  it('re-injects context after Devin compaction and names PostCompaction in the reply', async () => {
    calls.length = 0;
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const result = await contextHandler.execute({
      sessionId: 'session-devin-compaction',
      cwd: '/tmp/repo',
      platform: 'devin',
      hookEventName: 'PostCompaction',
    });

    expect(result.hookSpecificOutput).toMatchObject({ hookEventName: 'PostCompaction', additionalContext: 'context from worker' });
    const startup = await contextHandler.execute({ sessionId: 'session-devin-startup', cwd: '/tmp/repo', platform: 'devin', hookEventName: 'SessionStart' });
    expect(startup.hookSpecificOutput?.hookEventName).toBe('SessionStart');
  });

  const loginHintCases: Array<{
    name: string; provider: string; quotaFallback?: string; bySource?: string;
    baseUrl?: string; fallbackAt?: boolean; expectHint: boolean;
  }> = [
    ...['codex', 'openai-compatible', 'openrouter', 'gemini'].map(provider => ({
      name: `${provider} with fallback off`, provider, quotaFallback: 'off', expectHint: false,
    })),
    ...['claude', ''].map(provider => ({ name: provider || 'default', provider, expectHint: true })),
    { name: 'default fallback', provider: 'gemini', quotaFallback: '', expectHint: true },
    { name: 'Claude fallback', provider: 'codex', quotaFallback: ' claude ', expectHint: true },
    { name: 'gateway fallback', provider: 'openrouter', baseUrl: 'https://cmem.ai/api/gateway', fallbackAt: true, expectHint: true },
    { name: 'source mapped to Claude', provider: 'codex', quotaFallback: 'gemini', bySource: '{"claude":"claude"}', expectHint: true },
    { name: 'source mapped elsewhere', provider: 'codex', quotaFallback: 'gemini', bySource: '{"cursor":"gemini"}', expectHint: false },
    { name: 'malformed source map', provider: 'codex', quotaFallback: 'gemini', bySource: '{"claude":"nope"}', expectHint: false },
  ];

  for (const row of loginHintCases) {
    it(`shows the Claude login hint exactly when needed: ${row.name}`, async () => {
      provider = row.provider;
      quotaFallbackProvider = row.quotaFallback ?? '';
      providerBySource = row.bySource ?? '';
      openRouterBaseUrl = row.baseUrl ?? '';
      proFallbackAt = row.fallbackAt ? new Date().toISOString() : '';
      staleReason = 'expired keychain entry';
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({ sessionId: `login-hint-${row.name}`, cwd: '/tmp/repo', platform: 'codex' });
      const output = result.hookSpecificOutput?.additionalContext;
      if (row.expectHint) {
        expect(output).toContain('Claude Code OAuth token is stale');
        expect(output).toContain('claude auth login');
      } else {
        expect(output).not.toContain('claude auth login');
        if (!row.bySource) expect(output).toBe('context from worker');
      }
    });
  }

  describe('cmem fallback notice with a source mapped to the gateway', () => {
    const noticeMarker = path.join(paths.dataDir(), PRO_FALLBACK_NOTICE_MARKER);

    beforeEach(() => rmSync(noticeMarker, { force: true }));
    afterEach(() => rmSync(noticeMarker, { force: true }));

    it('tells the user once that memory moved to the Anthropic plan', async () => {
      provider = 'claude';
      providerBySource = '{"codex":"openrouter"}';
      openRouterBaseUrl = 'https://cmem.ai/api/inference/v1';
      proFallbackAt = new Date().toISOString();
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');

      const first = await contextHandler.execute({ sessionId: 'session-mapped-gateway', cwd: '/tmp/repo', platform: 'codex' });
      expect(first.hookSpecificOutput?.additionalContext).toContain('Memory is using your Anthropic plan for now.');

      const second = await contextHandler.execute({ sessionId: 'session-mapped-gateway-2', cwd: '/tmp/repo', platform: 'codex' });
      expect(second.hookSpecificOutput?.additionalContext).not.toContain('Memory is using your Anthropic plan');
    });

    it('delivers the gateway notice only once across concurrent session starts', async () => {
      provider = 'claude';
      providerBySource = '{"codex":"openrouter"}';
      openRouterBaseUrl = 'https://cmem.ai/api/inference/v1';
      proFallbackAt = new Date().toISOString();
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        contextHandler.execute({ sessionId: 'notice-concurrent-' + i, cwd: '/tmp/repo', platform: 'codex' })));
      expect(results.filter(result => result.hookSpecificOutput?.additionalContext?.includes('Memory is using your Anthropic plan'))).toHaveLength(1);
      expect(results.every(result => result.hookSpecificOutput?.additionalContext?.includes('context from worker'))).toBe(true);
    });

    it('does not consume the fallback notice when the worker is unavailable', async () => {
      provider = 'claude';
      providerBySource = '{"codex":"openrouter"}';
      openRouterBaseUrl = 'https://cmem.ai/api/inference/v1';
      proFallbackAt = new Date().toISOString();
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      workerUnreachable = true;
      try {
        const failed = await contextHandler.execute({ sessionId: 'notice-outage', cwd: '/tmp/repo', platform: 'codex' });
        expect(failed.hookSpecificOutput?.additionalContext).not.toContain('Memory is using your Anthropic plan');
      } finally { workerUnreachable = false; }
      const retry = await contextHandler.execute({ sessionId: 'notice-retry', cwd: '/tmp/repo', platform: 'codex' });
      expect(retry.hookSpecificOutput?.additionalContext).toContain('Memory is using your Anthropic plan for now.');
      const next = await contextHandler.execute({ sessionId: 'notice-next', cwd: '/tmp/repo', platform: 'codex' });
      expect(next.hookSpecificOutput?.additionalContext).not.toContain('Memory is using your Anthropic plan');
    });

    it('stays silent for a source mapped to OpenRouter on a personal key', async () => {
      provider = 'claude';
      providerBySource = '{"codex":"openrouter"}';
      openRouterBaseUrl = 'https://openrouter.ai/api/v1';
      proFallbackAt = new Date().toISOString();
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');

      const result = await contextHandler.execute({ sessionId: 'session-mapped-personal', cwd: '/tmp/repo', platform: 'codex' });
      expect(result.hookSpecificOutput?.additionalContext).not.toContain('Memory is using your Anthropic plan');
    });
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

  it('passes the Codex host budget to the server context renderer', async () => {
    const runtime = {
      runtime: 'server' as const,
      projectId: 'server-project',
      serverBaseUrl: 'http://127.0.0.1:0',
      client: new ServerClient({ serverBaseUrl: 'http://127.0.0.1:0', apiKey: 'test-key' }),
    };
    const runtimeSpy = spyOn(runtimeSelector, 'resolveRuntimeContext').mockReturnValue(runtime);
    const renderSpy = spyOn(contextBuilder, 'generateServerSessionStartContext').mockResolvedValue({ model: '', terminal: null });
    calls.length = 0;
    try {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({ sessionId: 'codex-server-budget', cwd: process.cwd(), platform: 'codex' });
      expect(renderSpy).toHaveBeenCalledTimes(1);
      expect(renderSpy.mock.calls[0][0]).toBe(runtime);
      expect(renderSpy.mock.calls[0][2]).toEqual({ withTerminalRender: false, timeoutMs: 15_000 });
      expect(calls).toEqual([]);
      expect(result.hookSpecificOutput).toEqual({ hookEventName: 'SessionStart', additionalContext: '' });
    } finally {
      renderSpy.mockRestore();
      runtimeSpy.mockRestore();
    }
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
