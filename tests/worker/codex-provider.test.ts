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
import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

const config = { apiKey: 'native', model: '', reasoningEffort: null, codexPath: 'codex' };

function stubCompletedAppServerTurns(provider: any, contents: Array<string | null>): string[] {
  const methods: string[] = [];
  let turn = 0;
  for (const client of provider.appServer.clients) {
    client.ensureStarted = async () => {};
    client.workspace = 'private-test-workspace';
    client.readInheritedMcpServerNames = async () => [];
    client.attestMcpServersDisabled = async () => {};
    client.request = async (method: string) => {
      methods.push(method);
      if (method === 'thread/start') return { thread: { id: `thread-${turn + 1}` }, instructionSources: [] };
      if (method === 'turn/start') {
        const content = contents[turn++];
        return { turn: { id: `turn-${turn}`, status: 'completed', items: content === null ? [] : [
          { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ content }) },
        ] } };
      }
      if (method === 'thread/unsubscribe') return {};
      throw new Error(`Unexpected request: ${method}`);
    };
  }
  return methods;
}
let savedProvider: string | undefined;
let savedMaxConcurrentAgents: string | undefined;
beforeEach(() => {
  savedProvider = process.env.CLAUDE_MEM_PROVIDER;
  savedMaxConcurrentAgents = process.env.CLAUDE_MEM_CODEX_MAX_CONCURRENT_AGENTS;
  process.env.CLAUDE_MEM_CODEX_MAX_CONCURRENT_AGENTS = '2';
  process.env.CLAUDE_MEM_PROVIDER = 'codex';
  resetQuotaCooldownsForTesting();
  clearDependencyStatus('codex_cli');
});
afterEach(() => {
  resetQuotaCooldownsForTesting();
  clearDependencyStatus('codex_cli');
  if (savedProvider === undefined) delete process.env.CLAUDE_MEM_PROVIDER;
  else process.env.CLAUDE_MEM_PROVIDER = savedProvider;
  if (savedMaxConcurrentAgents === undefined) delete process.env.CLAUDE_MEM_CODEX_MAX_CONCURRENT_AGENTS;
  else process.env.CLAUDE_MEM_CODEX_MAX_CONCURRENT_AGENTS = savedMaxConcurrentAgents;
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
  const observation = `<observation><type>bugfix</type><title>Preserve quota pause</title>
    <subtitle>Concurrent storage</subtitle><narrative>Storage preserves newer quota failures.</narrative>
    <facts><fact>Two turns can finish out of order.</fact></facts>
    <concepts><concept>problem-solution</concept></concepts>
    <files_read></files_read><files_modified></files_modified></observation>`;

  function storageHarness() {
    ModeManager.getInstance().loadMode('code');
    const store = mock(() => ({ observationIds: [1], summaryId: null, createdAtEpoch: 1 }));
    const confirm = mock(async () => 1);
    const db = { getSessionStore: () => ({ storeObservations: store,
      ensureMemorySessionIdRegistered: () => 'codex-test' }),
      getChromaSync: () => null, getCloudSync: () => null };
    const manager = { getClaimedMessages: () => [], confirmClaimedMessages: confirm };
    const process = (text: string, s = session()) =>
      processAgentResponse(text, s, db as any, manager as any, undefined, 0, 1, 'Codex');
    return { store, confirm, process };
  }

  for (const failureBeforeSuccess of [true, false]) {
    it(`preserves concurrent quota refusal through valid observation storage (failure before success: ${failureBeforeSuccess})`, async () => {
      const provider = new CodexProvider(null as any, null as any) as any;
      const pending: Array<{ options: any; resolve: (value: any) => void; reject: (error: unknown) => void }> = [];
      let expectedAdmissions = 2;
      let admitted!: () => void;
      let ready = new Promise<void>(resolve => { admitted = resolve; });
      for (const client of provider.appServer.clients) client.runTurn = (options: any) => {
        options.beforeSend();
        return new Promise((resolve, reject) => {
          pending.push({ options, resolve, reject });
          if (pending.length === expectedAdmissions) admitted();
        });
      };
      const earlier = provider.query([], config);
      const later = provider.query([], config).catch((error: unknown) => error);
      await ready;
      expect(pending).toHaveLength(2);
      const fail = async () => {
        const error = new Error('usage limit reached');
        pending[1].options.onFailure(error);
        pending[1].reject(error);
        expect(await later).toHaveProperty('kind', 'quota_exhausted');
      };
      if (failureBeforeSuccess) await fail();
      pending[0].resolve({ content: observation });
      const result = await earlier;
      if (!failureBeforeSuccess) await fail();
      const newer = getQuotaCooldown('codex');
      expect(newer).not.toBeNull();
      const h = storageHarness();
      await h.process(result.content, { ...session(), currentProvider: 'codex' });
      expect(h.store).toHaveBeenCalledTimes(1);
      expect((h.store.mock.calls[0] as any)[2]).toMatchObject([{ title: 'Preserve quota pause' }]);
      expect(h.confirm).toHaveBeenCalledTimes(1);
      expect(getQuotaCooldown('codex')).toBe(newer);
      expect(tryAdmitQuotaProbe('codex').admitted).toBe(false);

      // Once the window has elapsed, the recovery probe clears the pause and stores its reply.
      recordQuotaExhausted('codex', 'usage limit reached', undefined, Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1);
      expectedAdmissions = 3;
      ready = new Promise<void>(resolve => { admitted = resolve; });
      const recovery = provider.query([], config);
      await ready;
      pending[2].resolve({ content: observation });
      await h.process((await recovery).content, { ...session(), currentProvider: 'codex' });
      expect(h.store).toHaveBeenCalledTimes(2);
      expect(getQuotaCooldown('codex')).toBeNull();
    });
  }

  for (const currentProvider of ['claude', 'gemini', 'openrouter', 'cmem-gateway'] as const) {
    it(`still clears ${currentProvider} cooldown after valid observation storage`, async () => {
      recordQuotaExhausted(currentProvider, 'fixture');
      const h = storageHarness();
      await h.process(observation, { ...session(), currentProvider });
      expect(h.store).toHaveBeenCalledTimes(1);
      expect(h.confirm).toHaveBeenCalledTimes(1);
      expect(getQuotaCooldown(currentProvider)).toBeNull();
    });
  }

  for (const [message, kind] of [
    ['usage limit reached', 'quota_exhausted'],
    ['unauthorized', 'auth_invalid'],
    ['Codex executable not found', 'setup_required'],
  ] as const) {
    it(`does not let a delayed ${kind} rejection undo a later successful probe`, async () => {
      const armed = () => kind === 'setup_required' ? getDependencyStatus('codex_cli') : getQuotaCooldown('codex');
      const age = () => {
        if (kind === 'setup_required') {
          const status = getDependencyStatus('codex_cli');
          if (status) status.recordedAtMs = Date.now() - CODEX_CLI_SETUP_RECHECK_COOLDOWN_MS - 1;
        } else {
          const state = getQuotaCooldown('codex');
          if (state) state.armedAtMs = Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1;
        }
      };
      const provider = new CodexProvider(null as any, null as any) as any;
      const failure = new Error(message);
      let rejectOld!: (error: unknown) => void;
      let sends = 0;
      let admitted!: () => void;
      const ready = new Promise<void>(resolve => { admitted = resolve; });
      for (const client of provider.appServer.clients) client.runTurn = (options: any) => {
        options.beforeSend();
        if (++sends === 1) {
          options.onFailure(failure);
          admitted();
          return new Promise((_, reject) => { rejectOld = reject; });
        }
        return Promise.resolve({ content: 'Recovered' });
      };
      const old = provider.query([], config).catch((error: unknown) => error);
      await ready;
      const published = armed();
      expect(published).not.toBeNull();
      age();
      await provider.query([], config);
      expect(armed()).toBeNull();
      // The first request's rejection lands after the probe: it was published
      // once, when it happened, and is not published again.
      rejectOld(failure);
      expect(await old).toHaveProperty('kind', kind);
      expect(armed()).toBeNull();
      await provider.query([], config);
      expect(sends).toBe(3);
      // A new failure arms a fresh window.
      for (const client of provider.appServer.clients) client.runTurn = async (options: any) => { options.onFailure(failure); throw failure; };
      await expect(provider.query([], config)).rejects.toMatchObject({ kind });
      expect(armed()).not.toBeNull();
      expect(armed()).not.toBe(published);
    });
  }

  // Never pay twice (Phase 1): a transient Codex fault (connection closed) is
  // ambiguous — the turn may have run — so it is no longer retried in place.
  // It surfaces as the transient pause; the session's transport resume and the
  // batch's paid-send budget decide about a resend. A refusal on the first send
  // still publishes its breaker.
  it('does not resend after an ambiguous transient attempt', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    let sends = 0;
    for (const client of provider.appServer.clients) client.runTurn = async (options: any) => {
      const failure = new Error(++sends === 1 ? 'connection closed' : 'usage limit reached');
      options.onFailure(failure);
      throw failure;
    };
    await expect(provider.query([], config)).rejects.toMatchObject({ kind: 'transient' });
    expect(sends).toBe(1);
  });

  it('accepts an empty structured initialization reply without retrying', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const methods = stubCompletedAppServerTurns(provider, ['']);
    const result = await provider.query([{ role: 'user', content: 'initialize' }], config);
    expect(result.content).toBe('');
    expect(methods.filter(method => method === 'turn/start')).toHaveLength(1);
  });

  // Never pay twice (Phase 1): a completed turn without an agent message was
  // billed, so it is an output failure, never resent. The session turn passes
  // it on as an empty reply (OpenAICompatibleProvider.queryObserverTurn, shared
  // with the HTTP providers).
  it('raises a completed app-server turn without an agent message as an output failure, without a second turn', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const methods = stubCompletedAppServerTurns(provider, [null, 'Recovered memory']);
    await expect(provider.query([{ role: 'user', content: 'input' }], config))
      .rejects.toMatchObject({ paidSendOutcome: 'output_failure' });
    expect(methods.filter(method => method === 'turn/start')).toHaveLength(1);
  });

  it('passes an output failure on to the session as an empty reply', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    stubCompletedAppServerTurns(provider, [null]);
    const s = session();
    s.conversationHistory = [{ role: 'user', content: 'input' }];
    const result = await provider.queryObserverTurn(s, config, undefined);
    expect(result.content).toBe('');
  });

  it('passes blank structured output on as the reply, without a second turn', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const methods = stubCompletedAppServerTurns(provider, [' ', '<observation/>']);
    const result = await provider.query([{ role: 'user', content: 'input' }], config);
    expect(result.content).toBe('');
    expect(methods.filter(method => method === 'turn/start')).toHaveLength(1);
  });

  it('cancels a compression request while the session signal remains active', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const sessionController = new AbortController();
    const compressionController = new AbortController();
    const c = { ...config, signal: sessionController.signal };
    let started!: () => void;
    let nativeSignal: AbortSignal | undefined;
    const ready = new Promise<void>(resolve => { started = resolve; });
    for (const client of provider.appServer.clients) client.runTurn = (options: any) => new Promise((_, reject) => {
      nativeSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(new Error('compression aborted')), { once: true });
      started();
    });
    const result = provider.query([{ role: 'user', content: 'compress payload' }], c, compressionController.signal);
    await ready;
    compressionController.abort();
    await expect(result).rejects.toThrow('Aborted');
    expect(nativeSignal?.aborted).toBe(true);
    expect(sessionController.signal.aborted).toBe(false);
  });

  it('accepts Codex settings without changing the default provider or pinning a model', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_PROVIDER).toBe('claude');
    expect(defaults.CLAUDE_MEM_CODEX_MODEL).toBe('');
    expect(defaults.CLAUDE_MEM_CODEX_REASONING_EFFORT).toBe('low');
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
    // Keep the real pool, client queues and failure callback; only replace process startup.
    for (const client of provider.appServer.clients) client.ensureStarted = starts;
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
      // Two pool slots were already starting; the request queued behind them is withheld.
      expect(starts).toHaveBeenCalledTimes(2);
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
      expect(starts).toHaveBeenCalledTimes(3);
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
    for (const client of provider.appServer.clients) client.runTurn = mock(async (options: any) => { options.beforeSend(); return { content: '' }; });
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
      for (const client of provider.appServer.clients) client.runTurn = async (options: any) => {
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
    for (const client of provider.appServer.clients) client.runTurn = sends;
    await provider.query([{ role: 'user', content: 'input' }], config);
    expect(sends).toHaveBeenCalledTimes(1);
    expect(getQuotaCooldown('codex')).toBeNull();
  });

  it('forwards all conversation text and accepts successful quota-related prose', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const turn = mock(async () => ({ content: 'The application session limit is configurable.', inputTokens: 10, outputTokens: 4 }));
    for (const client of provider.appServer.clients) client.runTurn = turn;
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
    for (const client of provider.appServer.clients) client.runTurn = turn;
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
      for (const client of provider.appServer.clients) client.runTurn = (options: any) => new Promise((_, reject) => {
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
      for (const client of provider.appServer.clients) client.runTurn = sends;
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
