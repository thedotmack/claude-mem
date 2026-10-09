import { describe, it, expect, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import type { ActiveSession } from '../../src/services/worker-types.js';
import * as observerHealth from '../../src/shared/observer-health.js';

// Contract 6: buffered work is preserved across stream failure and recycle.
//
// These probes drive the real ClaudeProvider, SessionManager and
// SessionMessageBuffer against a fake SDK that pulls the prompt stream eagerly
// (the harness style of claude-provider-response-pacing.test.ts), and then run
// the real GeneratorExitHandler on the reason the run left behind. Each probe
// asserts an observable outcome of the contract — claims released, pending
// count intact, abort reason in a preserved category, the session not
// finalized, no generator left hanging — never the mechanism (the fork's
// TurnGate, upstream's pacer) that happens to implement it.
//
// On plain upstream v13.32.0 six of these failed: ClaudeProvider named no
// reason and released no claim when the SDK stream ended or threw, so the exit
// reached GeneratorExitHandler as null and the buffer was finalized away. The
// carried fix (releaseClaimedBatchForTransportExit: `transport:sdk_eof` after
// the loop, `transport:sdk_stream` in the catch) closes five of them; the
// stream probes below are its regression tests. The two still marked
// `it.failing` are design divergences left in place, explained inline. The
// per-probe control mutations are recorded in
// docs/2026-10-06-contract-6-probes.md.

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
  private failure: Error | null = null;
  private inputDone = false;
  private wakeStream: (() => void) | null = null;
  private progressWaiters: Array<() => void> = [];

  constructor(prompt: AsyncIterable<any>, signal: AbortSignal | undefined) {
    signal?.addEventListener('abort', () => this.end(), { once: true });
    void this.pump(prompt);
  }

  /** Pull the next prompt the moment the previous one has been taken, as the real SDK does. */
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

  /** One complete turn: a text frame and the success result that closes it. */
  answer(text: string): void {
    this.textFrame(text);
    this.result();
  }

  /** A text frame on its own: the turn is still open until a result arrives. */
  textFrame(text: string): void {
    this.push({ type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 2 } } });
  }

  result(): void {
    this.push({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 2 } });
  }

  /** A turn that failed before emitting any text. */
  failTurn(): void {
    this.push({ type: 'result', subtype: 'error_during_execution', is_error: true });
  }

  /** Any other SDK frame (system init, rate_limit_event). */
  frame(message: Record<string, unknown>): void {
    this.push(message);
  }

  /** The output iterator throws: the child died, the socket closed. */
  fail(error: Error): void {
    this.failure = error;
    this.wakeStream?.();
  }

  /** The output iterator ends cleanly. */
  end(): void {
    this.ended = true;
    this.wakeStream?.();
    this.notify();
  }

  private push(message: unknown): void {
    this.outbox.push(message);
    this.wakeStream?.();
  }

  async *stream(): AsyncGenerator<unknown> {
    while (true) {
      while (this.outbox.length > 0) yield this.outbox.shift();
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>(resolve => { this.wakeStream = resolve; });
      this.wakeStream = null;
    }
  }

  private notify(): void {
    const waiters = this.progressWaiters;
    this.progressWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** Resolve once `predicate` holds, failing the probe instead of hanging bun. */
  async until(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
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
  // Not an API key: the subscription quota guard applies.
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
  resetQuotaCooldownsForTesting();
});

const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');
const { SessionManager } = await import('../../src/services/worker/SessionManager.js');
const { SessionStore } = await import('../../src/services/sqlite/SessionStore.js');
const { handleGeneratorExit } = await import('../../src/services/worker/session/GeneratorExitHandler.js');
const { PRESERVED_ABORT_CATEGORIES, abortCategoryOf } = await import('../../src/services/worker/session/abort-reason.js');
const { globalRateLimitStore } = await import('../../src/services/worker/RateLimitStore.js');
const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');
const { resetQuotaCooldownsForTesting } = await import('../../src/shared/quota-cooldown.js');
const { resetDependencyStatusesForTesting } = await import('../../src/shared/dependency-health.js');

const SESSION_ID = 6106;
const SKIP_REPLY = '<skip_summary reason="noise" />';

