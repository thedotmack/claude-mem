import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { GeminiProvider } from '../../src/services/worker/GeminiProvider.js';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { CodexProvider } from '../../src/services/worker/CodexProvider.js';
import { ClaudeProvider } from '../../src/services/worker/ClaudeProvider.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { FieldCompressionError, optimizeObservationFields } from '../../src/services/worker/field-optimizer.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { getQuotaCooldown, resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';

// Use the installed SDK, with only its child process replaced by in-memory pipes.
const { query: sdkQuery } = await import(new URL('../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', import.meta.url).href);
const modeManager = ModeManager.getInstance() as { loadMode?: (mode: string) => unknown };
modeManager.loadMode?.('code');
const originalFetch = globalThis.fetch;
beforeEach(() => resetQuotaCooldownsForTesting());
afterEach(() => { globalThis.fetch = originalFetch; resetQuotaCooldownsForTesting(); });

function session(provider = 'codex'): any {
  return { sessionDbId: 994, contentSessionId: 'fixture', memorySessionId: 'fixture', project: 'fixture',
    userPrompt: 'fixture', platformSource: provider, abortController: new AbortController(), generatorPromise: null,
    lastPromptNumber: 1, conversationHistory: [], startTime: Date.now(), cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0, claimedMessageIds: [1], currentProvider: provider, consecutiveContextOverflows: 0 };
}

describe('Claude SDK prompt-stream failure recovery', () => {
  for (const failure of [
    new FieldCompressionError('incomplete chunk reduction'),
    new ClassifiedProviderError('quota exhausted', { kind: 'quota_exhausted', cause: null }),
    new ClassifiedProviderError('authentication failed', { kind: 'auth_invalid', cause: null }),
    new DOMException('field request timed out', 'TimeoutError'),
  ]) {
    it(`preserves the batch when the real SDK aborts on ${failure.name}:${failure.message}`, async () => {
      const s = session('claude');
      const reset = mock(async () => 1);
      const finalize = mock(async () => {});
      const manager: any = { getSession: () => s, resetProcessingToPending: reset,
        getMessageIterator: async function* () {
          yield { type: 'observation', tool_name: 'fixture', tool_input: 'x'.repeat(17000), tool_response: '' };
        },
        getMessageBuffer: () => ({ getPendingCount: () => 1 }), removeSessionImmediate: mock(() => {}) };
      const provider = new ClaudeProvider(null as any, manager) as any;
      const sdkAgent = { startSession: async () => {
        const child: any = new EventEmitter();
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.pid = 99999999; child.killed = false; child.exitCode = null;
        child.kill = () => {
          child.killed = true; child.exitCode = 0;
          child.stdout.end(); child.stderr.end();
          queueMicrotask(() => { child.emit('exit', 0, null); child.emit('close', 0, null); });
          return true;
        };
        const prompt = provider.createMessageGenerator(s, {}, { current: {} }, undefined, async () => { throw failure; });
        const output = sdkQuery({ prompt, options: { abortController: s.abortController,
          pathToClaudeCodeExecutable: '/nonexistent/fixture', spawnClaudeCodeProcess: () => child } });
        try { for await (const _message of output) {} } finally { output.close(); child.kill(); }
      } };
      const routes = new SessionRoutes(manager, {} as any, sdkAgent as any, {} as any, {} as any,
        {} as any, {} as any, {} as any, { finalizeSession: finalize } as any) as any;
      await routes.startGeneratorWithProvider(s, 'claude', 'fixture', null, null);
      await s.generatorPromise;
      expect(s.abortController.signal.aborted).toBe(true);
      expect(s.abortController.signal.reason).toBe(failure);
      expect(reset).toHaveBeenCalledTimes(1);
      expect(finalize).not.toHaveBeenCalled();
      expect(s.generatorPromise).toBeNull();
      if (failure instanceof ClassifiedProviderError && failure.kind === 'quota_exhausted') {
        expect(getQuotaCooldown('claude')).not.toBeNull();
      }
    });
  }

  it('keeps explicit shutdown cancellation on the normal finalization path', async () => {
    const s = session('claude');
    const reset = mock(async () => 1);
    const finalize = mock(async () => {});
    const manager = { getSession: () => s, resetProcessingToPending: reset,
      getMessageBuffer: () => ({ getPendingCount: () => 1 }), removeSessionImmediate: mock(() => {}) };
    const agent = { startSession: async () => {
      s.abortReason = 'shutdown'; s.abortController.abort(); throw s.abortController.signal.reason;
    } };
    const routes = new SessionRoutes(manager as any, {} as any, agent as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, { finalizeSession: finalize } as any) as any;
    await routes.startGeneratorWithProvider(s, 'claude', 'fixture', null, null);
    await s.generatorPromise;
    expect(reset).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});

it('retains init refusal recycle debt until the bounded overflow pause', async () => {
  const resets = mock(async () => 1);
  const provider = new CodexProvider(null as any, { resetProcessingToPending: resets } as any) as any;
  provider.query = mock(async () => ({ content: 'Prompt is too long' }));
  const s = session();
  for (let i = 1; i <= 3; i++) {
    s.abortController = new AbortController();
    await provider.startSession(s);
    expect(s.consecutiveContextOverflows).toBe(i);
    expect(s.abortReason).toBe(i < 3 ? 'overflow:recycle' : 'overflow:exhausted');
  }
  expect(s.overflowPausedUntilMs).toBeGreaterThan(Date.now());
  expect(resets).toHaveBeenCalledTimes(3);
  const routes = new SessionRoutes({ getSession: () => s } as any, {} as any, {} as any, {} as any,
    {} as any, provider, {} as any, {} as any, {} as any);
  await routes.ensureGeneratorRunning(s.sessionDbId, 'overflow-recycle');
  expect(provider.query).toHaveBeenCalledTimes(3);
});

const providers = [
  ['gemini', GeminiProvider, { apiKey: 'fixture', model: 'gemini-flash-latest', rateLimitingEnabled: false }],
  ['openrouter', OpenRouterProvider, { apiKey: 'fixture', model: 'fixture', apiUrl: 'https://fixture.invalid/chat/completions' }],
] as const;

function responseFor(provider: string, text: string): Response {
  return new Response(JSON.stringify(provider === 'gemini'
    ? { candidates: [{ content: { parts: [{ text }] } }] }
    : { choices: [{ message: { content: text } }] }), { status: 200 });
}

for (const [name, Provider, config] of providers) {
  describe(`${name} auxiliary transport cancellation`, () => {
    it('preserves real transport quota exhaustion and does not retry it', async () => {
      const fetchMock = mock(async () => new Response(JSON.stringify({ error: { message: 'quota exceeded', status: 'RESOURCE_EXHAUSTED' } }),
        { status: name === 'gemini' ? 429 : 402 }));
      globalThis.fetch = fetchMock as any;
      const provider = new Provider(null as any, null as any) as any;
      const s = session(name);
      await expect(provider.compressField('source', 1000, config, s.abortController.signal, s)).rejects.toMatchObject({ kind: 'quota_exhausted' });
      expect(getQuotaCooldown(name)).not.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('preserves real transport authentication failure and does not retry it', async () => {
      const fetchMock = mock(async () => new Response('authentication failed', { status: 401 }));
      globalThis.fetch = fetchMock as any;
      const provider = new Provider(null as any, null as any) as any;
      const s = session(name);
      await expect(provider.compressField('source', 1000, config, s.abortController.signal, s)).rejects.toMatchObject({ kind: 'auth_invalid' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('aborts active fetch on optimizer timeout and makes no retry', async () => {
      let actualSignal: AbortSignal | undefined;
      let active = 0;
      const fetchMock = mock(async (_url: any, options: any) => {
        actualSignal = options.signal;
        active++;
        return new Promise<Response>((_, reject) => {
          actualSignal!.addEventListener('abort', () => { active--; reject(actualSignal!.reason); }, { once: true });
        });
      });
      globalThis.fetch = fetchMock as any;
      const s = session(name);
      const provider = new Provider(null as any, null as any) as any;
      await expect(optimizeObservationFields({ toolInput: 'x'.repeat(17000), toolOutput: '' },
        (text, budget, { signal }) => provider.compressField(text, budget, config, signal, s),
        { sessionDbId: s.sessionDbId }, undefined, { signal: s.abortController.signal, timeoutMs: 15 }))
        .rejects.toMatchObject({ name: 'TimeoutError' });
      await Bun.sleep(20);
      expect(actualSignal?.aborted).toBe(true);
      expect(active).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(s.abortController.signal.aborted).toBe(false);
    });

    for (const content of [
      'The application session limit is now configurable. Tests confirm the setting is enforced.',
      'The authentication failed error in the application was resolved by refreshing its session.',
    ]) {
      it(`accepts successful source condensation: ${content}`, async () => {
        globalThis.fetch = mock(async () => responseFor(name, content)) as any;
        const provider = new Provider(null as any, null as any) as any;
        const s = session(name);
        await expect(provider.compressField('application source evidence', 1000, config, s.abortController.signal, s)).resolves.toBe(content);
        expect(getQuotaCooldown(name)).toBeNull();
      });
    }
  });
}

it('cancels the Gemini rate-limit wait before fetch', async () => {
  const provider = new GeminiProvider(null as any, null as any) as any;
  const config = { apiKey: 'fixture', model: 'gemini-flash-latest', rateLimitingEnabled: true };
  const fetchMock = mock(async () => responseFor('gemini', 'fixture'));
  globalThis.fetch = fetchMock as any;
  await provider.query([], config);
  const controller = new AbortController();
  const request = provider.query([], config, controller.signal);
  controller.abort();
  await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('accepts successful Codex condensation but retains observer refusal classification', async () => {
  const provider = new CodexProvider(null as any, null as any) as any;
  const content = 'The application session limit is now configurable; authentication failed is a tested application error.';
  provider.appServer.runTurn = mock(async () => ({ content }));
  const s = session();
  const config = { apiKey: 'native', model: 'fixture', codexPath: 'fixture', maxEstimatedTokens: 100000, timeoutMs: 1000 };
  await expect(provider.compressField('application source evidence', 1000, config, s.abortController.signal, s)).resolves.toBe(content);
  expect(getQuotaCooldown('codex')).toBeNull();
  provider.appServer.runTurn = mock(async () => ({ content: "You've hit your session limit." }));
  await expect(provider.query([], config)).rejects.toMatchObject({ kind: 'quota_exhausted' });
  expect(getQuotaCooldown('codex')).not.toBeNull();
});
