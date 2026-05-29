import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as piAi from '@earendil-works/pi-ai';
import {
  expandOpenAICodexPath,
  getOpenAICodexSessionId,
  isOpenAICodexAvailable,
  isOpenAICodexSelected,
  classifyOpenAICodexError,
  OpenAICodexProvider
} from '../src/services/worker/OpenAICodexProvider';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager';
import { ModeManager } from '../src/services/domain/ModeManager';
import { getSelectedProviderId, SessionRoutes } from '../src/services/worker/http/routes/SessionRoutes';
import { ClassifiedProviderError, type ProviderErrorClass } from '../src/services/worker/provider-errors';
import type { ActiveSession } from '../src/services/worker-types';

let refreshOpenAICodexTokenMock = mock(async (token: string) => ({
  access: createFutureJwt(),
  refresh: token,
  expires: Date.now() + 60 * 60 * 1000,
}));

mock.module('@earendil-works/pi-ai/oauth', () => ({
  refreshOpenAICodexToken: (token: string) => refreshOpenAICodexTokenMock(token),
}));

describe('OpenAICodexProvider selection', () => {
  let tempDir: string;
  let originalCodexHome: string | undefined;
  let loadFromFileSpy: ReturnType<typeof spyOn>;
  let completeSimpleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    tempDir = join(tmpdir(), `openai-codex-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    process.env.CODEX_HOME = tempDir;
    refreshOpenAICodexTokenMock = mock(async (token: string) => ({
      access: createFutureJwt(),
      refresh: token,
      expires: Date.now() + 60 * 60 * 1000,
    }));
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    loadFromFileSpy?.mockRestore();
    completeSimpleSpy?.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects selected provider and a native Codex CLI auth.json profile', () => {
    writeFileSync(join(tempDir, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        account_id: 'account-id',
      },
      last_refresh: new Date().toISOString(),
    }));

    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'openai-codex',
    }));

    expect(isOpenAICodexSelected()).toBe(true);
    expect(isOpenAICodexAvailable()).toBe(true);
  });

  it('does not report available when Codex CLI auth is missing', () => {
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'openai-codex',
    }));

    expect(isOpenAICodexSelected()).toBe(true);
    expect(isOpenAICodexAvailable()).toBe(false);
  });

  it('keeps openai-codex selected even when OAuth is unavailable', () => {
    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'openai-codex',
    }));

    expect(isOpenAICodexAvailable()).toBe(false);
    expect(getSelectedProviderId()).toBe('openai-codex');
  });

  it('expands tilde paths', () => {
    const homeDir = join('/', 'home', 'tester');
    expect(expandOpenAICodexPath('~/agents/default', homeDir)).toBe(join(homeDir, 'agents', 'default'));
    expect(expandOpenAICodexPath('~', homeDir)).toBe(homeDir);
    expect(expandOpenAICodexPath('/tmp/agent', '/home/tester')).toBe('/tmp/agent');
  });

  it('uses a stable API-safe session id for OpenAI Codex prompt caching', () => {
    const longSessionId = 'openai-codex-019e2baa-25a7-7151-bcc4-5e3b195413cd-1778954766932';
    const cacheKey = getOpenAICodexSessionId(longSessionId);

    expect(cacheKey).toBe(getOpenAICodexSessionId(longSessionId));
    expect(cacheKey).toStartWith('claude-mem-');
    expect(cacheKey.length).toBeLessThanOrEqual(64);
    expect(cacheKey).not.toBe(longSessionId);
  });

  it('calls pi-ai with the configured OpenAI Codex model and Codex CLI OAuth token', async () => {
    const accessToken = createFutureJwt();
    const configuredModel = 'gpt-5.5';
    writeFileSync(join(tempDir, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-token',
        account_id: 'account-id',
      },
      last_refresh: new Date().toISOString(),
    }));

    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'openai-codex',
      CLAUDE_MEM_OPENAI_CODEX_MODEL: configuredModel,
    }));

    completeSimpleSpy = spyOn(piAi, 'completeSimple').mockResolvedValue({
      role: 'assistant',
      content: [],
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: configuredModel,
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    });

    ModeManager.getInstance().loadMode('code');

    const provider = new OpenAICodexProvider(fakeDbManager(), fakeSessionManager());
    await provider.startSession(createActiveSession());

    expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
    const [model, context, options] = completeSimpleSpy.mock.calls[0];
    expect(model.id).toBe(configuredModel);
    expect(model.provider).toBe('openai-codex');
    expect(context.messages[0].role).toBe('user');
    expect(options?.apiKey).toBe(accessToken);
    expect(options?.sessionId).toStartWith('claude-mem-');
  });

  it('uses a valid cached Codex CLI OAuth token if auth.json temporarily disappears', async () => {
    const accessToken = createFutureJwt();
    const configuredModel = 'gpt-5.4-mini';
    const authPath = join(tempDir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-token',
        account_id: 'account-id',
      },
      last_refresh: new Date().toISOString(),
    }));

    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'openai-codex',
      CLAUDE_MEM_OPENAI_CODEX_MODEL: configuredModel,
    }));

    completeSimpleSpy = spyOn(piAi, 'completeSimple').mockResolvedValue({
      role: 'assistant',
      content: [],
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: configuredModel,
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    });

    ModeManager.getInstance().loadMode('code');

    const provider = new OpenAICodexProvider(fakeDbManager(), fakeSessionManager());
    await provider.startSession(createActiveSession({ sessionDbId: 201, memorySessionId: 'cached-token-1' }));

    rmSync(authPath, { force: true });
    await provider.startSession(createActiveSession({ sessionDbId: 202, memorySessionId: 'cached-token-2' }));

    expect(completeSimpleSpy).toHaveBeenCalledTimes(2);
    expect(completeSimpleSpy.mock.calls[1][2]?.apiKey).toBe(accessToken);
  });

  it('keeps a refreshed OAuth token in memory when auth persistence fails', async () => {
    const expiredToken = createExpiredJwt();
    const refreshedAccessToken = createFutureJwt();
    const authPath = join(tempDir, 'auth.json');
    writeFileSync(authPath, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: expiredToken,
        refresh_token: 'refresh-token',
        account_id: 'account-id',
      },
      last_refresh: new Date().toISOString(),
    }));

    refreshOpenAICodexTokenMock = mock(async (token: string) => {
      rmSync(authPath, { force: true });
      mkdirSync(authPath);
      return {
        access: refreshedAccessToken,
        refresh: token,
        expires: Date.now() + 60 * 60 * 1000,
      };
    });

    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'openai-codex',
      CLAUDE_MEM_OPENAI_CODEX_MODEL: 'gpt-5.4-mini',
    }));

    completeSimpleSpy = spyOn(piAi, 'completeSimple').mockResolvedValue({
      role: 'assistant',
      content: [],
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: 'gpt-5.4-mini',
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    });

    ModeManager.getInstance().loadMode('code');

    const provider = new OpenAICodexProvider(fakeDbManager(), fakeSessionManager());
    await provider.startSession(createActiveSession({ sessionDbId: 301, memorySessionId: 'refreshed-token-1' }));
    await provider.startSession(createActiveSession({ sessionDbId: 302, memorySessionId: 'refreshed-token-2' }));

    expect(refreshOpenAICodexTokenMock).toHaveBeenCalledTimes(1);
    expect(completeSimpleSpy).toHaveBeenCalledTimes(2);
    expect(completeSimpleSpy.mock.calls[0][2]?.apiKey).toBe(refreshedAccessToken);
    expect(completeSimpleSpy.mock.calls[1][2]?.apiKey).toBe(refreshedAccessToken);
  });

  it('hard-stops SessionRoutes on non-retryable OpenAI Codex provider errors without falling back to Claude', async () => {
    for (const kind of ['auth_invalid', 'quota_exhausted', 'unrecoverable'] as ProviderErrorClass[]) {
      loadFromFileSpy?.mockRestore();
      loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
        ...SettingsDefaultsManager.getAllDefaults(),
        CLAUDE_MEM_PROVIDER: 'openai-codex',
        CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
      }));

      const sessionId = kind === 'auth_invalid' ? 101 : kind === 'quota_exhausted' ? 102 : 103;
      const session = createActiveSession({ sessionDbId: sessionId });
      const pendingStore = {
        getPendingCount: mock(() => 3),
        peekTypes: mock(() => []),
      };
      const sessionManager = {
        getSession: mock(() => session),
        getMessageBuffer: mock(() => pendingStore),
        removeSessionImmediate: mock(() => undefined),
      };
      const completionHandler = {
        finalizeSession: mock(async () => undefined),
      };
      const claudeAgent = {
        startSession: mock(async () => undefined),
      };
      const openAICodexAgent = {
        startSession: mock(async () => {
          throw new ClassifiedProviderError(`simulated ${kind}`, { kind, cause: new Error(kind) });
        }),
      };

      const routes = new SessionRoutes(
        sessionManager as any,
        fakeDbManager() as any,
        claudeAgent as any,
        { startSession: mock(async () => undefined) } as any,
        { startSession: mock(async () => undefined) } as any,
        openAICodexAgent as any,
        {} as any,
        {} as any,
        completionHandler as any,
      );

      await routes.ensureGeneratorRunning(session.sessionDbId, 'test');
      const generatorPromise = session.generatorPromise;
      expect(generatorPromise).toBeTruthy();
      await generatorPromise;

      expect(openAICodexAgent.startSession).toHaveBeenCalledTimes(1);
      expect(claudeAgent.startSession).not.toHaveBeenCalled();
      expect(pendingStore.getPendingCount).toHaveBeenCalledWith(session.sessionDbId);
      expect(completionHandler.finalizeSession).toHaveBeenCalledWith(session.sessionDbId);
      expect(sessionManager.removeSessionImmediate).toHaveBeenCalledWith(session.sessionDbId);
      expect(session.generatorPromise).toBeNull();
      expect(session.currentProvider).toBeNull();
    }
  });

  it('classifies unsupported OpenAI Codex models as unrecoverable', async () => {
    const accessToken = createFutureJwt();
    writeFileSync(join(tempDir, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-token',
        account_id: 'account-id',
      },
      last_refresh: new Date().toISOString(),
    }));

    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'openai-codex',
      CLAUDE_MEM_OPENAI_CODEX_MODEL: 'missing-codex-model',
    }));

    ModeManager.getInstance().loadMode('code');

    const provider = new OpenAICodexProvider(fakeDbManager(), fakeSessionManager());
    await expect(provider.startSession(createActiveSession())).rejects.toMatchObject({
      kind: 'unrecoverable',
    });
  });

  it('classifies thrown OpenAI Codex API errors before they reach session routing', async () => {
    const accessToken = createFutureJwt();
    writeFileSync(join(tempDir, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: accessToken,
        refresh_token: 'refresh-token',
        account_id: 'account-id',
      },
      last_refresh: new Date().toISOString(),
    }));

    loadFromFileSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_PROVIDER: 'openai-codex',
      CLAUDE_MEM_OPENAI_CODEX_MODEL: 'gpt-5.4-mini',
    }));

    const error = new Error('OAuth token expired') as Error & { status: number };
    error.status = 401;
    completeSimpleSpy = spyOn(piAi, 'completeSimple').mockRejectedValue(error);

    ModeManager.getInstance().loadMode('code');

    const provider = new OpenAICodexProvider(fakeDbManager(), fakeSessionManager());
    await expect(provider.startSession(createActiveSession())).rejects.toMatchObject({
      kind: 'auth_invalid',
    });
  });

  it('does not classify context-length token errors as OAuth failures', () => {
    const error = classifyOpenAICodexError({
      status: 400,
      bodyText: "This model's maximum context length is 128000 tokens.",
      cause: new Error('context length'),
    });

    expect(error.kind).toBe('unrecoverable');
  });
});

function createFutureJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function createExpiredJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600 })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createActiveSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId: 42,
    contentSessionId: 'content-session',
    memorySessionId: 'memory-session',
    project: 'test-project',
    platformSource: 'codex-cli',
    userPrompt: 'remember the important details',
    pendingMessages: [],
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    lastGeneratorActivity: Date.now(),
    ...overrides,
  };
}

function fakeDbManager() {
  return {
    getSessionStore: () => ({
      updateMemorySessionId: mock(() => undefined),
    }),
  } as any;
}

function fakeSessionManager() {
  return {
    async *getMessageIterator() {
      return;
    },
  } as any;
}
