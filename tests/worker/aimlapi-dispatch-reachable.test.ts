import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { startGeneratorWithProvider } from '../../src/services/worker/session/GeneratorRunner.js';
import {
  getSelectedProvider,
  selectProviderForGenerator,
  resetQuotaFallbackStateForTesting,
  readQuotaFallbackProvider,
  QUOTA_FALLBACK_PROVIDERS,
} from '../../src/services/worker/provider-dispatch.js';
import { isAimlapiAvailable, isAimlapiSelected } from '../../src/services/worker/AimlapiProvider.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

/**
 * The aimlapi.com provider is REACHABLE, not merely declared.
 *
 * `getSelectedProvider()` is read-only — status polling, the settings route and
 * the session-start notice. `selectProviderForGenerator()` is the one that
 * starts generators. When only the first knew about 'aimlapi', an install that
 * selected it reported 'aimlapi' everywhere a user could look and still ran
 * every observation on Claude: the start path fell through to its default. The
 * types were all correct, which is exactly why nothing caught it.
 *
 * So the chain is asserted end to end: selected → dispatched for a generator
 * start → handed to the aimlapi agent rather than the Claude one.
 *
 * As in provider-dispatch.test.ts, SettingsDefaultsManager applies process.env
 * LAST, so pinning these (empty string included) fully determines the outcome
 * regardless of the settings file preload created. The persisted credential
 * file lives under the preload's temp CLAUDE_MEM_DATA_DIR and is absent, so
 * `getCredential` contributes nothing here.
 */
const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER',
  'AIMLAPI_API_KEY',
  'CLAUDE_MEM_AIMLAPI_API_KEY',
  'CLAUDE_MEM_AIMLAPI_MODEL',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
] as const;

describe('aimlapi.com dispatch reachability', () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      process.env[key] = '';
    }
    // The quota fallback would rewrite a held primary's answer; this suite is
    // about the selection itself, so it is turned off.
    process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = 'off';
    resetQuotaFallbackStateForTesting();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetQuotaFallbackStateForTesting();
  });

  it('is selected and available from the process-level AIMLAPI_API_KEY alone', () => {
    // The documented env var, with no persisted credential and no settings
    // entry: the exact deployment shape that used to configure no provider.
    process.env.CLAUDE_MEM_PROVIDER = 'aimlapi';
    process.env.AIMLAPI_API_KEY = 'aimlapi-test-key';
    expect(isAimlapiSelected()).toBe(true);
    expect(isAimlapiAvailable()).toBe(true);
  });

  it('read-only dispatch names it', () => {
    process.env.CLAUDE_MEM_PROVIDER = 'aimlapi';
    process.env.AIMLAPI_API_KEY = 'aimlapi-test-key';
    expect(getSelectedProvider()).toBe('aimlapi');
  });

  it('the generator-start dispatch names it too, and agrees with the read-only one', () => {
    process.env.CLAUDE_MEM_PROVIDER = 'aimlapi';
    process.env.AIMLAPI_API_KEY = 'aimlapi-test-key';
    const selection = selectProviderForGenerator();
    expect(selection).toEqual({ provider: 'aimlapi', gatewayProbeClaimId: null });
    expect(getSelectedProvider()).toBe(selection.provider);
  });

  it('falls through to claude when selected with no key, on both paths', () => {
    // The established silent fall-through: a half-configured provider must not
    // fail every observation. Both paths must agree on that too.
    process.env.CLAUDE_MEM_PROVIDER = 'aimlapi';
    expect(isAimlapiAvailable()).toBe(false);
    expect(getSelectedProvider()).toBe('claude');
    expect(selectProviderForGenerator().provider).toBe('claude');
  });

  it('does not steal dispatch from another selected provider', () => {
    process.env.CLAUDE_MEM_PROVIDER = 'gemini';
    process.env.CLAUDE_MEM_GEMINI_API_KEY = 'gemini-test-key';
    process.env.AIMLAPI_API_KEY = 'aimlapi-test-key';
    expect(getSelectedProvider()).toBe('gemini');
    expect(selectProviderForGenerator().provider).toBe('gemini');
  });

  // Lives in THIS describe on purpose: it writes CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER,
  // and only this block saves and restores the environment. Written under the
  // next describe it leaked the last value ('off') into every later file.
  it('can be NAMED as the quota fallback, not silently ignored', () => {
    // CLAUDE_MEM_PROVIDER accepted 'aimlapi' while QUOTA_FALLBACK_PROVIDERS
    // did not, and an unrecognised fallback name reads back as null — i.e.
    // "no fallback". So a user who pointed the fallback at aimlapi got no
    // fallback at all, with nothing saying so.
    expect(QUOTA_FALLBACK_PROVIDERS).toContain('aimlapi');

    process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = 'aimlapi';
    expect(readQuotaFallbackProvider()).toBe('aimlapi');

    // the names it still refuses, so this widened the union rather than
    // opening it
    process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = 'not-a-provider';
    expect(readQuotaFallbackProvider()).toBe(null);
    process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = 'off';
    expect(readQuotaFallbackProvider()).toBe(null);
  });
});

