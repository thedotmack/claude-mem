import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { CodexProvider, classifyCodexError } from '../../src/services/worker/CodexProvider.js';
import { CODEX_SETUP_REQUIRED_CODE } from '../../src/services/worker/CodexAppServerClient.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { getSelectedProvider, selectProviderForGenerator } from '../../src/services/worker/provider-dispatch.js';
import {
  getQuotaCooldown,
  recordAuthCooldown,
  recordQuotaExhausted,
  resetQuotaCooldownsForTesting,
  tryAdmitQuotaProbe,
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
} from '../../src/shared/quota-cooldown.js';
import {
  CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS,
  clearDependencyStatus,
  getDependencyStatus,
  recordCodexCliSetupRequired,
} from '../../src/shared/dependency-health.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

const config = { apiKey: 'native', model: '', reasoningEffort: null, codexPath: 'codex' };
let savedProvider: string | undefined;
beforeEach(() => {
  savedProvider = process.env.CLAUDE_MEM_PROVIDER;
  process.env.CLAUDE_MEM_PROVIDER = 'codex';
  resetQuotaCooldownsForTesting();
  clearDependencyStatus('codex_cli');
});
afterEach(() => {
  resetQuotaCooldownsForTesting();
  clearDependencyStatus('codex_cli');
  if (savedProvider === undefined) delete process.env.CLAUDE_MEM_PROVIDER;
  else process.env.CLAUDE_MEM_PROVIDER = savedProvider;
});

let nextSessionId = 710;
function session(): ActiveSession {
  const id = nextSessionId++;
  return { sessionDbId: id, contentSessionId: `codex-test-${id}`, memorySessionId: `codex-test-${id}`, project: 'test',
    platformSource: 'codex', userPrompt: 'Remember the change', abortController: new AbortController(),
    generatorPromise: null, lastPromptNumber: 1, startTime: Date.now(), cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0, earliestPendingTimestamp: 1, claimedMessageIds: [1], conversationHistory: [],
    currentProvider: null, consecutiveRestarts: 0, consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0, lastGeneratorActivity: Date.now() } as ActiveSession;
}

/** Ages a recorded codex_cli status past its recheck window. */
function ageCodexSetupStatus(): void {
  const status = getDependencyStatus('codex_cli');
  if (status) status.recordedAtMs = Date.now() - CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS - 1;
}

function harness(startSession: (s: ActiveSession) => Promise<void>) {
  const s = session();
  const reset = mock(async () => 1);
  const other = mock(async () => {});
  const finalize = mock(async () => {});
  const scheduleTransportResume = mock(() => {});
  const codex = mock(startSession);
  const manager = { getSession: () => s, resetProcessingToPending: reset,
    getMessageBuffer: () => ({ getPendingCount: () => 1, peekTypes: () => [] }),
    clearTransportResume: mock(() => {}), scheduleTransportResume,
    removeSessionImmediate: mock(() => {}) };
  const routes = new SessionRoutes(manager as any, {} as any, { startSession: other } as any,
    { startSession: other } as any, { startSession: other } as any, {} as any, {} as any,
    { finalizeSession: finalize } as any, { startSession: codex } as any);
  return { s, routes, codex, other, reset, finalize, scheduleTransportResume };
}

/** A generator that fails the way the real provider does: through its handleSessionError. */
function failingLikeCodex(error: ClassifiedProviderError) {
  const provider = new CodexProvider(null as any, null as any) as any;
  return async (s: ActiveSession) => provider.handleSessionError(error, s);
}

