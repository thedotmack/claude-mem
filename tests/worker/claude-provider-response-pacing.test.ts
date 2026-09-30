import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import type { ActiveSession } from '../../src/services/worker-types.js';

// #4066: the Claude feed claimed and yielded a whole backlog before the model
// answered anything, so the generation budget tripped on unanswered prompts and
// every recycle re-claimed the same oldest batch. These tests drive the real
// ClaudeProvider, SessionManager and SessionMessageBuffer against a fake SDK that
// pulls the prompt stream EAGERLY — the way the real one does — so an unpaced
// feed shows up as a burst instead of hiding behind a lazy consumer.

// bun's mock.module is process-global and sticky; snapshot each real module and
// restore it in afterAll so later suites keep the real implementations.
const actualAgentSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
const actualFindClaude = { ...(await import('../../src/shared/find-claude-executable.js')) };
const actualEnvManager = { ...(await import('../../src/shared/EnvManager.js')) };
const actualProcessRegistry = { ...(await import('../../src/supervisor/process-registry.js')) };
const actualModeManager = { ...(await import('../../src/services/domain/ModeManager.js')) };
const actualContextGenerator = { ...(await import('../../src/services/context-generator.js')) };

class FakeSdk {
  readonly prompts: string[] = [];
  private outbox: unknown[] = [];
  private ended = false;
  private inputDone = false;
  private wakeStream: (() => void) | null = null;
  private progressWaiters: Array<() => void> = [];

  constructor(prompt: AsyncIterable<any>, signal: AbortSignal | undefined) {
    signal?.addEventListener('abort', () => this.end(), { once: true });
    void this.pump(prompt);
  }

