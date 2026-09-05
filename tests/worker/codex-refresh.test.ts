import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { CodexProvider } from '../../src/services/worker/CodexProvider.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { getSelectedProvider, selectProviderForGenerator } from '../../src/services/worker/provider-dispatch.js';
import { getQuotaCooldown, recordQuotaExhausted, resetQuotaCooldownsForTesting, tryAdmitQuotaProbe, QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS } from '../../src/shared/quota-cooldown.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { optimizeObservationFields } from '../../src/services/worker/field-optimizer.js';

const config = { apiKey: 'native', model: 'gpt-5.6-luna', reasoningEffort: 'none', codexPath: 'codex', maxEstimatedTokens: 100000, timeoutMs: 1000 };
const noise = '<skip_summary reason="noise" />';
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
  return { sessionDbId: 710, contentSessionId: 'refresh', memorySessionId: 'codex-refresh', project: 'refresh',
    platformSource: 'codex', userPrompt: 'Retain durable changes', abortController: new AbortController(),
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
    { startSession: other } as any, { startSession: other } as any, { startSession: codex } as any,
    {} as any, {} as any, { finalizeSession: finalize } as any);
  return { s, routes, codex, other, reset, finalize };
}

describe('Codex refresh dispatch and queue ownership', () => {
  for (const kind of ['auth_invalid', 'quota_exhausted', 'rate_limit', 'transient', 'unrecoverable']) {
    it(`does not fall back or finalize buffered work after ${kind}`, async () => {
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

  it('withholds starts during quota cooldown and releases a claimed probe on auth failure', async () => {
    const h = harness(async () => { throw new ClassifiedProviderError('auth fixture', { kind: 'auth_invalid', cause: null }); });
    recordQuotaExhausted('codex', 'fixture');
    await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'test');
    expect(h.codex).not.toHaveBeenCalled();
    expect(h.other).not.toHaveBeenCalled();
    recordQuotaExhausted('codex', 'fixture', undefined, Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1);
    await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'test');
    await h.s.generatorPromise;
    expect(getQuotaCooldown('codex')?.probeClaimId).toBeNull();
    expect(tryAdmitQuotaProbe('codex').admitted).toBe(true);
  });
});

describe('Codex refresh request admission', () => {
  it('withholds an already-admitted turn when quota changes while queued', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    let release!: () => void;
    const queued = new Promise<void>(resolve => { release = resolve; });
    let modelSends = 0;
    provider.appServer.runTurn = async (options: { beforeSend: () => void }) => {
      await queued;
      options.beforeSend();
      modelSends++;
      return { content: noise };
    };
    const result = provider.query([{ role: 'user', content: 'queued input' }], config);
    recordQuotaExhausted('codex', 'another session exhausted quota');
    release();
    await expect(result).rejects.toMatchObject({ kind: 'quota_paused' });
    expect(modelSends).toBe(0);
  });

  it('optimizer timeout cancels the active native request without cancelling the session', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const s = session();
    let active = 0;
    let signal: AbortSignal | undefined;
    provider.appServer.runTurn = async (options: { signal: AbortSignal }) => {
      signal = options.signal;
      active++;
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => { active--; reject(options.signal.reason); }, { once: true });
      });
    };
    await expect(optimizeObservationFields({ toolInput: 'x'.repeat(17000), toolOutput: '' },
      (text, budget, { signal }) => provider.compressField(text, budget, config, signal, s),
      { sessionDbId: s.sessionDbId }, undefined, { signal: s.abortController.signal, timeoutMs: 15 }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(signal?.aborted).toBe(true);
    expect(active).toBe(0);
    expect(s.abortController.signal.aborted).toBe(false);
  });

  it('blocks newest oversized input before transport and keeps all history when it fits', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const turn = mock(async () => ({ content: noise }));
    provider.appServer.runTurn = turn;
    await expect(provider.query([{ role: 'user', content: 'x'.repeat(2000) }], { ...config, maxEstimatedTokens: 1000 }))
      .rejects.toMatchObject({ kind: 'context_overflow' });
    expect(turn).not.toHaveBeenCalled();
    const history = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: `durable-${i}` }));
    await provider.query(history, config);
    expect(turn.mock.calls[0][0].prompt).toContain('durable-0');
    expect(turn.mock.calls[0][0].prompt).toContain('durable-24');
    expect(turn.mock.calls[0][0].reasoningEffort).toBe('none');
  });

  it('counts multibyte input and framing against the bound', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const turn = mock(async () => ({ content: noise }));
    provider.appServer.runTurn = turn;
    await expect(provider.query([{ role: 'user', content: '\u4e00'.repeat(400) }], { ...config, maxEstimatedTokens: 1000 }))
      .rejects.toMatchObject({ kind: 'context_overflow' });
    expect(turn).not.toHaveBeenCalled();
  });

  it('shares the generator probe, clears it on explicit noise, and gates auxiliary requests under quota', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const turn = mock(async () => ({ content: noise }));
    provider.appServer.runTurn = turn;
    recordQuotaExhausted('codex', 'fixture', undefined, Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1);
    const admission = tryAdmitQuotaProbe('codex');
    await provider.query([{ role: 'user', content: 'probe' }], { ...config, quotaProbeClaimId: admission.claimId });
    expect(getQuotaCooldown('codex')).toBeNull();
    recordQuotaExhausted('codex', 'fixture');
    await expect(provider.compressField('x'.repeat(17000), 1000, config, new AbortController().signal, session()))
      .rejects.toMatchObject({ kind: 'quota_paused' });
    expect(turn).toHaveBeenCalledTimes(1);
  });

  it('propagates auxiliary quota refusal and never makes the observation request', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const turn = mock(async () => { throw new Error('usage limit reached'); });
    provider.appServer.runTurn = turn;
    await expect(provider.compressField('x'.repeat(17000), 1000, config, new AbortController().signal, session()))
      .rejects.toMatchObject({ kind: 'quota_exhausted' });
    expect(turn).toHaveBeenCalledTimes(1);
    expect(getQuotaCooldown('codex')).not.toBeNull();
  });

  it('does not send already cancelled auxiliary work', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const turn = mock(async () => ({ content: noise }));
    provider.appServer.runTurn = turn;
    const controller = new AbortController();
    controller.abort();
    await expect(provider.compressField('payload', 1000, config, controller.signal, session())).rejects.toMatchObject({ name: 'AbortError' });
    expect(turn).not.toHaveBeenCalled();
  });

  it('recycles and preserves claimed input instead of acknowledging an oversized generation', async () => {
    const reset = mock(async () => 1);
    const provider = new CodexProvider(null as any, { resetProcessingToPending: reset } as any) as any;
    const s = session();
    s.conversationHistory = [{ role: 'user', content: 'oversized' }];
    await provider.handleSessionError(new ClassifiedProviderError('budget', { kind: 'context_overflow', cause: null }), s);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(s.abortReason).toBe('overflow:recycle');
    expect(s.conversationHistory).toHaveLength(0);
    expect(s.abortController.signal.aborted).toBe(true);
  });
});
