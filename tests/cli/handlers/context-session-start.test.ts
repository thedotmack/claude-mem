import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { PRO_FALLBACK_NOTICE_MARKER } from '../../../src/shared/cmem-gateway.js';
import {
  SESSION_START_CARD_REQUEST_WAIT_MS,
  sessionStartCardRequestPath,
  sessionStartCardSlotClockOf,
  sessionStartCardSlotPath,
} from '../../../src/shared/session-start-card-slot.js';
import { TEAMBRAIN_DISCOVERY_LINE, TEAMBRAIN_DISCOVERY_NOTICE_MARKER } from '../../../src/shared/teambrain.js';
import { paths } from '../../../src/shared/paths.js';
import {
  contextCacheKeys,
  removeContextCache,
  writeContextCache,
} from '../../../src/shared/context-cache.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realOauthToken from '../../../src/shared/oauth-token.js';
import * as realProjectName from '../../../src/utils/project-name.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';
import * as realSetupState from '../../../src/shared/setup-state.js';
import type { SetupStateFile } from '../../../src/shared/setup-state.js';
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
const realSetupStateSnapshot = { ...realSetupState };

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
/** What the worker gives the model, when it differs from the terminal render (the `colors=true` request); null when the same. */
let workerModelContext: string | null = null;
const outageNoticeRequests: Array<string | undefined> = [];
let setupState: SetupStateFile = { ...realSetupState.INITIAL_SETUP_STATE };

mock.module('../../../src/shared/setup-state.js', () => ({
  ...realSetupStateSnapshot,
  readSetupState: () => setupState,
}));

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
    const isTerminalRender = typeof args[0] === 'string' && args[0].includes('colors=true');
    return workerModelContext !== null && !isTerminalRender ? workerModelContext : workerContext;
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
  mock.module('../../../src/shared/setup-state.js', () => realSetupStateSnapshot);
});

beforeEach(() => {
  provider = 'claude';
  providerBySource = '';
  quotaFallbackProvider = '';
  proFallbackAt = '';
  openRouterBaseUrl = '';
  staleReason = null;
  workerContext = 'context from worker';
  workerModelContext = null;
  setupState = { ...realSetupStateSnapshot.INITIAL_SETUP_STATE };
});

