import { mock } from 'bun:test';
import codeMode from '../../../plugin/modes/code.json';
import type { ActiveSession } from '../../../src/services/worker-types.js';

// Snapshot before installing process-global module mocks, then restore after each suite.
const actualAgentSdk = { ...(await import('@anthropic-ai/claude-agent-sdk')) };
const actualFindClaude = { ...(await import('../../../src/shared/find-claude-executable.js')) };
const actualEnvManager = { ...(await import('../../../src/shared/EnvManager.js')) };
const actualProcessRegistry = { ...(await import('../../../src/supervisor/process-registry.js')) };
const actualModeManager = { ...(await import('../../../src/services/domain/ModeManager.js')) };
const actualContextGenerator = { ...(await import('../../../src/services/context-generator.js')) };

export class FakeSdk {
  readonly prompts: string[] = [];
  private outbox: unknown[] = [];
  private ended = false;
  private failure: Error | null = null;
  private inputDone = false;
  private wakeStream: (() => void) | null = null;
  private progressWaiters: Array<() => void> = [];

  constructor(prompt: AsyncIterable<any>, signal: AbortSignal | undefined, private readonly endOnInputDone = false, private readonly untilTimeoutMs = 2_000) {
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
  answer(text: string, result: Record<string, unknown> = {}): void {
    this.textFrame(text);
    this.result(result);
  }

  /** A text frame on its own: the turn is still open until a result arrives. */
  textFrame(text: string): void {
    this.push({ type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 2 } } });
  }

  result(overrides: Record<string, unknown> = {}): void {
    this.push({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 2 }, ...overrides });
  }

  bufferAnswer(text: string): void {
    this.outbox.push(
      { type: 'assistant', message: { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 2 } } },
      { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 2 } },
    );
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
      if (this.ended || (this.endOnInputDone && this.inputDone)) return;
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
  async until(predicate: () => boolean, label: string, timeoutMs = this.untilTimeoutMs): Promise<void> {
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

export function installScriptedClaudeSdk(options: { eager?: boolean; endOnInputDone?: boolean; executable?: string; startTimeoutMs?: number; untilTimeoutMs?: number } = {}) {
  const state = {
    messages: [] as Array<any>,
    capturedOptions: [] as Array<Record<string, any>>,
    credentials: {} as Record<string, string>,
    currentSdk: null as FakeSdk | null,
    sdk(): FakeSdk {
      if (!state.currentSdk) throw new Error('query() was never called');
      return state.currentSdk;
    },
    async sdkStarted(previous: FakeSdk | null = null, timeoutMs = options.startTimeoutMs ?? 10_000): Promise<FakeSdk> {
      const deadline = Date.now() + timeoutMs;
      while (!state.currentSdk || state.currentSdk === previous) {
        if (Date.now() > deadline) throw new Error('query() was never called');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return state.currentSdk;
    },
    restore() {
      mock.module('@anthropic-ai/claude-agent-sdk', () => actualAgentSdk);
      mock.module('../../../src/shared/find-claude-executable.js', () => actualFindClaude);
      mock.module('../../../src/shared/EnvManager.js', () => actualEnvManager);
      mock.module('../../../src/supervisor/process-registry.js', () => actualProcessRegistry);
      mock.module('../../../src/services/domain/ModeManager.js', () => actualModeManager);
      mock.module('../../../src/services/context-generator.js', () => actualContextGenerator);
    },
  };
  mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...actualAgentSdk,
    query: ({ prompt, options: sdkOptions }: { prompt: AsyncIterable<any>; options: Record<string, any> }) => {
      state.capturedOptions.push(sdkOptions);
      if (options.eager) {
        state.currentSdk = new FakeSdk(prompt, sdkOptions?.abortController?.signal, options.endOnInputDone, options.untilTimeoutMs);
        return state.currentSdk.stream();
      }
      const messages = state.messages;
      return (async function* () {
        for (const message of messages) {
          if ('throwError' in message) throw message.throwError;
          yield message;
        }
      })();
    },
  }));
  mock.module('../../../src/shared/find-claude-executable.js', () => ({ ...actualFindClaude,
    findClaudeExecutable: () => options.executable ?? '/mock/claude',
  }));
  mock.module('../../../src/shared/EnvManager.js', () => ({ ...actualEnvManager,
    buildIsolatedEnvWithFreshOAuth: async () => ({ PATH: process.env.PATH ?? '', ...state.credentials }),
    getAuthMethodDescription: () => 'test-auth',
  }));
  mock.module('../../../src/supervisor/process-registry.js', () => ({ ...actualProcessRegistry,
    waitForSlot: async () => ({ release: () => {} }),
    createSdkSpawnFactory: () => () => { throw new Error('spawn factory must not run in this test'); },
    getSdkProcessForSession: () => undefined,
    ensureSdkProcessExit: async () => {},
  }));
  mock.module('../../../src/services/domain/ModeManager.js', () => ({ ...actualModeManager,
    ModeManager: { getInstance: () => ({ getActiveMode: () => ({
      name: 'code', prompts: codeMode.prompts,
      observation_types: [{ id: 'discovery' }, { id: 'bugfix' }, { id: 'refactor' }], observation_concepts: [],
    }) }) },
  }));
  mock.module('../../../src/services/context-generator.js', () => ({ ...actualContextGenerator,
    generateContext: async () => '',
  }));
  return state;
}

export function createScriptedSession(sessionDbId: number, overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    sessionDbId, contentSessionId: `content-${sessionDbId}`, memorySessionId: null,
    project: 'observer-project', platformSource: 'claude', userPrompt: 'run the project',
    abortController: new AbortController(), generatorPromise: null, lastPromptNumber: 2,
    startTime: Date.now(), cumulativeInputTokens: 0, cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null, claimedMessageIds: [], conversationHistory: [], currentProvider: null,
    consecutiveRestarts: 0, consecutiveInvalidOutputs: 0, lastGeneratorActivity: Date.now(),
    ...overrides,
  } as ActiveSession;
}

export function settle(ms = 30): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function withTimeout<T>(promise: Promise<T>, label: string, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