function createSession(sessionDbId = SESSION_ID): ActiveSession {
  return {
    sessionDbId,
    contentSessionId: `content-${sessionDbId}`,
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

function createHarness(backlog: number) {
  const dbManager = {
    getSessionById: () => ({ project: 'observer-project', memory_session_id: null }),
    getSessionStore: () => ({
      ensureMemorySessionIdRegistered: (_id: number, memoryId: string) => memoryId,
      updateMemorySessionId: () => {},
      storeObservations: () => ({ observationIds: [1], summaryId: null, createdAtEpoch: Date.now() }),
      linkToolUsesToObservation: () => 0,
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
      tool_response: `${i}:`.padEnd(200, 'x'),
      prompt_number: 2,
      toolUseId: `toolu_${i}`,
    });
  }

  const provider = new ClaudeProvider(dbManager as never, sessionManager as never);
  let finalized = 0;
  return {
    session,
    sessionManager,
    provider,
    pending: () => buffer.getPendingCount(SESSION_ID),
    /** The real post-exit decision on the reason the run left behind. */
    exit: async () => {
      await handleGeneratorExit(session, session.abortReason ?? null, {
        sessionManager,
        completionHandler: { finalizeSession: async () => { finalized += 1; } } as never,
      });
      return { finalized, sessionKept: sessionManager.getSession(SESSION_ID) === session, pending: buffer.getPendingCount(SESSION_ID) };
    },
  };
}

function sdk(): FakeSdk {
  if (!currentSdk) throw new Error('query() was never called');
  return currentSdk;
}

async function sdkStarted(timeoutMs = 5_000): Promise<FakeSdk> {
  const deadline = Date.now() + timeoutMs;
  while (!currentSdk) {
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

/** Drive a generation through its init turn and the claim of the first observation. */
async function claimFirstObservation(h: ReturnType<typeof createHarness>) {
  const run = h.provider.startSession(h.session);
  await sdkStarted();
  await sdk().until(() => sdk().prompts.length >= 1, 'init prompt');
  sdk().answer(SKIP_REPLY);
  await sdk().until(() => sdk().prompts.length >= 2, 'first observation');
  expect(sdk().prompts[1]).toContain('step 0');
  const claimedId = h.session.claimedMessageIds[0];
  expect(claimedId).toBeDefined();
  return { run, claimedId };
}

let liveSessions: ActiveSession[] = [];
let previousObserveBarePrompts: string | undefined;

beforeEach(() => {
  currentSdk = null;
  liveSessions = [];
  resetQuotaCooldownsForTesting();
  resetDependencyStatusesForTesting();
  // A separate init turn makes "init failed" and "between turns" expressible.
  previousObserveBarePrompts = process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS;
  process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS = 'true';
});

afterEach(() => {
  // Release any generator still parked (on the pacer, or in the drain) so
  // nothing outlives the probe that left it there.
  for (const session of liveSessions) session.abortController.abort();
  if (previousObserveBarePrompts === undefined) delete process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS;
  else process.env.CLAUDE_MEM_OBSERVE_BARE_PROMPTS = previousObserveBarePrompts;
});

describe('contract 6 — a failed result frame', () => {
  it('re-queues the claimed batch once and re-sends it, with nothing acknowledged', async () => {
    const h = createHarness(1);
    liveSessions.push(h.session);
    const { run, claimedId } = await claimFirstObservation(h);

    sdk().failTurn();
    await sdk().until(() => sdk().prompts.length >= 3, 're-sent observation');
    expect(sdk().prompts[2]).toContain('step 0');
    // The same message, claimed again, and still in the buffer.
    expect(h.session.claimedMessageIds).toEqual([claimedId]);
    expect(h.pending()).toBe(1);

    h.session.abortController.abort();
    await withTimeout(run, 'startSession after abort');
  });

  it('a second failure for the same batch ends the generation on a reason that preserves it', async () => {
    const h = createHarness(2);
    liveSessions.push(h.session);
    const { run } = await claimFirstObservation(h);

    sdk().failTurn();
    await sdk().until(() => sdk().prompts.length >= 3, 're-sent observation');
    sdk().failTurn();
    await withTimeout(run, 'startSession after second failure');

    expect(h.session.abortController.signal.aborted).toBe(true);
    expect(PRESERVED_ABORT_CATEGORIES.has(abortCategoryOf(h.session.abortReason))).toBe(true);
    expect(h.session.claimedMessageIds).toEqual([]);
    expect(h.pending()).toBe(2);

    const outcome = await h.exit();
    expect(outcome).toEqual({ finalized: 0, sessionKept: true, pending: 2 });
  });

  it('on the init turn leaves the unclaimed backlog intact and still sends it', async () => {
    const h = createHarness(1);
    liveSessions.push(h.session);
    const run = h.provider.startSession(h.session);
    await sdkStarted();
    await sdk().until(() => sdk().prompts.length >= 1, 'init prompt');
    expect(h.pending()).toBe(1);

    sdk().failTurn();
    await sdk().until(() => sdk().prompts.length >= 2, 'first observation after failed init');
    expect(sdk().prompts[1]).toContain('step 0');
    expect(h.pending()).toBe(1);
    expect(h.session.claimedMessageIds.length).toBe(1);

    h.session.abortController.abort();
    await withTimeout(run, 'startSession after abort');
  });
});

describe('contract 6 — the SDK stream ends or breaks', () => {
  it('clean EOF mid-batch releases the claim and leaves the session for the next generation', async () => {
    const h = createHarness(1);
    liveSessions.push(h.session);
    const { run } = await claimFirstObservation(h);

    sdk().end();
    await withTimeout(run, 'startSession after EOF');
    await sdk().until(() => sdk().inputFinished, 'generator released after EOF');

    expect(h.pending()).toBe(1);
    expect(h.session.claimedMessageIds).toEqual([]);
    expect(PRESERVED_ABORT_CATEGORIES.has(abortCategoryOf(h.session.abortReason))).toBe(true);
    const outcome = await h.exit();
    expect(outcome).toEqual({ finalized: 0, sessionKept: true, pending: 1 });
  });

  it('a thrown output iterator mid-batch surfaces the error and preserves the batch', async () => {
    const h = createHarness(1);
    liveSessions.push(h.session);
    const { run } = await claimFirstObservation(h);

    sdk().fail(new Error('socket exploded'));
    await expect(withTimeout(run, 'startSession after throw')).rejects.toThrow('socket exploded');
    await sdk().until(() => sdk().inputFinished, 'generator released after throw');

    expect(h.pending()).toBe(1);
    expect(h.session.claimedMessageIds).toEqual([]);
    expect(PRESERVED_ABORT_CATEGORIES.has(abortCategoryOf(h.session.abortReason))).toBe(true);
    const outcome = await h.exit();
    expect(outcome).toEqual({ finalized: 0, sessionKept: true, pending: 1 });
  });

  it('a throw inside response processing surfaces the error and preserves the batch', async () => {
    const h = createHarness(1);
    liveSessions.push(h.session);
    const { run } = await claimFirstObservation(h);
    // The skip sentinel acknowledges the batch; make that acknowledgement fail.
    h.sessionManager.confirmClaimedMessages = async () => { throw new Error('storage exploded'); };

    sdk().answer(SKIP_REPLY);
    await expect(withTimeout(run, 'startSession after processing throw')).rejects.toThrow('storage exploded');
    await sdk().until(() => sdk().inputFinished, 'generator released after processing throw');

    expect(h.pending()).toBe(1);
    expect(h.session.claimedMessageIds).toEqual([]);
    expect(PRESERVED_ABORT_CATEGORIES.has(abortCategoryOf(h.session.abortReason))).toBe(true);
    const outcome = await h.exit();
    expect(outcome).toEqual({ finalized: 0, sessionKept: true, pending: 1 });
  });

  it('EOF during the init turn keeps the unclaimed backlog for the next generation', async () => {
    const h = createHarness(1);
    liveSessions.push(h.session);
    const run = h.provider.startSession(h.session);
    await sdkStarted();
    await sdk().until(() => sdk().prompts.length >= 1, 'init prompt');

    sdk().end();
    await withTimeout(run, 'startSession after init EOF');
    await sdk().until(() => sdk().inputFinished, 'generator released after init EOF');

    expect(sdk().prompts.length).toBe(1);
    expect(h.pending()).toBe(1);
    const outcome = await h.exit();
    expect(outcome).toEqual({ finalized: 0, sessionKept: true, pending: 1 });
  });

  it('EOF while the generator waits between turns releases the generator', async () => {
    const h = createHarness(0);
    liveSessions.push(h.session);
    const run = h.provider.startSession(h.session);
    await sdkStarted();
    await sdk().until(() => sdk().prompts.length >= 1, 'init prompt');
    sdk().answer(SKIP_REPLY);
    await settle();
    expect(sdk().inputFinished).toBe(false); // parked in the drain, waiting for work

    sdk().end();
    await withTimeout(run, 'startSession after between-turn EOF');
    await sdk().until(() => sdk().inputFinished, 'generator released after between-turn EOF');
  });

  it('a session abort while the generator waits between turns releases the generator', async () => {
    const h = createHarness(0);
    liveSessions.push(h.session);
    const run = h.provider.startSession(h.session);
    await sdkStarted();
    await sdk().until(() => sdk().prompts.length >= 1, 'init prompt');
    sdk().answer(SKIP_REPLY);
    await settle();
    expect(sdk().inputFinished).toBe(false);

    h.session.abortReason = 'shutdown';
    h.session.abortController.abort();
    await withTimeout(run, 'startSession after abort');
    await sdk().until(() => sdk().inputFinished, 'generator released after abort');
    expect(h.session.abortReason).toBe('shutdown');
  });
});

describe('contract 6 — ordering and durable state', () => {
  it('claims no later work before each successful result', async () => {
    const h = createHarness(3);
    liveSessions.push(h.session);
    const { run } = await claimFirstObservation(h);

    // A text frame alone does not close the turn: no further message is claimed.
    sdk().textFrame(SKIP_REPLY);
    await settle();
    expect(sdk().prompts.length).toBe(2);
    expect(h.pending()).toBeGreaterThanOrEqual(2);

    sdk().result();
    await sdk().until(() => sdk().prompts.length >= 3, 'second observation');
    await settle();
    // Exactly one more claim per answered turn, never a burst.
    expect(sdk().prompts.length).toBe(3);
    expect(sdk().prompts[2]).toContain('step 1');
    expect(h.session.claimedMessageIds.length).toBe(1);
    expect(h.pending()).toBe(2);

    h.session.abortController.abort();
    await withTimeout(run, 'startSession after abort');
  });

  // UPSTREAM GAP (design divergence, not a loss): upstream processes and
  // acknowledges the batch on the assistant text frame; the result frame only
  // releases the feed. The fork held acknowledgement until the successful result.
  it.failing('acknowledges the batch only once the turn\'s result frame has arrived', async () => {
    const h = createHarness(3);
    liveSessions.push(h.session);
    const { run, claimedId } = await claimFirstObservation(h);

    sdk().textFrame(SKIP_REPLY);
    await settle();
    expect(h.session.claimedMessageIds).toEqual([claimedId]);
    expect(h.pending()).toBe(3);

    sdk().result();
    await sdk().until(() => sdk().prompts.length >= 3, 'second observation');
    expect(h.pending()).toBe(2);

    h.session.abortController.abort();
    await withTimeout(run, 'startSession after abort');
  });

  it('carries the actual quota-guard window out of the stream and keeps the claimed batch', async () => {
    const h = createHarness(1);
    liveSessions.push(h.session);
    const { run, claimedId } = await claimFirstObservation(h);

    try {
      sdk().frame({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.95 } });
      await withTimeout(run, 'startSession after quota guard');
      await sdk().until(() => sdk().inputFinished, 'generator released after quota guard');

      expect(h.session.abortReason).toBe('quota:seven_day');
      expect(h.session.abortController.signal.aborted).toBe(true);
      expect(h.pending()).toBe(1);
      const outcome = await h.exit();
      expect(outcome).toEqual({ finalized: 0, sessionKept: true, pending: 1 });

      // The next generation re-yields the message the guard interrupted.
      h.session.abortController = new AbortController();
      const next = h.sessionManager.getMessageIterator(SESSION_ID);
      const reclaimed = await withTimeout(next.next(), 'reclaim after quota guard');
      expect(reclaimed.value?._persistentId).toBe(claimedId);
      h.session.abortController.abort();
      await next.return?.(undefined);
    } finally {
      globalRateLimitStore.set({ rateLimitType: 'seven_day', utilization: 0, status: 'allowed' });
    }
  });

  it('starts a recycled generation without nulling durable observation and summary rows', async () => {
    const store = new SessionStore(':memory:');
    try {
      const oldMemorySessionId = 'memory-before-recycle';
      const sessionDbId = store.createSDKSession('content-recycle', 'observer-project', 'prompt');
      store.updateMemorySessionId(sessionDbId, oldMemorySessionId);
      const stored = store.storeObservations(
        oldMemorySessionId,
        'observer-project',
        [{
          type: 'discovery',
          title: 'Durable observation',
          subtitle: null,
          facts: ['Must survive recycle'],
          narrative: 'The prior observer turn completed.',
          concepts: [],
          files_read: [],
          files_modified: [],
        }],
        {
          request: 'Preserve durable memory',
          investigated: 'The recycle path',
          learned: 'Foreign keys must stay non-null',
          completed: 'Stored existing memory',
          next_steps: 'Start a fresh SDK generation',
          notes: null,
        },
      );
      const dbManager = {
        getSessionById: () => store.getSessionById(sessionDbId),
        getSessionStore: () => store,
        getChromaSync: () => null,
        getCloudSync: () => null,
      };
      const sessionManager = new SessionManager(dbManager as never);
      const session = createSession(sessionDbId);
      session.memorySessionId = oldMemorySessionId;
      session.forceInit = true;
      (sessionManager as any).sessions.set(sessionDbId, session);
      liveSessions.push(session);
      const provider = new ClaudeProvider(dbManager as never, sessionManager as never);

      const run = provider.startSession(session);
      await sdkStarted();
      await sdk().until(() => sdk().prompts.length >= 1, 'init prompt');

      // Before the SDK says anything: the carried id is reset in memory only.
      expect(session.memorySessionId).toBeNull();
      expect(store.getSessionById(sessionDbId)?.memory_session_id).toBe(oldMemorySessionId);
      expect(store.getObservationById(stored.observationIds[0])?.memory_session_id).toBe(oldMemorySessionId);
      expect(store.getSummaryForSession(oldMemorySessionId)?.request).toBe('Preserve durable memory');

      // The fresh process announces its own id; the durable rows stay keyed.
      sdk().frame({ type: 'system', subtype: 'init', session_id: 'memory-after-recycle' });
      await settle();
      const registered = store.getSessionById(sessionDbId)?.memory_session_id;
      expect(registered).not.toBeNull();
      expect(store.getObservationById(stored.observationIds[0])?.memory_session_id).toBe(registered!);
      expect(store.getSummaryForSession(registered!)?.request).toBe('Preserve durable memory');

      session.abortController.abort();
      await withTimeout(run, 'startSession after abort');
    } finally {
      store.close();
    }
  });
});

describe('contract 6 — a generator that throws, seen from the runner', () => {
  async function buildRoutesWithRealBuffer(sessionDbId: number, startSession: () => Promise<void>) {
    const dbManager = {
      getSessionById: () => ({
        content_session_id: `content-${sessionDbId}`,
        memory_session_id: null,
        project: 'project',
        platform_source: 'claude',
        user_prompt: 'prompt',
        observed_model: null,
        observed_billing: null,
      }),
      getSessionStore: () => ({ getPromptNumberFromUserPrompts: () => 1 }),
    };
    const sessionManager = new SessionManager(dbManager as never);
    const session = sessionManager.initializeSession(sessionDbId, 'prompt', 1);
    sessionManager.queueObservation(sessionDbId, {
      tool_name: 'Read',
      tool_input: { file_path: 'queued.ts' },
      tool_response: 'queued work',
      prompt_number: 2,
      toolUseId: `tool-${sessionDbId}`,
    });
    let finalizeCalls = 0;
    const routes = new SessionRoutes(
      sessionManager,
      dbManager as never,
      { startSession } as never,
      { startSession: async () => {} } as never,
      { startSession: async () => {} } as never,
      {} as never,
      {} as never,
      { finalizeSession: async () => { finalizeCalls += 1; } } as never,
    );
    return { routes, session, sessionManager, finalizeCalls: () => finalizeCalls };
  }

  /** The routes with the REAL ClaudeProvider as the Claude agent, over a real buffer. */
  async function buildRoutesWithRealProvider(sessionDbId: number) {
    const dbManager = {
      getSessionById: () => ({
        content_session_id: `content-${sessionDbId}`,
        memory_session_id: null,
        project: 'observer-project',
        platform_source: 'claude',
        user_prompt: 'work through the backlog',
        observed_model: null,
        observed_billing: null,
      }),
      getSessionStore: () => ({
        getPromptNumberFromUserPrompts: () => 1,
        ensureMemorySessionIdRegistered: (_id: number, memoryId: string) => memoryId,
        updateMemorySessionId: () => {},
        storeObservations: () => ({ observationIds: [1], summaryId: null, createdAtEpoch: Date.now() }),
        linkToolUsesToObservation: () => 0,
      }),
      getChromaSync: () => null,
      getCloudSync: () => null,
    };
    const sessionManager = new SessionManager(dbManager as never);
    const session = sessionManager.initializeSession(sessionDbId, 'work through the backlog', 1);
    sessionManager.queueObservation(sessionDbId, {
      tool_name: 'Bash',
      tool_input: { command: 'step 0' },
      tool_response: 'queued work',
      prompt_number: 2,
      toolUseId: `tool-${sessionDbId}`,
    });
    const provider = new ClaudeProvider(dbManager as never, sessionManager as never);
    let finalizeCalls = 0;
    const routes = new SessionRoutes(
      sessionManager,
      dbManager as never,
      provider as never,
      { startSession: async () => {} } as never,
      { startSession: async () => {} } as never,
      {} as never,
      {} as never,
      { finalizeSession: async () => { finalizeCalls += 1; } } as never,
    );
    return { routes, session, sessionManager, finalizeCalls: () => finalizeCalls };
  }

  it('an Invalid API key status line is booked as the refused credential it is, not paused as transport', async () => {
    // Captured at booking time, before the runner's finally consumes abortReason.
    const booked: Array<{ args: unknown[]; abortReason: string | null; claimed: number[] }> = [];
    const { routes, session, sessionManager, finalizeCalls } = await buildRoutesWithRealProvider(6109);
    liveSessions.push(session);
    const recordFailure = spyOn(observerHealth, 'recordObserverFailure').mockImplementation((...args: unknown[]) => {
      booked.push({ args, abortReason: session.abortReason ?? null, claimed: [...session.claimedMessageIds] });
    });
    try {
      await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
      await sdkStarted();
      await sdk().until(() => sdk().prompts.length >= 1, 'init prompt');
      sdk().answer(SKIP_REPLY);
      await sdk().until(() => sdk().prompts.length >= 2, 'first observation');
      const claimedId = session.claimedMessageIds[0];
      expect(claimedId).toBeDefined();

      // The CLI's own auth-failure status line, mid-batch.
      sdk().frame({
        type: 'assistant',
        error: 'authentication_failed',
        message: { content: [{ type: 'text', text: 'Invalid API key · Please run /login' }], usage: {} },
      });
      await withTimeout(session.generatorPromise ?? Promise.resolve(), 'generator chain after auth failure');
      await settle(5);

      // Booked with the provider's words; the provider named no reason and
      // released nothing — a bad key is not a transport fault to retry.
      expect(booked).toHaveLength(1);
      expect(booked[0].args[0]).toBe('claude');
      expect(String(booked[0].args[1])).toContain('Invalid API key');
      expect(booked[0].abortReason).toBeNull();
      expect(booked[0].claimed).toEqual([claimedId]);
      // Upstream's design for a booked failure: finalized, not re-queued.
      expect(finalizeCalls()).toBe(1);
      expect(sessionManager.getSession(session.sessionDbId)).toBeUndefined();
    } finally {
      recordFailure.mockRestore();
    }
  });

  it('books an unclassified stream failure in observer health and does not retry it', async () => {
    let starts = 0;
    const recordFailure = spyOn(observerHealth, 'recordObserverFailure').mockImplementation(() => {});
    try {
      const { routes, session } = await buildRoutesWithRealBuffer(6107, async () => {
        starts += 1;
        throw new Error('transport exploded');
      });
      await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
      await session.generatorPromise;
      await settle(5);

      expect(starts).toBe(1);
      expect(recordFailure).toHaveBeenCalledWith('claude', 'transport exploded');
    } finally {
      recordFailure.mockRestore();
    }
  });

  // UPSTREAM GAP, kept as a divergence: an unclassified throw that reaches the
  // runner is booked and then finalized (GeneratorExitHandler: "anything still
  // buffered is dropped here and recovered ... by replaying the transcript").
  // With the carried ClaudeProvider fix, SDK-originated failures no longer
  // reach this branch (they arrive as `transport:` pauses), so only a provider
  // that throws before its stream opens lands here, and that is upstream's call.
  it.failing('keeps the real buffered work after an unclassified stream failure', async () => {
    const recordFailure = spyOn(observerHealth, 'recordObserverFailure').mockImplementation(() => {});
    try {
      const { routes, session, sessionManager, finalizeCalls } = await buildRoutesWithRealBuffer(6108, async () => {
        throw new Error('transport exploded');
      });
      await routes.ensureGeneratorRunning(session.sessionDbId, 'observation');
      await session.generatorPromise;
      await settle(5);

      expect(finalizeCalls()).toBe(0);
      expect(sessionManager.getSession(session.sessionDbId)).toBe(session);
      expect(sessionManager.getMessageBuffer().getPendingCount(session.sessionDbId)).toBe(1);
    } finally {
      recordFailure.mockRestore();
    }
  });
});