  /** Pull the next prompt the moment the previous one has been taken. */
  private async pump(prompt: AsyncIterable<any>): Promise<void> {
    const iterator = prompt[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        this.inputDone = true;
        this.notify();
        return;
      }
      this.prompts.push(String(next.value.message.content));
      this.notify();
    }
  }

  get inputFinished(): boolean {
    return this.inputDone;
  }

  /** One complete turn: a text frame and the result frame that closes it. */
  answer(text: string, result: Record<string, unknown> = {}): void {
    this.outbox.push(
      { type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 2 } } },
      { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 2 }, ...result },
    );
    this.wakeStream?.();
  }

  /**
   * A complete turn the stream has buffered but not yet delivered: it surfaces
   * only when something else wakes the stream, e.g. the abort that ends it.
   */
  bufferAnswer(text: string): void {
    this.outbox.push(
      { type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 2 } } },
      { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 2 } },
    );
  }

  /** A turn that failed before emitting any text. */
  failTurn(): void {
    this.outbox.push({ type: 'result', subtype: 'error_during_execution', is_error: true });
    this.wakeStream?.();
  }

  end(): void {
    this.ended = true;
    this.wakeStream?.();
    this.notify();
  }

  async *stream(): AsyncGenerator<unknown> {
    while (true) {
      while (this.outbox.length > 0) yield this.outbox.shift();
      if (this.ended || this.inputDone) return;
      await new Promise<void>(resolve => { this.wakeStream = resolve; });
      this.wakeStream = null;
    }
  }

  private notify(): void {
    const waiters = this.progressWaiters;
    this.progressWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Resolve once `predicate` holds, failing the test instead of hanging bun. */
  async until(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for: ${label}`);
      await Promise.race([
        new Promise<void>(resolve => this.progressWaiters.push(resolve)),
        new Promise<void>(resolve => setTimeout(resolve, Math.min(remaining, 20))),
      ]);
    }
  }
}

let currentSdk: FakeSdk | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...actualAgentSdk,
  query: ({ prompt, options }: { prompt: AsyncIterable<any>; options?: { abortController?: AbortController } }) => {
    currentSdk = new FakeSdk(prompt, options?.abortController?.signal);
    return currentSdk.stream();
  },
}));

mock.module('../../src/shared/find-claude-executable.js', () => ({
  ...actualFindClaude,
  findClaudeExecutable: () => '/mock/claude',
}));

mock.module('../../src/shared/EnvManager.js', () => ({
  ...actualEnvManager,
  buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH ?? '' }),
  getAuthMethodDescription: () => 'test-auth',
}));

mock.module('../../src/supervisor/process-registry.js', () => ({
  ...actualProcessRegistry,
  waitForSlot: async () => ({ release: () => {} }),
  createSdkSpawnFactory: () => () => {
    throw new Error('spawn factory must not run in this test');
  },
  getSdkProcessForSession: () => undefined,
  ensureSdkProcessExit: async () => {},
}));

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ...actualModeManager,
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
        observation_types: [{ id: 'discovery' }],
        observation_concepts: [],
      }),
    }),
  },
}));

mock.module('../../src/services/context-generator.js', () => ({
  ...actualContextGenerator,
  generateContext: async () => '',
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => actualAgentSdk);
  mock.module('../../src/shared/find-claude-executable.js', () => actualFindClaude);
  mock.module('../../src/shared/EnvManager.js', () => actualEnvManager);
  mock.module('../../src/supervisor/process-registry.js', () => actualProcessRegistry);
  mock.module('../../src/services/domain/ModeManager.js', () => actualModeManager);
  mock.module('../../src/services/context-generator.js', () => actualContextGenerator);
});

const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');
const { SessionManager } = await import('../../src/services/worker/SessionManager.js');
const {
  ObserverResponsePacer,
  MAX_CONSECUTIVE_STALL_RESUMES,
  planResponseStallResume,
} = await import('../../src/services/worker/session/response-pacer.js');
const { MAX_CONSECUTIVE_RECYCLES } = await import('../../src/services/worker/session/recycle-conversation.js');

const SESSION_ID = 4066;
const SKIP_REPLY = 'Nothing worth recording in this tool call.';

function createSession(): ActiveSession {
  return {
    sessionDbId: SESSION_ID,
    contentSessionId: 'content-4066',
    memorySessionId: null,
    project: 'observer-project',
    platformSource: 'claude',
    userPrompt: 'work through the backlog',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 2,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: [],
    currentProvider: 'claude',
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  } as ActiveSession;
}

function createHarness(backlog: number, payloadChars = 200) {
  const dbManager = {
    getSessionById: () => ({ project: 'observer-project', memory_session_id: null }),
    getSessionStore: () => ({
      ensureMemorySessionIdRegistered: (_id: number, memoryId: string) => memoryId,
      updateMemorySessionId: () => {},
    }),
    getChromaSync: () => null,
    getCloudSync: () => null,
  };
  const sessionManager = new SessionManager(dbManager as never);
  const session = createSession();
  (sessionManager as any).sessions.set(SESSION_ID, session);

  const buffer = sessionManager.getMessageBuffer();
  for (let i = 0; i < backlog; i++) {
    buffer.enqueue(SESSION_ID, {
      type: 'observation',
      tool_name: 'Bash',
      tool_input: { command: `step ${i}` },
      tool_response: `${i}:`.padEnd(payloadChars, 'x'),
      prompt_number: 2,
      toolUseId: `toolu_${i}`,
    });
  }

  const provider = new ClaudeProvider(dbManager as never, sessionManager as never);
  return {
    session,
    sessionManager,
    provider,
    pending: () => buffer.getPendingCount(SESSION_ID),
  };
}

function sdk(): FakeSdk {
  if (!currentSdk) throw new Error('query() was never called');
  return currentSdk;
}

/** startSession reaches query() only after its own awaits (settings, OAuth). */
async function sdkStarted(previous: FakeSdk | null = null, timeoutMs = 10_000): Promise<FakeSdk> {
  const deadline = Date.now() + timeoutMs;
  while (!currentSdk || currentSdk === previous) {
    if (Date.now() > deadline) throw new Error('query() was never called');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return currentSdk;
}

/** Give an unpaced feed every chance to run ahead before asserting it did not. */
function settle(ms = 30): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 2_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${label}`)), ms)),
  ]);
}

let liveSessions: ActiveSession[] = [];

beforeEach(() => {
  currentSdk = null;
  liveSessions = [];
});

afterEach(() => {
  // Release any generator still parked on the pacer so nothing outlives the test.
  for (const session of liveSessions) session.abortController.abort();
});

