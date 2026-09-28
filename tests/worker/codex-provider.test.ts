import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { CodexProvider, classifyCodexError } from '../../src/services/worker/CodexProvider.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { getSelectedProvider, selectProviderForGenerator } from '../../src/services/worker/provider-dispatch.js';
import { getQuotaCooldown, recordQuotaExhausted, resetQuotaCooldownsForTesting, tryAdmitQuotaProbe, QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS, CODEX_SETUP_RECHECK_COOLDOWN_MS } from '../../src/shared/quota-cooldown.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

const config = { apiKey: 'native', model: '', reasoningEffort: null, codexPath: 'codex', timeoutMs: 1000 };

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
      provider.appServer.runTurn = (options: any) => {
        options.beforeSend();
        return new Promise((resolve, reject) => { pending.push({ options, resolve, reject }); });
      };
      const earlier = provider.query([], config);
      const later = provider.query([], config).catch((error: unknown) => error);
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
      await h.process(result.content);
      expect(h.store).toHaveBeenCalledTimes(1);
      expect((h.store.mock.calls[0] as any)[2]).toMatchObject([{ title: 'Preserve quota pause' }]);
      expect(h.confirm).toHaveBeenCalledTimes(1);
      expect(getQuotaCooldown('codex')).toBe(newer);
      expect(tryAdmitQuotaProbe('codex').admitted).toBe(false);

      // The owned recovery probe can still clear the pause and store its reply.
      const claim = tryAdmitQuotaProbe('codex', newer!.armedAtMs + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1);
      const recovery = provider.query([], { ...config, quotaProbeClaimId: claim.claimId });
      pending[2].resolve({ content: observation });
      await h.process((await recovery).content);
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

  for (const [message, key, kind] of [
    ['usage limit reached', 'codex', 'quota_exhausted'],
    ['not logged in', 'codex-setup', 'auth_invalid'],
    ['Codex executable not found', 'codex-setup', 'unrecoverable'],
  ] as const) {
    it(`does not republish delayed ${kind} rejection after a successful probe`, async () => {
      const provider = new CodexProvider(null as any, null as any) as any;
      const failure = new Error(message);
      let rejectOld!: (error: unknown) => void;
      let sends = 0;
      provider.appServer.runTurn = (options: any) => {
        options.beforeSend();
        if (++sends === 1) {
          options.onFailure(failure);
          return new Promise((_, reject) => { rejectOld = reject; });
        }
        return Promise.resolve({ content: 'Recovered' });
      };
      const old = provider.query([], config).catch((error: unknown) => error);
      const published = getQuotaCooldown(key)!;
      expect(published).not.toBeNull();
      const claim = tryAdmitQuotaProbe(key, published.armedAtMs + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1);
      expect(claim.admitted).toBe(true);
      await provider.query([], { ...config,
        quotaProbeClaimId: key === 'codex' ? claim.claimId : null,
        setupProbeClaimId: key === 'codex-setup' ? claim.claimId : null });
      expect(getQuotaCooldown(key)).toBeNull();
      rejectOld(failure);
      expect(await old).toHaveProperty('kind', kind);
      expect(getQuotaCooldown(key)).toBeNull();
      await provider.query([], config);
      expect(sends).toBe(3);
      // A genuinely new failure still arms a fresh cooldown, even without the callback.
      provider.appServer.runTurn = async () => { throw new Error(message); };
      await expect(provider.query([], config)).rejects.toMatchObject({ kind });
      expect(getQuotaCooldown(key)).not.toBeNull();
      expect(getQuotaCooldown(key)).not.toBe(published);
    });
  }

  it('publishes quota failure from a retry after a transient attempt', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    let sends = 0;
    provider.appServer.runTurn = async (options: any) => {
      const failure = new Error(++sends === 1 ? 'connection closed' : 'usage limit reached');
      options.onFailure(failure);
      throw failure;
    };
    await expect(provider.query([], config)).rejects.toMatchObject({ kind: 'quota_exhausted' });
    expect(sends).toBe(2);
    expect(getQuotaCooldown('codex')).not.toBeNull();
  });

  it('accepts an empty structured initialization reply without retrying', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const methods = stubCompletedAppServerTurns(provider, ['']);
    const result = await provider.queryForInitialization([{ role: 'user', content: 'initialize' }], config);
    expect(result.content).toBe('');
    expect(methods.filter(method => method === 'turn/start')).toHaveLength(1);
  });

  it('retries a completed app-server turn without an agent message once', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const methods = stubCompletedAppServerTurns(provider, [null, 'Recovered memory']);
    const result = await provider.query([{ role: 'user', content: 'input' }], config);
    expect(result.content).toBe('Recovered memory');
    expect(methods.filter(method => method === 'turn/start')).toHaveLength(2);
  });

  it('retries blank structured output once and reports bounded diagnostics if it stays blank', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const methods = stubCompletedAppServerTurns(provider, [' ', ' ']);
    const error = await provider.query([{ role: 'user', content: 'input' }], config)
      .then(() => null, (caught: unknown) => caught);
    expect(error).toHaveProperty('kind', 'transient');
    expect((error as Error).message).toContain('agentMessages=1');
    expect((error as Error).message).toContain('finalTextBytes=15');
    expect((error as Error).message).not.toContain('"content"');
    expect(methods.filter(method => method === 'turn/start')).toHaveLength(2);
  });

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

  for (const kind of ['unrecoverable', 'auth_invalid']) {
    it(`pauses repeated starts after ${kind} and re-arms a failed setup probe`, async () => {
      const h = harness(async () => { throw new ClassifiedProviderError('setup fixture', { kind, cause: null }); });
      await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'first');
      await h.s.generatorPromise;
      await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'second');
      expect(h.codex).toHaveBeenCalledTimes(1);
      expect(h.reset).toHaveBeenCalledTimes(1);
      expect(getQuotaCooldown('codex')).toBeNull();
      recordQuotaExhausted('codex-setup', 'fixture', undefined, Date.now() - CODEX_SETUP_RECHECK_COOLDOWN_MS - 1);
      await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'probe');
      await h.s.generatorPromise;
      await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'third');
      expect(h.codex).toHaveBeenCalledTimes(2);
      expect(getQuotaCooldown('codex-setup')?.probeClaimId).toBeNull();
      expect(tryAdmitQuotaProbe('codex-setup', Date.now(), CODEX_SETUP_RECHECK_COOLDOWN_MS).admitted).toBe(false);
      expect(h.finalize).not.toHaveBeenCalled();
      expect(h.other).not.toHaveBeenCalled();
    });
  }

  it('admits only one setup probe and clears setup cooldown on successful generation', async () => {
    recordQuotaExhausted('codex-setup', 'fixture', undefined, Date.now() - CODEX_SETUP_RECHECK_COOLDOWN_MS - 1);
    const provider = new CodexProvider(null as any, null as any) as any;
    let release!: () => void;
    provider.appServer.runTurn = () => new Promise(resolve => { release = () => resolve({ content: '' }); });
    const h = harness(async () => { await provider.query([{ role: 'user', content: 'input' }], config); });
    const other = harness(async () => {});
    await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'probe');
    await other.routes.ensureGeneratorRunning(other.s.sessionDbId, 'concurrent');
    expect(other.codex).not.toHaveBeenCalled();
    release();
    await h.s.generatorPromise;
    expect(getQuotaCooldown('codex-setup')).toBeNull();
    expect(tryAdmitQuotaProbe('codex-setup').admitted).toBe(true);
  });

  it('releases a setup probe when admission setup throws', async () => {
    recordQuotaExhausted('codex-setup', 'fixture', undefined, Date.now() - CODEX_SETUP_RECHECK_COOLDOWN_MS - 1);
    const h = harness(async () => {});
    (h.routes as any).applyTierRouting = async () => { throw new Error('routing fixture'); };
    await expect(h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'probe')).rejects.toThrow('routing fixture');
    expect(h.codex).not.toHaveBeenCalled();
    expect(getQuotaCooldown('codex-setup')?.probeClaimId).toBeNull();
  });

  it('releases a setup probe on an unrelated transient failure', async () => {
    recordQuotaExhausted('codex-setup', 'fixture', undefined, Date.now() - CODEX_SETUP_RECHECK_COOLDOWN_MS - 1);
    const h = harness(async () => { throw new ClassifiedProviderError('network fixture', { kind: 'transient', cause: null }); });
    await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'probe');
    await h.s.generatorPromise;
    expect(getQuotaCooldown('codex-setup')?.probeClaimId).toBeNull();
    expect(tryAdmitQuotaProbe('codex-setup', Date.now(), CODEX_SETUP_RECHECK_COOLDOWN_MS).admitted).toBe(true);
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

  for (const message of ['Codex executable not found', 'not logged in']) {
    it(`blocks already queued sessions before startup after ${message}`, async () => {
      const provider = new CodexProvider(null as any, null as any) as any;
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const starts = mock(async () => { await blocked; throw new Error(message); });
      // Keep the real client queue and failure callback; only replace process startup.
      for (const client of provider.appServer.clients) client.ensureStarted = starts;
      const runs = Array.from({ length: 3 }, () => harness(async s => {
        const c = { ...config };
        provider.prepareSessionExtras(s, c);
        await provider.query([{ role: 'user', content: 'input' }], c);
      }));
      try {
        for (const h of runs) await h.routes.ensureGeneratorRunning(h.s.sessionDbId, 'queued');
        expect(runs.every(h => h.codex.mock.calls.length === 1)).toBe(true);
        release();
        await Promise.all(runs.map(h => h.s.generatorPromise));
        expect(starts).toHaveBeenCalledTimes(2);
        expect(getQuotaCooldown('codex-setup')).not.toBeNull();
        expect(getQuotaCooldown('codex')).toBeNull();
        for (const h of runs) {
          expect(h.reset).toHaveBeenCalledTimes(1);
          expect(h.finalize).not.toHaveBeenCalled();
          expect(h.other).not.toHaveBeenCalled();
        }
        recordQuotaExhausted('codex-setup', 'fixture', undefined, Date.now() - CODEX_SETUP_RECHECK_COOLDOWN_MS - 1);
        await runs[0].routes.ensureGeneratorRunning(runs[0].s.sessionDbId, 'recovery');
        await runs[0].s.generatorPromise;
        expect(starts).toHaveBeenCalledTimes(3);
        expect(getQuotaCooldown('codex-setup')?.probeClaimId).toBeNull();
      } finally {
        release();
        await provider.close();
      }
    });
  }

  it('allows only the owned setup probe through send admission and clears it on success', async () => {
    recordQuotaExhausted('codex-setup', 'fixture', undefined, Date.now() - CODEX_SETUP_RECHECK_COOLDOWN_MS - 1);
    const claim = tryAdmitQuotaProbe('codex-setup', Date.now(), CODEX_SETUP_RECHECK_COOLDOWN_MS);
    const provider = new CodexProvider(null as any, null as any) as any;
    const sends = mock(async (options: any) => { options.beforeSend(); return { content: '' }; });
    provider.appServer.runTurn = sends;
    const s = session();
    s.codexSetupProbeClaimId = claim.claimId;
    const c = { ...config };
    provider.prepareSessionExtras(s, c);
    await expect(provider.query([{ role: 'user', content: 'input' }], config)).rejects.toMatchObject({ kind: 'setup_paused' });
    expect(getQuotaCooldown('codex-setup')?.probeClaimId).toBe(claim.claimId);
    await provider.query([{ role: 'user', content: 'probe' }], c);
    expect(getQuotaCooldown('codex-setup')).toBeNull();
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

  it('cancels a compression request while the session signal remains active', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const sessionController = new AbortController();
    const compressionController = new AbortController();
    const c = { ...config, signal: sessionController.signal };
    let started!: () => void;
    let nativeSignal: AbortSignal | undefined;
    const ready = new Promise<void>(resolve => { started = resolve; });
    provider.appServer.runTurn = (options: any) => new Promise((_, reject) => {
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

  for (const [message, kind] of [
    ['Codex executable not found', 'unrecoverable'], ['not logged in', 'auth_invalid'],
    ['usage limit reached', 'quota_exhausted'], ['429 rate limit', 'rate_limit'],
    ['context window exceeded', 'context_overflow'], ['connection closed', 'transient'],
  ]) {
    it(`classifies ${kind} transport failures`, () => {
      expect(classifyCodexError(new Error(message)).kind).toBe(kind);
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

  it('arms the quota cooldown without retrying a structured usage-limit failure', async () => {
    const provider = new CodexProvider(null as any, null as any) as any;
    const sends = mock(async () => {
      throw Object.assign(new Error('Codex app-server reported an error'), { codexErrorInfo: 'usageLimitExceeded' });
    });
    provider.appServer.runTurn = sends;
    try {
      await expect(provider.query([{ role: 'user', content: 'input' }], { ...config }))
        .rejects.toMatchObject({ kind: 'quota_exhausted' });
      expect(sends).toHaveBeenCalledTimes(1);
      expect(getQuotaCooldown('codex')).not.toBeNull();
      expect(getQuotaCooldown('codex-setup')).toBeNull();
    } finally {
      await provider.close();
    }
  });
});