describe('contextHandler SessionStart path', () => {
  const pendingInstall = (): SetupStateFile => ({
    ...realSetupStateSnapshot.INITIAL_SETUP_STATE,
    install: {
      status: 'waiting', selection: null, error: null,
      catalog: {
        agents: [], skills: [], reinstall: false,
        defaults: { agents: [], skills: [], installClaudeCode: false, disableAutoMemory: false, telemetryEnabled: false },
      },
    },
  });

  it('brings an explicitly deferred install to the human on first use without selecting defaults', async () => {
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    setupState = pendingInstall();
    const result = await contextHandler.execute({ sessionId: 'pending-onboarding', cwd: '/tmp/repo', platform: 'claude-code' });
    expect(result.hookSpecificOutput?.additionalContext).toContain('Setup is waiting for your choices:');
    expect(result.hookSpecificOutput?.additionalContext).toContain('?setup=1');
    expect(result.hookSpecificOutput?.additionalContext).toContain('Otherwise leave setup pending');
    expect(result.systemMessage).toContain('Do not choose agents, integrations, skills, or account options on their behalf.');
  });

  it('does not push existing installs or completed onboarding back through setup', async () => {
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    const oldInstall = await contextHandler.execute({ sessionId: 'old-install', cwd: '/tmp/repo', platform: 'claude-code' });
    expect(oldInstall.hookSpecificOutput?.additionalContext).not.toContain('Setup is waiting');
    setupState = { ...pendingInstall(), status: 'complete' };
    const completed = await contextHandler.execute({ sessionId: 'completed-onboarding', cwd: '/tmp/repo', platform: 'claude-code' });
    expect(completed.hookSpecificOutput?.additionalContext).not.toContain('Setup is waiting');
  });

  it('keeps the deferred onboarding link visible even when the worker cannot return context', async () => {
    const { contextHandler } = await import('../../../src/cli/handlers/context.js');
    setupState = pendingInstall();
    workerUnreachable = true;
    try {
      const result = await contextHandler.execute({ sessionId: 'pending-worker-down', cwd: '/tmp/repo', platform: 'claude-code' });
      expect(result.hookSpecificOutput?.additionalContext).toContain('?setup=1');
      expect(result.systemMessage).toContain('Setup is waiting for your choices:');
      expect(result.systemMessage).toContain('worker unreachable');
    } finally { workerUnreachable = false; }
  });

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

    it('serves cached all-project context when the catalog becomes unavailable', async () => {
      const cachedBody = 'CACHED ALL-PROJECT CONTEXT';
      const cacheKeys = contextCacheKeys(['cached-project', 'parent-project', 'repo-project'], 'claude', false);
      const priorCatalog = projectCatalog;
      writeContextCache(cacheKeys, cachedBody, Date.now());
      try {
        projectCatalog = ['cached-project'];
        const online = await runAll('catalog-cache-online');
        expect(online.hookSpecificOutput?.additionalContext).toContain(cachedBody);

        projectCatalog = 'reject';
        workerContext = '';
        const offline = await runAll('catalog-cache-offline');
        expect(offline.hookSpecificOutput?.additionalContext).toContain(cachedBody);
        expect(calls.some(call => String(call[0]).startsWith('/api/context/inject'))).toBe(false);

        excludedProjects = 'cached-project';
        const afterExclusion = await runAll('catalog-cache-after-exclusion');
        expect(afterExclusion.hookSpecificOutput?.additionalContext).not.toContain(cachedBody);
        expect(injectedProjects()).toBe('parent-project,repo-project');
      } finally {
        excludedProjects = '';
        projectCatalog = priorCatalog;
        removeContextCache(cacheKeys);
      }
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
      expect(projects.live).toEqual(['parent-project', 'repo-project']);
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

  describe('session-start card (the hooks module named a file for the banner)', () => {
    const timeline = '\x1b[2mAccess Claude-Mem Rules + Tools: ~/.claude-mem/RULES-AND-TOOLS.md\x1b[0m\n\n'
      + '  \x1b[2m#101\x1b[0m  11:55a  first row\n  \x1b[2m#102\x1b[0m          newest row';
    const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
    let pluginDataDirectory: string;
    const slotFileOf = (sessionId: string) => sessionStartCardSlotPath(pluginDataDirectory, sessionId, 1794888786050);
    const start = async (sessionId: string, sessionStartCardFile?: string) => {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      return contextHandler.execute({ sessionId, cwd: '/tmp/repo', platform: 'claude-code', sessionSource: 'startup', sessionStartCardFile });
    };

    beforeEach(async () => {
      pluginDataDirectory = mkdtempSync(path.join(tmpdir(), 'session-start-card-context-'));
      process.env.CLAUDE_PLUGIN_DATA = pluginDataDirectory;
      showTerminalOutput = true;
      workerContext = timeline;
      // Once-only lines (the TeamBrain discovery line, the telemetry notice) are used up here.
      await start('card-prime');
    });
    afterEach(() => {
      rmSync(pluginDataDirectory, { recursive: true, force: true });
      if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
      showTerminalOutput = false;
    });

    it('writes the banner to the file and sends one line: the closing line with the rows the card shows', async () => {
      const whole = await start('card-off');
      const slotFile = slotFileOf('card-on');
      const result = await start('card-on', slotFile);

      expect(result.systemMessage).toMatch(/^View Observations Live @ \S+ · 2 lines$/);
      const { text } = JSON.parse(readFileSync(slotFile, 'utf-8')) as { text: string };
      expect(text.endsWith(timeline)).toBe(true);
      expect(text).not.toContain('View Observations Live');
      // Card and message together are the banner a session without the card gets.
      expect(`${text}\n\n${result.systemMessage}`).toBe(whole.systemMessage!);
      // The model's block is the same either way.
      expect(result.hookSpecificOutput).toEqual(whole.hookSpecificOutput);
    });

    it('keeps a notice in the message, above the closing line, and out of the card', async () => {
      setupState = pendingInstall();
      const slotFile = slotFileOf('card-notice');
      const result = await start('card-notice', slotFile);
      const lines = result.systemMessage!.split('\n');
      expect(lines[0]).toContain('Setup is waiting for your choices:');
      expect(lines.at(-2)).toBe('');
      expect(lines.at(-1)).toMatch(/^View Observations Live @ \S+ · 2 lines$/);
      expect(readFileSync(slotFile, 'utf-8')).not.toContain('Setup is waiting');
    });

    it('keeps the TeamBrain discovery line in the message and out of the card: it is marked shown now, and the card can still fail to draw', async () => {
      const discoveryMarker = path.join(paths.dataDir(), TEAMBRAIN_DISCOVERY_NOTICE_MARKER);
      rmSync(discoveryMarker, { force: true });
      const slotFile = slotFileOf('card-discovery');
      const result = await start('card-discovery', slotFile);
      expect(result.systemMessage!.split('\n')).toEqual([
        TEAMBRAIN_DISCOVERY_LINE,
        '',
        expect.stringMatching(/^View Observations Live @ \S+ · 2 lines$/),
      ]);
      expect(readFileSync(slotFile, 'utf-8')).not.toContain(TEAMBRAIN_DISCOVERY_LINE);
      expect(existsSync(discoveryMarker)).toBe(true);
    });

    it('sends the whole banner when the file is refused or cannot be written', async () => {
      const whole = await start('card-off');
      const anotherSessionsFile = slotFileOf('someone-else');
      expect((await start('card-refused', anotherSessionsFile)).systemMessage).toBe(whole.systemMessage!);
      expect(existsSync(anotherSessionsFile)).toBe(false);

      delete process.env.CLAUDE_PLUGIN_DATA;
      const slotFile = slotFileOf('card-no-data-folder');
      expect((await start('card-no-data-folder', slotFile)).systemMessage).toBe(whole.systemMessage!);
      expect(existsSync(slotFile)).toBe(false);
    });

    it('writes no file when there is no banner to draw', async () => {
      showTerminalOutput = false;
      const slotFile = slotFileOf('card-banner-off');
      const result = await start('card-banner-off', slotFile);
      expect(result.systemMessage).toBeUndefined();
      expect(existsSync(slotFile)).toBe(false);

      showTerminalOutput = true;
      workerUnreachable = true;
      try {
        const outage = await start('card-worker-down', slotFileOf('card-worker-down'));
        expect(outage.systemMessage).toBe('claude-mem worker unreachable for 3 consecutive hooks');
        expect(existsSync(slotFileOf('card-worker-down'))).toBe(false);
      } finally { workerUnreachable = false; }
    });

    it('writes no file and sends the whole banner when the model gets no context: Claude Code then keeps no row the card waits for', async () => {
      const whole = await start('card-off');
      workerModelContext = '';
      const slotFile = slotFileOf('card-no-model-context');
      const result = await start('card-no-model-context', slotFile);
      expect(result.hookSpecificOutput?.additionalContext).toBe('');
      expect(result.systemMessage).toBe(whole.systemMessage!);
      expect(existsSync(slotFile)).toBe(false);
    });

    it('leaves a session without the card exactly as it was', async () => {
      const result = await start('card-off');
      expect(result.systemMessage).toContain(timeline);
      expect(result.systemMessage).toMatch(/\n\nView Observations Live @ \S+ · 2 lines$/);
      expect(existsSync(path.join(pluginDataDirectory, 'session-start-card'))).toBe(false);
    });
  });

  // A Team or Enterprise account (#6314): the organization's plugin sends the
  // SessionStart event past the hooks module, so the event names no file. The
  // card asked with a request file when the Claude Code process started.
  describe('session-start card (the event names no file, and the card asked with a request file)', () => {
    const timeline = '\x1b[2mAccess Claude-Mem Rules + Tools: ~/.claude-mem/RULES-AND-TOOLS.md\x1b[0m\n\n'
      + '  \x1b[2m#101\x1b[0m  11:55a  first row\n  \x1b[2m#102\x1b[0m          newest row';
    const savedPluginData = process.env.CLAUDE_PLUGIN_DATA;
    const savedEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
    let pluginDataDirectory: string;
    let slotFolder: string;
    const start = async (sessionId: string, sessionSource: 'startup' | 'clear' | 'compact' = 'startup', sessionStartCardFile?: string) => {
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      return contextHandler.execute({ sessionId, cwd: '/tmp/repo', platform: 'claude-code', sessionSource, sessionStartCardFile });
    };
    /** The request as the card writes it when the process starts. */
    const cardAsks = (sessionId: string, askedAtEpochMs: number = Date.now()) => {
      mkdirSync(slotFolder, { recursive: true });
      writeFileSync(sessionStartCardRequestPath(pluginDataDirectory, sessionId, askedAtEpochMs), '');
      return askedAtEpochMs;
    };
    const slotsOf = (sessionId: string) => (existsSync(slotFolder) ? readdirSync(slotFolder) : [])
      .filter(fileName => sessionStartCardSlotClockOf(fileName, sessionId) !== null);
    const allSlots = () => (existsSync(slotFolder) ? readdirSync(slotFolder) : []).filter(fileName => fileName.endsWith('.json'));
    /** The hook's limit on its wait for a request, read where the handler reads it. */
    const hookWaitMs = async () =>
      (await import('../../../src/cli/session-start-card-slot-writer.js')).SESSION_START_CARD_REQUEST_HOOK_WAIT_MS;

    beforeEach(async () => {
      pluginDataDirectory = mkdtempSync(path.join(tmpdir(), 'session-start-card-request-context-'));
      slotFolder = path.join(pluginDataDirectory, 'session-start-card');
      process.env.CLAUDE_PLUGIN_DATA = pluginDataDirectory;
      process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
      showTerminalOutput = true;
      workerContext = timeline;
      // Once-only lines (the TeamBrain discovery line, the telemetry notice) are used up here.
      await start('request-prime');
    });
    afterEach(() => {
      rmSync(pluginDataDirectory, { recursive: true, force: true });
      if (savedPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = savedPluginData;
      if (savedEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = savedEntrypoint;
      showTerminalOutput = false;
    });

    it('names the slot itself, writes the banner there and sends one line', async () => {
      const whole = await start('request-off');
      const askedAt = cardAsks('request-on');
      const result = await start('request-on');

      expect(result.systemMessage).toMatch(/^View Observations Live @ \S+ · 2 lines$/);
      const [slotFileName, ...others] = slotsOf('request-on');
      expect(others).toEqual([]);
      // Named by the hook's clock, at or after the request: the card takes no earlier slot for its answer.
      expect(sessionStartCardSlotClockOf(slotFileName, 'request-on')).toBeGreaterThanOrEqual(askedAt);
      const { text } = JSON.parse(readFileSync(path.join(slotFolder, slotFileName), 'utf-8')) as { text: string };
      // Card and message together are the banner a session without the card gets.
      expect(`${text}\n\n${result.systemMessage}`).toBe(whole.systemMessage!);
      expect(result.hookSpecificOutput).toEqual(whole.hookSpecificOutput);
    });

    // The order measured on a Team account: the card writes its request while the hook runs, and in 3 of
    // 8 starts the hook listed the slot folder first (by 5, 21 and 86 ms).
    it('waits for a request the card writes after the hook has listed the folder, and sends one line', async () => {
      const whole = await start('request-off');
      // An earlier session's request: a card has asked from this plugin data folder before.
      cardAsks('an-earlier-session', Date.now() - 60_000);

      const startedAt = Date.now();
      const requestIsLateByMs = 86;
      let askedAt = 0;
      const cardWritesLate = setTimeout(() => { askedAt = cardAsks('request-late'); }, requestIsLateByMs);
      const result = await start('request-late');
      clearTimeout(cardWritesLate);

      // The hook was waiting when the request came: it returned after it, and within its limit.
      expect(askedAt).toBeGreaterThanOrEqual(startedAt);
      expect(Date.now() - startedAt).toBeLessThan(await hookWaitMs());
      expect(result.systemMessage).toMatch(/^View Observations Live @ \S+ · 2 lines$/);
      const [slotFileName, ...others] = slotsOf('request-late');
      expect(others).toEqual([]);
      // The card's look takes this slot: it is named at or after the request.
      expect(sessionStartCardSlotClockOf(slotFileName, 'request-late')).toBeGreaterThanOrEqual(askedAt);
      const { text } = JSON.parse(readFileSync(path.join(slotFolder, slotFileName), 'utf-8')) as { text: string };
      expect(`${text}\n\n${result.systemMessage}`).toBe(whole.systemMessage!);
    });

    it('keeps the whole banner as the hook message unless a card of this start asked for it', async () => {
      const whole = await start('request-off');
      // The control: a request that stands is answered with one line.
      cardAsks('request-control');
      expect((await start('request-control')).systemMessage).not.toBe(whole.systemMessage!);
      expect(slotsOf('request-control')).toHaveLength(1);

      // No request of this session. A card asked from this folder before (the control's), so the hook waits
      // its limit for one, and then sends the whole banner: nothing would draw a slot.
      const waitStartedAt = Date.now();
      expect((await start('request-none')).systemMessage).toBe(whole.systemMessage!);
      // Nine tenths of the limit: a timer may fire a fraction of a millisecond early.
      expect(Date.now() - waitStartedAt).toBeGreaterThanOrEqual((await hookWaitMs()) * 0.9);
      // Another session's request.
      cardAsks('request-of-another-session');
      expect((await start('request-not-mine')).systemMessage).toBe(whole.systemMessage!);
      // A request that has run out: the card has stopped looking.
      cardAsks('request-run-out', Date.now() - SESSION_START_CARD_REQUEST_WAIT_MS);
      expect((await start('request-run-out')).systemMessage).toBe(whole.systemMessage!);
      // A /clear and a compaction: session.start does not come with them, so no card looks for their banner.
      cardAsks('request-clear');
      expect((await start('request-clear', 'clear')).systemMessage).toBe(whole.systemMessage!);
      cardAsks('request-compact');
      expect((await start('request-compact', 'compact')).systemMessage).toBe(whole.systemMessage!);
      // Not the terminal's own screen.
      cardAsks('request-print-mode');
      process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
      expect((await start('request-print-mode')).systemMessage).toBe(whole.systemMessage!);

      expect(allSlots()).toEqual(slotsOf('request-control'));
    });

    it('writes only the file the event names when the SessionStart hook did run: one start, one slot', async () => {
      // The control: a request alone is answered with a slot the hook names.
      cardAsks('request-control');
      await start('request-control');
      expect(slotsOf('request-control')).toHaveLength(1);

      cardAsks('request-and-named');
      const namedSlotFile = sessionStartCardSlotPath(pluginDataDirectory, 'request-and-named', 1794888786050);
      const result = await start('request-and-named', 'startup', namedSlotFile);
      expect(result.systemMessage).toMatch(/^View Observations Live @ \S+ · 2 lines$/);
      expect(slotsOf('request-and-named')).toEqual([path.basename(namedSlotFile)]);
    });

    it('answers no request when there is no banner to draw', async () => {
      // The control: with a banner, this request is answered.
      cardAsks('request-control');
      await start('request-control');
      expect(slotsOf('request-control')).toHaveLength(1);

      showTerminalOutput = false;
      cardAsks('request-banner-off');
      expect((await start('request-banner-off')).systemMessage).toBeUndefined();
      expect(slotsOf('request-banner-off')).toEqual([]);
    });
  });

  describe('context cache reserve (#5672)', () => {
    const fallbackMarker = path.join(paths.dataDir(), PRO_FALLBACK_NOTICE_MARKER);
    const cacheKeys = () => contextCacheKeys(['parent-project', 'repo-project'], 'claude', false);
    const seedCache = (body: string) => writeContextCache(cacheKeys(), body, Date.now());
    const clearCache = () => removeContextCache(cacheKeys());

    beforeEach(() => {
      rmSync(fallbackMarker, { force: true });
      clearCache();
    });
    afterEach(() => {
      rmSync(fallbackMarker, { force: true });
      clearCache();
    });

    it('shares one room definition between the cache read and the compose step', async () => {
      const { sessionStartBodyRoom } = await import('../../../src/cli/handlers/context.js');
      expect(sessionStartBodyRoom('', 1_000)).toBe(1_000);
      expect(sessionStartBodyRoom('notice', 1_000)).toBe(992);
      expect(sessionStartBodyRoom('x'.repeat(999), 1_000)).toBe(0);
    });

    it('treats a cached body over the reserve-adjusted room as a miss and fetches live', async () => {
      staleReason = 'x'.repeat(2_000);
      proFallbackAt = new Date().toISOString();
      workerContext = 'LIVE BODY FROM WORKER';
      // Rendered for the full budget, over the room the notices leave (about
      // 8.7k here) but under the raw 10k limit: exactly the body #5672 saw
      // served and then dropped.
      const cachedBody = 'CACHED BODY MARKER\n' + 'y'.repeat(9_342);
      expect(cachedBody.length).toBe(9_361);
      seedCache(cachedBody);
      calls.length = 0;
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({ sessionId: 'cache-over-room', cwd: '/tmp/repo', platform: 'claude-code' });
      const output = result.hookSpecificOutput!.additionalContext!;
      expect(output).toContain('LIVE BODY FROM WORKER');
      expect(output).not.toContain('CACHED BODY MARKER');
      expect(output).not.toContain('Recent context omitted');
      const injectUrl = new URL(String(calls.find(call => String(call[0]).startsWith('/api/context/inject'))?.[0]), 'http://worker');
      expect(Number(injectUrl.searchParams.get('reserveChars'))).toBeGreaterThan(0);
    });

    it('still serves a cached body that fits the reserve-adjusted room', async () => {
      staleReason = 'x'.repeat(2_000);
      proFallbackAt = new Date().toISOString();
      workerContext = 'LIVE BODY FROM WORKER';
      const cachedBody = 'CACHED BODY MARKER\n' + 'y'.repeat(4_981);
      expect(cachedBody.length).toBe(5_000);
      seedCache(cachedBody);
      calls.length = 0;
      const { contextHandler } = await import('../../../src/cli/handlers/context.js');
      const result = await contextHandler.execute({ sessionId: 'cache-fits-room', cwd: '/tmp/repo', platform: 'claude-code' });
      const output = result.hookSpecificOutput!.additionalContext!;
      expect(output).toContain('CACHED BODY MARKER');
      expect(output).not.toContain('LIVE BODY FROM WORKER');
      expect(calls).toEqual([]);
    });
  });
});