describe('Claude observer feed pacing (#4066)', () => {
  it('holds every claim until the previous prompt has been answered', async () => {
    const h = createHarness(200);
    liveSessions.push(h.session);
    const run = h.provider.startSession(h.session);
    await sdkStarted();

    await sdk().until(() => sdk().prompts.length >= 1, 'init prompt');
    await settle();
    // Only the init prompt is out; the backlog is untouched.
    expect(sdk().prompts.length).toBe(1);
    expect(h.session.claimedMessageIds.length).toBe(0);
    expect(h.pending()).toBe(200);

    for (let turn = 1; turn <= 5; turn++) {
      sdk().answer(SKIP_REPLY);
      await sdk().until(() => sdk().prompts.length >= turn + 1, `prompt ${turn + 1}`);
      await settle();
      // Exactly one more message claimed and sent per answered turn.
      expect(sdk().prompts.length).toBe(turn + 1);
      expect(h.session.claimedMessageIds.length).toBe(1);
      // Each answered observation turn confirmed exactly its own message.
      expect(h.pending()).toBe(200 - (turn - 1));
    }

    h.session.abortController.abort();
    await withTimeout(run, 'startSession after abort');
  });

  it('a failed turn still releases the feed, and its message is re-sent', async () => {
    const h = createHarness(3);
    liveSessions.push(h.session);
    const run = h.provider.startSession(h.session);
    await sdkStarted();

    await sdk().until(() => sdk().prompts.length >= 1, 'init prompt');
    sdk().answer(SKIP_REPLY);
    await sdk().until(() => sdk().prompts.length >= 2, 'first observation');
    const firstClaim = h.session.claimedMessageIds[0];
    expect(sdk().prompts[1]).toContain('step 0');

    // No text, error result: ClaudeProvider re-queues the batch without ever
    // calling processAgentResponse. The feed must still move on.
    sdk().failTurn();
    await sdk().until(() => sdk().prompts.length >= 3, 're-sent observation');
    expect(sdk().prompts[2]).toContain('step 0');
    expect(h.session.claimedMessageIds).toEqual([firstClaim]);
    expect(h.pending()).toBe(3);

    h.session.abortController.abort();
    await withTimeout(run, 'startSession after abort');
  });

  it('a backlog far over the budget makes progress instead of recycling on an unanswered burst', async () => {
    // 200 x ~4k chars is ~800k chars of prompts — twice the 400k default budget.
    const h = createHarness(200, 4_000);
    liveSessions.push(h.session);
    const recycleLog: Array<{ answeredTurns: number; claimed: number; history: number }> = [];

    let answeredTurns = 0;
    const runGeneration = async () => {
      const previous = currentSdk;
      const run = h.provider.startSession(h.session);
      await sdkStarted(previous);
      await sdk().until(() => sdk().prompts.length >= 1, 'init prompt');
      let sent = 1;
      let answeredThisGeneration = 0;
      while (true) {
        sdk().answer(SKIP_REPLY);
        answeredTurns += 1;
        answeredThisGeneration += 1;
        await sdk().until(
          () => sdk().prompts.length > sent || h.session.abortController.signal.aborted || sdk().inputFinished,
          `prompt ${sent + 1}`,
        );
        if (sdk().prompts.length > sent) {
          sent = sdk().prompts.length;
          // Never more than one unanswered prompt in flight.
          expect(sent).toBe(answeredThisGeneration + 1);
          continue;
        }
        break;
      }
      recycleLog.push({
        answeredTurns,
        claimed: h.session.claimedMessageIds.length,
        history: h.session.conversationHistory.length,
      });
      await withTimeout(run, 'generation end');
    };

    await runGeneration();
    const pendingAfterFirst = h.pending();

    // The budget did fire — but only after many answered turns, never on a burst.
    expect(h.session.forceInit).toBe(true);
    expect(recycleLog[0].answeredTurns).toBeGreaterThan(20);
    // Everything answered was confirmed; only unanswered work stays pending.
    expect(pendingAfterFirst).toBeLessThan(200 - 20);
    expect(h.session.overflowPausedUntilMs).toBeUndefined();

    // A fresh generation continues from where the last stopped rather than
    // re-claiming the same oldest batch.
    h.session.abortController = new AbortController();
    h.session.abortReason = null;
    const turnsBefore = answeredTurns;
    await runGeneration();
    expect(answeredTurns - turnsBefore).toBeGreaterThan(20);
    expect(h.pending()).toBeLessThan(pendingAfterFirst - 20);
    // Answered turns reset the recycle counter, so it never reaches the
    // exhausted pause that wedged #4066.
    expect(h.session.consecutiveContextOverflows).toBeLessThanOrEqual(1);
    expect(h.session.overflowPausedUntilMs).toBeUndefined();
  });

  it('an abort while waiting for an answer ends the generator and keeps the claimed message', async () => {
    const h = createHarness(5);
    liveSessions.push(h.session);
    const generator = (h.provider as any).createMessageGenerator(
      h.session,
      { lastCwd: undefined },
      { current: null },
      undefined,
      undefined,
      new ObserverResponsePacer(),
    ) as AsyncIterableIterator<{ message: { content: string } }>;

    const init = await withTimeout(generator.next(), 'init prompt');
    expect(init.done).toBe(false);

    // Parked on the pacer: nothing answers the init prompt.
    const parked = generator.next();
    await settle();
    expect(h.session.claimedMessageIds.length).toBe(0);

    h.session.abortController.abort();
    const ended = await withTimeout(parked, 'generator after abort', 5_000);
    expect(ended.done).toBe(true);
    expect(h.pending()).toBe(5);
  });

  it('an abort mid-generation leaves the claimed message pending for the next generation', async () => {
    const h = createHarness(5);
    liveSessions.push(h.session);
    const run = h.provider.startSession(h.session);
    await sdkStarted();

    await sdk().until(() => sdk().prompts.length >= 1, 'init prompt');
    sdk().answer(SKIP_REPLY);
    await sdk().until(() => sdk().prompts.length >= 2, 'first observation');
    const claimedId = h.session.claimedMessageIds[0];
    expect(claimedId).toBeDefined();

    h.session.abortController.abort();
    await withTimeout(run, 'startSession after abort', 1_000);
    expect(h.pending()).toBe(5);

    // The next generation re-yields the same message rather than losing it.
    h.session.abortController = new AbortController();
    liveSessions.push(h.session);
    const iterator = h.sessionManager.getMessageIterator(SESSION_ID);
    const next = await withTimeout(iterator.next(), 'reclaim');
    expect(next.value?._persistentId).toBe(claimedId);
    h.session.abortController.abort();
    await iterator.return?.(undefined);
  });

  it('a restart does not let the init reply confirm a claim left by the previous generation', async () => {
    const h = createHarness(5);
    liveSessions.push(h.session);

    // A previous generation claimed a message and ended without resetting it,
    // the way the quota-guard break does.
    const stale = h.sessionManager.getMessageIterator(SESSION_ID);
    const claimed = await withTimeout(stale.next(), 'stale claim');
    await stale.return?.(undefined);
    const staleId = claimed.value!._persistentId;
    expect(h.session.claimedMessageIds).toEqual([staleId]);

    const run = h.provider.startSession(h.session);
    await sdkStarted();
    await sdk().until(() => sdk().prompts.length >= 1, 'init prompt');
    sdk().answer(SKIP_REPLY);
    await sdk().until(() => sdk().prompts.length >= 2, 'first observation');

    // Still in the buffer, and re-sent as the first observation.
    expect(h.pending()).toBe(5);
    expect(sdk().prompts[1]).toContain('step 0');
    expect(h.session.claimedMessageIds).toEqual([staleId]);

    h.session.abortController.abort();
    await withTimeout(run, 'startSession after abort');
  });

  it('init replies do not clear the overflow debt, so a budget too small for one observation reaches the exhausted pause', async () => {
    const h = createHarness(5);
    liveSessions.push(h.session);
    // Smaller than the init prompt plus one observation.
    (h.provider as any).conversationMaxChars = () => 10;

    let previous: FakeSdk | null = null;
    for (let generation = 1; generation <= MAX_CONSECUTIVE_RECYCLES + 1; generation++) {
      h.session.abortController = new AbortController();
      h.session.abortReason = null;
      const run = h.provider.startSession(h.session);
      previous = await sdkStarted(previous);
      await sdk().until(() => sdk().prompts.length >= 1, `init prompt ${generation}`);
      sdk().answer(SKIP_REPLY);
      await withTimeout(run, `generation ${generation}`);
      // The init reply was accepted, yet the debt keeps counting.
      expect(h.session.consecutiveContextOverflows).toBe(generation);
      expect(sdk().prompts.length).toBe(1);
    }

    expect(h.session.consecutiveContextOverflows).toBeGreaterThan(MAX_CONSECUTIVE_RECYCLES);
    expect(h.session.abortReason).toBe('overflow:exhausted');
    expect(h.session.overflowPausedUntilMs).toBeGreaterThan(Date.now());
    expect(h.pending()).toBe(5);
  });

  it('only a reply to queued work clears the overflow and stall debts', async () => {
    const h = createHarness(3);
    liveSessions.push(h.session);
    h.session.consecutiveContextOverflows = 1;
    h.session.consecutiveResponseStalls = 2;

    const run = h.provider.startSession(h.session);
    await sdkStarted();
    await sdk().until(() => sdk().prompts.length >= 1, 'init prompt');
    sdk().answer(SKIP_REPLY);
    await sdk().until(() => sdk().prompts.length >= 2, 'first observation');
    expect(h.session.consecutiveContextOverflows).toBe(1);
    expect(h.session.consecutiveResponseStalls).toBe(2);

    sdk().answer(SKIP_REPLY);
    await sdk().until(() => sdk().prompts.length >= 3, 'second observation');
    expect(h.session.consecutiveContextOverflows).toBe(0);
    expect(h.session.consecutiveResponseStalls).toBe(0);

    h.session.abortController.abort();
    await withTimeout(run, 'startSession after abort');
  });
  it('a reply that lands after a response stall is dropped, so the re-sent message is not stored twice', async () => {
    const h = createHarness(2);
    liveSessions.push(h.session);
    (h.provider as any).responseStallMs = () => 50;
    const run = h.provider.startSession(h.session);
    await sdkStarted();

    await sdk().until(() => sdk().prompts.length >= 1, 'init prompt');
    sdk().answer(SKIP_REPLY);
    await sdk().until(() => sdk().prompts.length >= 2, 'first observation');
    expect(h.session.claimedMessageIds.length).toBe(1);

    // The answer is already in the stream when the stall fires; the stall's own
    // abort is what flushes it out. Processing it would confirm or store a turn
    // whose claim the stall just handed back for re-sending.
    const LATE_REPLY = 'late reply that arrived after the stall';
    sdk().bufferAnswer(LATE_REPLY);
    await withTimeout(run, 'startSession after stall', 5_000);

    expect(h.session.abortReason).toBe('transport:response_stall');
    expect(h.session.conversationHistory.some(m => m.role === 'assistant' && m.content === LATE_REPLY)).toBe(false);
    expect(h.session.claimedMessageIds).toEqual([]);
    expect(h.pending()).toBe(2);
  });
});