function makeDbManager(): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-aimlapi',
      project: 'proj',
      platform_source: 'claude',
      user_prompt: 'do the thing',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
      ensureMemorySessionIdRegistered: () => {},
      storeObservations: () => ({ observationIds: [], summaryId: null, createdAtEpoch: 0 }),
    }),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;
}

describe('aimlapi.com generator dispatch', () => {
  let spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    spies.forEach(s => s.mockRestore());
    mock.restore();
  });

  it("hands a provider of 'aimlapi' to the aimlapi agent, not the Claude one", async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(4101, 'do the thing', 1);
    session.memorySessionId = 'mem-aimlapi';

    const aimlapiStart = mock(async (current: ActiveSession) => {
      current.abortController.abort();
    });
    const claudeStart = mock(async (current: ActiveSession) => {
      current.abortController.abort();
    });

    await startGeneratorWithProvider(session, 'aimlapi', 'observation', null, null, {
      sessionManager: sm,
      sdkAgent: { startSession: claudeStart } as any,
      geminiAgent: {} as any,
      openRouterAgent: {} as any,
      aimlapiAgent: { startSession: aimlapiStart } as any,
      workerService: {} as any,
      completionHandler: { finalizeSession: mock(() => {}) } as any,
      ensureGeneratorRunning: mock(async () => {}),
      maybeSelfHealStaleClaudeSpawn: () => false,
    });
    await session.generatorPromise;

    expect(aimlapiStart).toHaveBeenCalledTimes(1);
    expect(claudeStart).not.toHaveBeenCalled();
    expect(aimlapiStart.mock.calls[0]![0]).toBe(session);
  });

  it('refuses to start rather than silently running on Claude when no aimlapi agent is wired', async () => {
    // The shape of the original defect, as an explicit failure: a dispatch that
    // names aimlapi with no agent for it must throw, never fall back to the SDK
    // agent and bill observations to the Anthropic plan unannounced.
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(4102, 'do the thing', 1);
    session.memorySessionId = 'mem-aimlapi-2';
    const claudeStart = mock(async () => {});

    await expect(startGeneratorWithProvider(session, 'aimlapi', 'observation', null, null, {
      sessionManager: sm,
      sdkAgent: { startSession: claudeStart } as any,
      geminiAgent: {} as any,
      openRouterAgent: {} as any,
      workerService: {} as any,
      completionHandler: { finalizeSession: mock(() => {}) } as any,
      ensureGeneratorRunning: mock(async () => {}),
      maybeSelfHealStaleClaudeSpawn: () => false,
    })).rejects.toThrow('aimlapi.com provider is not configured');
    expect(claudeStart).not.toHaveBeenCalled();
  });
});