describe('Codex provider integration', () => {
  it('accepts Codex settings without changing the default provider or pinning a model', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_PROVIDER).toBe('claude');
    expect(defaults.CLAUDE_MEM_CODEX_MODEL).toBe('');
    const routes = Object.create(SettingsRoutes.prototype) as any;
    expect(routes.validateSettings({ CLAUDE_MEM_PROVIDER: 'codex' }).valid).toBe(true);
  });

  for (const [kind, pause] of [
    ['quota_exhausted', 'quota'], ['auth_invalid', 'auth'], ['rate_limit', 'rate_limit'], ['transient', 'transport'],
  ] as const) {
    it(`pauses on ${kind}, keeps Codex selected and preserves buffered work`, async () => {
      const h = harness(failingLikeCodex(new ClassifiedProviderError('fixture failure', { kind, cause: null })));
      await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'test');
      await h.s.generatorPromise;
      expect(h.codex).toHaveBeenCalledTimes(1);
      expect(h.other).not.toHaveBeenCalled();
      expect(h.finalize).not.toHaveBeenCalled();
      expect(h.s.pausedReason).toBe(pause);
      expect(getSelectedProvider()).toBe('codex');
      expect(selectProviderForGenerator().provider).toBe('codex');
      expect(h.s.generatorPromise).toBeNull();
      // main's runner books each kind on the shared 'codex' breaker
      const cooldown = getQuotaCooldown('codex');
      if (kind === 'transient') {
        expect(cooldown).toBeNull();
        expect(h.scheduleTransportResume).toHaveBeenCalledTimes(1);
      } else {
        expect(cooldown).not.toBeNull();
        if (kind === 'auth_invalid') expect(cooldown?.cause).toBe('auth');
        if (kind === 'rate_limit') expect(cooldown?.window).toBe('rate_limit');
      }
    });
  }

  it('withholds starts during the breaker window and releases the probe after failure', async () => {
    const h = harness(failingLikeCodex(new ClassifiedProviderError('auth fixture', { kind: 'auth_invalid', cause: null })));
    recordQuotaExhausted('codex', 'fixture');
    await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'test');
    expect(h.codex).not.toHaveBeenCalled();
    recordQuotaExhausted('codex', 'fixture', undefined, Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1);
    await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'test');
    await h.s.generatorPromise;
    expect(h.codex).toHaveBeenCalledTimes(1);
    // the failed probe re-armed the breaker, and no claim outlived the run
    expect(getQuotaCooldown('codex')?.probeClaimId).toBeNull();
    expect(tryAdmitQuotaProbe('codex').admitted).toBe(false);
  });

  it('pauses Codex starts after a setup failure and lets one recovery probe through after the window', async () => {
    const setup = new ClassifiedProviderError('Codex: no ChatGPT login', { kind: 'setup_required', cause: null });
    const h = harness(failingLikeCodex(setup));
    await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'first');
    await h.s.generatorPromise;
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.s.pausedReason).toBe('setup_required');
    expect(getDependencyStatus('codex_cli')?.message).toBe('Codex: no ChatGPT login');
    expect(getQuotaCooldown('codex')).toBeNull();

    await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'second');
    expect(h.codex).toHaveBeenCalledTimes(1);

    ageCodexSetupStatus();
    await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'probe');
    await h.s.generatorPromise;
    expect(h.codex).toHaveBeenCalledTimes(2);
    // the failed probe started a fresh window
    await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'third');
    expect(h.codex).toHaveBeenCalledTimes(2);
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.other).not.toHaveBeenCalled();
  });

  it('withholds requests queued behind a failed setup probe and starts the app-server once', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const starts = mock(async () => { await blocked; throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); });
    // Keep the real client queue and failure callback; only replace process startup.
    provider.appServer.ensureStarted = starts;
    const runs = Array.from({ length: 3 }, () => harness(async s => {
      const c = { ...config };
      provider.prepareSessionExtras(s, c);
      try {
        await provider.query([{ role: 'user', content: 'input' }], c);
      } catch (error) {
        provider.handleSessionError(error, s);
      }
    }));
    try {
      for (const h of runs) await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'queued');
      release();
      await Promise.all(runs.map(h => h.s.generatorPromise));
      expect(starts).toHaveBeenCalledTimes(1);
      expect(getDependencyStatus('codex_cli')).not.toBeNull();
      expect(getQuotaCooldown('codex')).toBeNull();
      for (const h of runs) {
        expect(h.s.pausedReason).toBe('setup_required');
        expect(h.finalize).not.toHaveBeenCalled();
        expect(h.other).not.toHaveBeenCalled();
      }
      ageCodexSetupStatus();
      await runs[0].routes.ensureGeneratorRunning(runs[0].s.sessionDbId, 'recovery');
      await runs[0].s.generatorPromise;
      expect(starts).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await provider.close();
    }
  });

  it('clears the breaker and the setup status when a request is served', async () => {
    recordQuotaExhausted('codex', 'fixture', undefined, Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1);
    recordCodexCliSetupRequired('fixture');
    ageCodexSetupStatus();
    const provider = new CodexProvider(null as any, null as any) as any;
    provider.appServer.runTurn = mock(async (options: any) => { options.beforeSend(); return { content: '' }; });
    await provider.query([{ role: 'user', content: 'probe' }], config);
    expect(getQuotaCooldown('codex')).toBeNull();
    expect(getDependencyStatus('codex_cli')).toBeNull();
  });

  for (const [arm, kind] of [
    [() => recordQuotaExhausted('codex', 'usage limit fixture'), 'quota_exhausted'],
    [() => recordAuthCooldown('codex', 'login fixture'), 'auth_invalid'],
    [() => recordCodexCliSetupRequired('setup fixture'), 'setup_required'],
  ] as const) {
    it(`does not send a queued request once another request armed ${kind}`, async () => {
      const provider = new CodexProvider(null as any, null as any) as any;
      let release!: () => void;
      const queued = new Promise<void>(resolve => { release = resolve; });
      let sends = 0;
      provider.appServer.runTurn = async (options: any) => {
        await queued;
        try {
          options.beforeSend();
        } catch (error) {
          options.onFailure(error);
          throw error;
        }
        sends++;
        return { content: '' };
      };
      const result = provider.query([{ role: 'user', content: 'input' }], config);
      arm();
      const armedAt = getQuotaCooldown('codex')?.armedAtMs;
      release();
      await expect(result).rejects.toMatchObject({ kind });
      expect(sends).toBe(0);
      // the withheld request repeats a known refusal; it does not re-arm the breaker
      expect(getQuotaCooldown('codex')?.armedAtMs).toBe(armedAt);
    });
  }

  it('sends once the breaker window has elapsed (the probe is not withheld)', async () => {
    recordQuotaExhausted('codex', 'fixture', undefined, Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1);
    const provider = new CodexProvider(null as any, null as any) as any;
    const sends = mock(async (options: any) => { options.beforeSend(); return { content: '<observation/>' }; });
    provider.appServer.runTurn = sends;
    await provider.query([{ role: 'user', content: 'input' }], config);
    expect(sends).toHaveBeenCalledTimes(1);
    expect(getQuotaCooldown('codex')).toBeNull();
  });

  it('forwards all conversation text and accepts successful quota-related prose', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const turn = mock(async () => ({ content: 'The application session limit is configurable.', inputTokens: 10, outputTokens: 4 }));
    provider.appServer.runTurn = turn;
    const history = [{ role: 'user', content: 'observation input' }, { role: 'assistant', content: 'prior observation' }, { role: 'user', content: 'summary request' }];
    const result = await provider.query(history, config);
    for (const message of history) expect((turn.mock.calls[0] as any)[0].prompt).toContain(message.content);
    expect(result.content).toContain('session limit');
    expect(getQuotaCooldown('codex')).toBeNull();
    expect(provider.buildLastUsage(result)).toEqual({ input: 10, output: 4 });
    const close = mock(async () => {});
    provider.appServer.close = close;
    await provider.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('uses the shared LLM deadline, or the caller\'s own (the field pass)', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const turn = mock(async () => ({ content: 'ok' }));
    provider.appServer.runTurn = turn;
    const savedTimeout = process.env.CLAUDE_MEM_LLM_TIMEOUT_MS;
    process.env.CLAUDE_MEM_LLM_TIMEOUT_MS = '45000';
    try {
      await provider.query([{ role: 'user', content: 'input' }], config);
      await provider.query([{ role: 'user', content: 'condense' }], config, undefined, 9000);
    } finally {
      if (savedTimeout === undefined) delete process.env.CLAUDE_MEM_LLM_TIMEOUT_MS;
      else process.env.CLAUDE_MEM_LLM_TIMEOUT_MS = savedTimeout;
    }
    expect((turn.mock.calls[0] as any)[0].timeoutMs).toBe(45000);
    expect((turn.mock.calls[1] as any)[0].timeoutMs).toBe(9000);
  });

  for (const source of ['session', 'caller'] as const) {
    it(`cancels the native request when the ${source} signal aborts`, async () => {
      const provider = new CodexProvider(null as any, null as any) as any;
      const s = session();
      const c = { ...config };
      provider.prepareSessionExtras(s, c);
      const caller = new AbortController();
      let started!: () => void;
      let nativeSignal: AbortSignal | undefined;
      const ready = new Promise<void>(resolve => { started = resolve; });
      provider.appServer.runTurn = (options: any) => new Promise((_, reject) => {
        nativeSignal = options.signal;
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        started();
      });
      const result = provider.query([{ role: 'user', content: 'input' }], c, caller.signal);
      await ready;
      if (source === 'session') s.abortController.abort(new Error('stopped'));
      else caller.abort(new Error('field deadline'));
      await expect(result).rejects.toThrow('Aborted');
      expect(nativeSignal?.aborted).toBe(true);
    });
  }

  for (const [error, kind] of [
    [new Error('Codex executable not found'), 'setup_required'],
    [Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }), 'setup_required'],
    [Object.assign(new Error('auth file readable by others'), { code: CODEX_SETUP_REQUIRED_CODE }), 'setup_required'],
    [new Error('not logged in'), 'auth_invalid'],
    [new Error('usage limit reached'), 'quota_exhausted'], [new Error('429 rate limit'), 'rate_limit'],
    [new Error('context window exceeded'), 'context_overflow'], [new Error('connection closed'), 'transient'],
  ] as const) {
    it(`classifies "${error.message}" as ${kind}`, () => {
      expect(classifyCodexError(error).kind).toBe(kind);
    });
  }

  for (const [info, kind] of [
    ['usageLimitExceeded', 'quota_exhausted'], ['unauthorized', 'auth_invalid'],
    ['rateLimitExceeded', 'rate_limit'], ['contextWindowExceeded', 'context_overflow'],
    [{ responseStreamConnectionFailed: { httpStatusCode: 401 } }, 'auth_invalid'],
    [{ httpConnectionFailed: { httpStatusCode: 429 } }, 'rate_limit'],
    [{ responseStreamDisconnected: { httpStatusCode: null } }, 'transient'],
  ] as const) {
    it(`classifies structured Codex error ${JSON.stringify(info)} as ${kind}`, () => {
      const error = Object.assign(new Error('Codex app-server reported an error'), { codexErrorInfo: info });
      expect(classifyCodexError(error).kind).toBe(kind);
    });
  }

  for (const [info, check] of [
    ['usageLimitExceeded', () => expect(getQuotaCooldown('codex')?.cause).toBeUndefined()],
    ['unauthorized', () => expect(getQuotaCooldown('codex')?.cause).toBe('auth')],
  ] as const) {
    it(`arms the shared breaker before the queue moves on, without retrying ${info}`, async () => {
      const provider = new CodexProvider(null as any, null as any) as any;
      const sends = mock(async (options: any) => {
        const error = Object.assign(new Error('Codex app-server reported an error'), { codexErrorInfo: info });
        options.onFailure(error);
        throw error;
      });
      provider.appServer.runTurn = sends;
      try {
        await expect(provider.query([{ role: 'user', content: 'input' }], { ...config })).rejects.toBeInstanceOf(ClassifiedProviderError);
        expect(sends).toHaveBeenCalledTimes(1);
        expect(getQuotaCooldown('codex')).not.toBeNull();
        check();
        expect(getDependencyStatus('codex_cli')).toBeNull();
      } finally {
        await provider.close();
      }
    });
  }
});