describe('ObserverResponsePacer', () => {
  it('resolves for an answer that landed before the wait began', async () => {
    const pacer = new ObserverResponsePacer();
    const mark = pacer.mark();
    pacer.answer();
    expect(await pacer.waitForAnswer(mark, new AbortController().signal, 1_000)).toBe('answered');
  });

  it('reports a stall once the window passes without an answer', async () => {
    const pacer = new ObserverResponsePacer();
    expect(await pacer.waitForAnswer(pacer.mark(), new AbortController().signal, 10)).toBe('stalled');
  });

  it('fences late frames only after a stall', async () => {
    const answered = new ObserverResponsePacer();
    const mark = answered.mark();
    answered.answer();
    await answered.waitForAnswer(mark, new AbortController().signal, 1_000);
    expect(answered.hasStalled).toBe(false);

    const stalling = new ObserverResponsePacer();
    expect(await stalling.waitForAnswer(stalling.mark(), new AbortController().signal, 10)).toBe('stalled');
    expect(stalling.hasStalled).toBe(true);
  });

  it('releases a waiter when the stream closes or the signal aborts', async () => {
    const closing = new ObserverResponsePacer();
    const closed = closing.waitForAnswer(closing.mark(), new AbortController().signal, 1_000);
    closing.close();
    expect(await closed).toBe('closed');

    const aborting = new ObserverResponsePacer();
    const controller = new AbortController();
    const aborted = aborting.waitForAnswer(aborting.mark(), controller.signal, 1_000);
    controller.abort();
    expect(await aborted).toBe('aborted');
  });

  it('SDK activity restarts the stall window instead of counting from the prompt', async () => {
    const pacer = new ObserverResponsePacer();
    let outcome: string | null = null;
    const waiting = pacer.waitForAnswer(pacer.mark(), new AbortController().signal, 60)
      .then(result => { outcome = result; return result; });

    // Keep streaming for well past the window.
    for (let i = 0; i < 6; i++) {
      await settle(30);
      pacer.activity();
    }
    expect(outcome).toBeNull();

    // Silence: now the window runs out.
    expect(await withTimeout(waiting, 'stall after silence')).toBe('stalled');
  });

  it('an announced retry delay extends the stall window by that delay', async () => {
    const pacer = new ObserverResponsePacer();
    let outcome: string | null = null;
    const waiting = pacer.waitForAnswer(pacer.mark(), new AbortController().signal, 20)
      .then(result => { outcome = result; return result; });
    pacer.activity(200);
    await settle(80);
    expect(outcome).toBeNull();
    pacer.answer();
    expect(await withTimeout(waiting, 'answer after retry')).toBe('answered');
  });
});

describe('response-stall resume policy', () => {
  it('resumes up to the cap, then stops', () => {
    const session = createSession();
    const decisions = [];
    for (let i = 0; i < MAX_CONSECUTIVE_STALL_RESUMES + 1; i++) {
      decisions.push(planResponseStallResume(session));
    }
    expect(decisions.slice(0, MAX_CONSECUTIVE_STALL_RESUMES).every(d => d.resume)).toBe(true);
    expect(decisions[MAX_CONSECUTIVE_STALL_RESUMES]).toEqual({ resume: false, attempts: MAX_CONSECUTIVE_STALL_RESUMES + 1 });
  });
});
