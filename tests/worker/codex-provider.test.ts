import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { CodexProvider, classifyCodexError } from '../../src/services/worker/CodexProvider.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { getSelectedProvider, selectProviderForGenerator } from '../../src/services/worker/provider-dispatch.js';
import { getQuotaCooldown, recordQuotaExhausted, resetQuotaCooldownsForTesting, tryAdmitQuotaProbe, QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS } from '../../src/shared/quota-cooldown.js';
import type { ActiveSession } from '../../src/services/worker-types.js';

const config = { apiKey: 'native', model: '', reasoningEffort: null, codexPath: 'codex', timeoutMs: 1000 };
let savedProvider: string | undefined;
beforeEach(() => {
  savedProvider = process.env.CLAUDE_MEM_PROVIDER;
  process.env.CLAUDE_MEM_PROVIDER = 'codex';
  resetQuotaCooldownsForTesting();
});
afterEach(() => {
  resetQuotaCooldownsForTesting();
  if (savedProvider === undefined) delete process.env.CLAUDE_MEM_PROVIDER;
  else process.env.CLAUDE_MEM_PROVIDER = savedProvider;
});

function session(): ActiveSession {
  return { sessionDbId: 710, contentSessionId: 'codex-test', memorySessionId: 'codex-test', project: 'test',
    platformSource: 'codex', userPrompt: 'Remember the change', abortController: new AbortController(),
    generatorPromise: null, lastPromptNumber: 1, startTime: Date.now(), cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0, earliestPendingTimestamp: 1, claimedMessageIds: [1], conversationHistory: [],
    currentProvider: 'codex', consecutiveRestarts: 0, consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0, lastGeneratorActivity: Date.now() };
}

function harness(startSession: (s: ActiveSession) => Promise<void>) {
  const s = session();
  const reset = mock(async () => 1);
  const other = mock(async () => {});
  const finalize = mock(async () => {});
  const codex = mock(startSession);
  const manager = { getSession: () => s, resetProcessingToPending: reset,
    getMessageBuffer: () => ({ getPendingCount: () => 1, peekTypes: () => ['observation'] }),
    removeSessionImmediate: mock(() => {}) };
  const routes = new SessionRoutes(manager as any, {} as any, { startSession: other } as any,
    { startSession: other } as any, { startSession: other } as any, {} as any, {} as any,
    { finalizeSession: finalize } as any, { startSession: codex } as any);
  return { s, routes, codex, other, reset, finalize };
}

describe('Codex provider integration', () => {
  it('accepts Codex settings without changing the default provider or pinning a model', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_PROVIDER).toBe('claude');
    expect(defaults.CLAUDE_MEM_CODEX_MODEL).toBe('');
    const routes = Object.create(SettingsRoutes.prototype) as any;
    expect(routes.validateSettings({ CLAUDE_MEM_PROVIDER: 'codex' }).valid).toBe(true);
  });

  for (const kind of ['auth_invalid', 'quota_exhausted', 'rate_limit', 'transient', 'unrecoverable']) {
    it(`keeps Codex selected and preserves buffered work after ${kind}`, async () => {
      const h = harness(async () => { throw new ClassifiedProviderError('fixture failure', { kind, cause: null }); });
      await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'test');
      await h.s.generatorPromise;
      expect(h.codex).toHaveBeenCalledTimes(1);
      expect(h.other).not.toHaveBeenCalled();
      expect(h.reset).toHaveBeenCalledTimes(1);
      expect(h.finalize).not.toHaveBeenCalled();
      expect(getSelectedProvider()).toBe('codex');
      expect(selectProviderForGenerator().provider).toBe('codex');
      expect(h.s.generatorPromise).toBeNull();
    });
  }

  it('withholds starts during cooldown and releases the probe after failure', async () => {
    const h = harness(async () => { throw new ClassifiedProviderError('auth fixture', { kind: 'auth_invalid', cause: null }); });
    recordQuotaExhausted('codex', 'fixture');
    await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'test');
    expect(h.codex).not.toHaveBeenCalled();
    recordQuotaExhausted('codex', 'fixture', undefined, Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1);
    await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'test');
    await h.s.generatorPromise;
    expect(getQuotaCooldown('codex')?.probeClaimId).toBeNull();
    expect(tryAdmitQuotaProbe('codex').admitted).toBe(true);
  });

  it('does not send a queued request after another session exhausts quota', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    let release!: () => void;
    const queued = new Promise<void>(resolve => { release = resolve; });
    let sends = 0;
    provider.appServer.runTurn = async (options: any) => {
      await queued;
      options.beforeSend();
      sends++;
      return { content: '' };
    };
    const result = provider.query([{ role: 'user', content: 'input' }], config);
    recordQuotaExhausted('codex', 'fixture');
    release();
    await expect(result).rejects.toMatchObject({ kind: 'quota_paused' });
    expect(sends).toBe(0);
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

  it('cancels the native request when its session aborts', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const s = session();
    const c = { ...config };
    provider.prepareSessionExtras(s, c);
    let started!: () => void;
    let nativeSignal: AbortSignal | undefined;
    const ready = new Promise<void>(resolve => { started = resolve; });
    provider.appServer.runTurn = (options: any) => new Promise((_, reject) => {
      nativeSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      started();
    });
    const result = provider.query([{ role: 'user', content: 'input' }], c);
    await ready;
    s.abortController.abort(new Error('stopped'));
    await expect(result).rejects.toThrow('Aborted');
    expect(nativeSignal?.aborted).toBe(true);
  });

  for (const [message, kind] of [
    ['Codex executable not found', 'unrecoverable'], ['not logged in', 'auth_invalid'],
    ['usage limit reached', 'quota_exhausted'], ['429 rate limit', 'rate_limit'],
    ['context window exceeded', 'context_overflow'], ['connection closed', 'transient'],
  ]) {
    it(`classifies ${kind} transport failures`, () => {
      expect(classifyCodexError(new Error(message)).kind).toBe(kind);
    });
  }
});
