import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { OpenRouterProvider, classifyOpenRouterError } from '../../src/services/worker/OpenRouterProvider.js';
import { classifyOpenAICompatError } from '../../src/services/worker/OpenAICompatProvider.js';
import { OpenAICompatibleProvider, type ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { SessionManager, type TransportResumeClock } from '../../src/services/worker/SessionManager.js';
import { computeBackoffMs, MAX_RETRY_AFTER_MS, withRetry } from '../../src/services/worker/retry.js';
import {
  ClassifiedProviderError,
  describeProviderError,
  isClassified,
  PAID_SEND_BUDGET_EXHAUSTED_CODE,
  paidSendOutcomeOf,
  readCappedErrorBody,
  MAX_ERROR_BODY_BYTES,
} from '../../src/services/worker/provider-errors.js';
import {
  DEFAULT_MAX_PAID_SENDS_PER_BATCH,
  PaidSendBudget,
  paidSendBudgetForClaimedBatch,
} from '../../src/services/worker/paid-send-budget.js';
import type { ActiveSession, ConversationMessage } from '../../src/services/worker-types.js';
import { classifyCodexError } from '../../src/services/worker/CodexProvider.js';
import { CODEX_MALFORMED_OUTPUT_CODE, CODEX_NO_AGENT_MESSAGE_CODE } from '../../src/services/worker/CodexAppServerClient.js';

/**
 * "Never pay twice" (plan Phase 1, xAI SDK retry rules): one case per row of
 * the outcome table in retry.ts, each asserting the exact number of sends, and
 * the per-batch paid-send budget shared by withRetry and the transport resume.
 */

const CONFIG = {
  apiKey: 'test-key',
  apiKeys: ['test-key'],
  model: 'test/model',
  fallbackModels: [],
  apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
};
const HISTORY: ConversationMessage[] = [{ role: 'user', content: 'observe this' }];
const OK_BODY = JSON.stringify({ model: 'test/model', choices: [{ message: { content: '<observation/>' }, finish_reason: 'stop' }] });

class TestOpenRouterProvider extends OpenRouterProvider {
  runQuery(paidSendBudget?: PaidSendBudget) {
    return this.query(HISTORY, CONFIG as never, undefined, 5_000, paidSendBudget);
  }
}

const provider = () => new TestOpenRouterProvider({} as never, {} as never);

/** Scripted fetch: each call takes the next step; records every request's headers. */
function scriptFetch(steps: Array<() => Response | Promise<Response>>) {
  const sentHeaders: Array<Record<string, string>> = [];
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (_input: unknown, init?: RequestInit) => {
    sentHeaders.push({ ...(init?.headers as Record<string, string>) });
    const step = steps[Math.min(sentHeaders.length - 1, steps.length - 1)];
    return step();
  }) as unknown as typeof fetch);
  return { spy, sentHeaders, sends: () => sentHeaders.length };
}

afterEach(() => {
  mock.restore();
});

describe('outcome table: what is retried in place', () => {
  it('429 with Retry-After: retried in place, the wait capped at 60s', async () => {
    const waits: number[] = [];
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      waits.push(ms);
      return nativeSetTimeout(fn, ms === MAX_RETRY_AFTER_MS ? 0 : ms);
    }) as typeof setTimeout;
    const fetch = scriptFetch([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
      () => new Response(OK_BODY, { status: 200 }),
    ]);
    try {
      const result = await provider().runQuery();
      expect(result.content).toBe('<observation/>');
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
    }
    expect(fetch.sends()).toBe(2);
    expect(waits).toContain(MAX_RETRY_AFTER_MS);
    expect(waits).not.toContain(120_000);
  });

  it('429 without Retry-After: 1s→30s exponential backoff, jittered ×(0.5–1)', () => {
    const original = Math.random;
    try {
      Math.random = () => 0;
      expect(computeBackoffMs(0, { baseDelayMs: 1_000, maxDelayMs: 30_000 })).toBe(500);
      expect(computeBackoffMs(10, { baseDelayMs: 1_000, maxDelayMs: 30_000 })).toBe(15_000);
      Math.random = () => 0.9999;
      expect(computeBackoffMs(0, { baseDelayMs: 1_000, maxDelayMs: 30_000 })).toBe(999);
      expect(computeBackoffMs(10, { baseDelayMs: 1_000, maxDelayMs: 30_000 })).toBe(29_998);
    } finally {
      Math.random = original;
    }
  });

  // Phase 3 carve-out: a streamed request that fails before any output may be
  // resent once (retryBeforeOutput), and no more; see streamed-provider.test.ts.
  it('network error before any response: ambiguous, resent once before output, then not retried', async () => {
    const fetch = scriptFetch([() => { throw new TypeError('fetch failed'); }]);
    const error = await provider().runQuery().catch((caught: unknown) => caught);
    expect(fetch.sends()).toBe(2);
    expect(isClassified(error) && error.kind).toBe('transient');
    expect(paidSendOutcomeOf(error)).toBe('ambiguous');
  });

  it('5xx on a non-stream POST: ambiguous, one send, not retried', async () => {
    const fetch = scriptFetch([() => new Response('upstream hiccup', { status: 502 })]);
    const error = await provider().runQuery().catch((caught: unknown) => caught);
    expect(fetch.sends()).toBe(1);
    expect(paidSendOutcomeOf(error)).toBe('ambiguous');
  });

  it('response received, then the body failed to parse: output failure, never retried', async () => {
    const fetch = scriptFetch([() => new Response('{"choices": [', { status: 200 })]);
    const error = await provider().runQuery().catch((caught: unknown) => caught);
    expect(fetch.sends()).toBe(1);
    expect(paidSendOutcomeOf(error)).toBe('output_failure');
  });

  it('200 with an embedded litellm error: output failure, never retried', async () => {
    const fetch = scriptFetch([() => new Response(JSON.stringify({
      error: { code: 200, message: 'Unable to get json response - Expecting value: line 45 column 1' },
    }), { status: 200 })]);
    const error = await provider().runQuery().catch((caught: unknown) => caught);
    expect(fetch.sends()).toBe(1);
    expect(paidSendOutcomeOf(error)).toBe('output_failure');
  });

  it('unclassified error: not retried', async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts += 1;
      throw new Error('something odd');
    }, { perAttemptTimeoutMs: 5_000, baseDelayMs: 1 })).rejects.toThrow('something odd');
    expect(attempts).toBe(1);
  });

  it('our own deadline: ambiguous, one send, counted against the budget', async () => {
    const budget = new PaidSendBudget(1);
    let attempts = 0;
    const error = await withRetry(signal => {
      attempts += 1;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')), { once: true });
      });
    }, { perAttemptTimeoutMs: 20, paidSendBudget: budget }).catch((caught: unknown) => caught);
    expect(attempts).toBe(1);
    expect(paidSendOutcomeOf(error)).toBe('ambiguous');
    expect(budget.spentPaidSends).toBe(1);
  });

  // #4604: an endpoint that refuses connections never receives the request,
  // so retries against it are pre-send and the batch keeps its whole budget —
  // an outage pauses the session instead of parking its work for good.
  it('refused connection: retried in place, paid-send budget untouched', async () => {
    const budget = new PaidSendBudget(2);
    const refused = classifyOpenAICompatError({
      cause: Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' }),
    });
    let attempts = 0;
    const error = await withRetry(async () => {
      attempts += 1;
      throw refused;
    }, { perAttemptTimeoutMs: 5_000, baseDelayMs: 1, maxDelayMs: 2, paidSendBudget: budget }).catch((caught: unknown) => caught);
    expect(error).toBe(refused);
    expect(attempts).toBe(3);
    expect(budget.spentPaidSends).toBe(0);
    expect(budget.hasRemainingPaidSend()).toBe(true);
  });
});

describe('Codex: a completed turn with unusable output is never resent', () => {
  for (const code of [CODEX_NO_AGENT_MESSAGE_CODE, CODEX_MALFORMED_OUTPUT_CODE]) {
    it(`${code} is an output failure, not retryable`, async () => {
      const classified = classifyCodexError(Object.assign(new Error('turn completed'), { code }));
      expect(paidSendOutcomeOf(classified)).toBe('output_failure');
      let attempts = 0;
      await expect(withRetry(async () => {
        attempts += 1;
        throw classified;
      }, { perAttemptTimeoutMs: 5_000, maxRetries: 1 })).rejects.toBe(classified);
      expect(attempts).toBe(1);
    });
  }
});

describe('client attempt id', () => {
  it('is sent as x-client-request-id, never the old prior-request-id header, and rides on the error', async () => {
    const budget = new PaidSendBudget(7);
    const fetch = scriptFetch([() => new Response('upstream hiccup', { status: 503 })]);
    const error = await provider().runQuery(budget).catch((caught: unknown) => caught);
    expect(fetch.sentHeaders[0]['x-client-request-id']).toBe(budget.clientAttemptId);
    expect(Object.keys(fetch.sentHeaders[0])).not.toContain('x-claude-mem-prior-request-id');
    expect(isClassified(error) && error.clientAttemptId).toBe(budget.clientAttemptId);
    expect(describeProviderError(error as ClassifiedProviderError)).toContain(`(client attempt ${budget.clientAttemptId})`);
  });
});

describe('error bodies are read at most 64 KiB', () => {
  it('stops reading a huge error body at the cap', async () => {
    const huge = 'x'.repeat(MAX_ERROR_BODY_BYTES * 4);
    const text = await readCappedErrorBody(new Response(huge, { status: 500 }));
    expect(text.length).toBe(MAX_ERROR_BODY_BYTES);
  });
});

describe('PaidSendBudget: one allowance per claimed batch, shared by withRetry and the transport resume', () => {
  function makeSessionManager() {
    const timers: Array<() => void> = [];
    const clock: TransportResumeClock = {
      setTimeout: (callback) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout: () => {},
    };
    const sessionManager = new SessionManager({} as never, clock);
    sessionManager.setGeneratorStarter(() => {});
    const sessionDbId = 4401;
    const session = {
      sessionDbId,
      contentSessionId: 'never-pay-twice',
      memorySessionId: 'never-pay-twice',
      project: 'test',
      platformSource: 'claude',
      userPrompt: '',
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 1,
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      earliestPendingTimestamp: null,
      claimedMessageIds: [],
      conversationHistory: [],
      currentProvider: null,
      consecutiveRestarts: 0,
      consecutiveInvalidOutputs: 0,
      consecutiveContextOverflows: 0,
      lastGeneratorActivity: Date.now(),
    } as unknown as ActiveSession;
    (sessionManager as unknown as { sessions: Map<number, ActiveSession> }).sessions.set(sessionDbId, session);
    const messageId = sessionManager.getMessageBuffer().enqueue(sessionDbId, {
      type: 'observation', tool_name: 'Read', tool_input: '{}', tool_response: 'content', prompt_number: 1,
    });
    return { sessionManager, session, sessionDbId, messageId, timers };
  }

  it('defaults to two paid sends', () => {
    expect(DEFAULT_MAX_PAID_SENDS_PER_BATCH).toBe(2);
  });

  it('first send + one transport resume, then the batch is parked and never sent again', async () => {
    const { sessionManager, session, sessionDbId, messageId, timers } = makeSessionManager();
    const fetch = scriptFetch([() => new Response('upstream hiccup', { status: 503 })]);

    // Generator 1 claims the batch and sends once: ambiguous.
    session.claimedMessageIds = [messageId];
    const firstBudget = paidSendBudgetForClaimedBatch(session)!;
    await provider().runQuery(firstBudget).catch(() => undefined);
    expect(fetch.sends()).toBe(1);
    expect(firstBudget.spentPaidSends).toBe(1);

    // The exit pauses on transport: one send left, so a resume is scheduled.
    await sessionManager.resetProcessingToPending(sessionDbId);
    sessionManager.scheduleTransportResume(sessionDbId);
    expect(timers).toHaveLength(1);
    expect(sessionManager.getMessageBuffer().getParkedMessages(sessionDbId)).toHaveLength(0);

    // The resumed generator claims the same head: same budget, same client id.
    session.claimedMessageIds = [messageId];
    const resumedBudget = paidSendBudgetForClaimedBatch(session)!;
    expect(resumedBudget).toBe(firstBudget);
    await provider().runQuery(resumedBudget).catch(() => undefined);
    expect(fetch.sends()).toBe(2);
    expect(fetch.sentHeaders[1]['x-client-request-id']).toBe(fetch.sentHeaders[0]['x-client-request-id']);

    // Spent: the transport resume parks the batch instead of scheduling a third send.
    await sessionManager.resetProcessingToPending(sessionDbId);
    sessionManager.scheduleTransportResume(sessionDbId);
    expect(timers).toHaveLength(1);
    expect(sessionManager.getMessageBuffer().getParkedMessages(sessionDbId)).toHaveLength(1);
    expect(sessionManager.getMessageBuffer().getPendingCount(sessionDbId)).toBe(0);

    // And withRetry refuses outright if anything tries to send it again.
    const refusal = await provider().runQuery(firstBudget).catch((caught: unknown) => caught);
    expect(fetch.sends()).toBe(2);
    expect(isClassified(refusal) && refusal.code).toBe(PAID_SEND_BUDGET_EXHAUSTED_CODE);
  });

  it('a 429 refusal costs nothing: it is retried in place without spending the budget', async () => {
    const budget = new PaidSendBudget(9);
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new ClassifiedProviderError('rate limited', { kind: 'rate_limit', cause: null, retryAfterMs: 0 });
      return 'ok';
    }, { perAttemptTimeoutMs: 5_000, paidSendBudget: budget });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(budget.spentPaidSends).toBe(1);
  });

  it('a new batch head gets a fresh budget', () => {
    const { session } = makeSessionManager();
    session.claimedMessageIds = [1];
    const first = paidSendBudgetForClaimedBatch(session);
    session.claimedMessageIds = [2];
    expect(paidSendBudgetForClaimedBatch(session)).not.toBe(first);
    session.claimedMessageIds = [];
    expect(paidSendBudgetForClaimedBatch(session)).toBeUndefined();
  });
});

describe('an output failure consumes only its own batch; the work behind it is still processed', () => {
  const LITELLM_OUTPUT_FAILURE_BODY = JSON.stringify({
    error: { code: 200, message: 'Unable to get json response - Expecting value: line 45 column 1' },
  });

  /**
   * Scripted replies through the real base-class session loop. A thrown step is
   * the exact error the OpenRouter classifier produces for litellm's 200
   * "Unable to get json" envelope.
   */
  class ScriptedObserverProvider extends OpenAICompatibleProvider<{ apiKey: string; model: string }> {
    protected readonly providerName = 'ScriptedObserver';
    protected readonly syntheticIdPrefix = 'scripted';
    readonly sentHistories: string[] = [];

    constructor(
      private readonly replySteps: Array<string | Error>,
      sessionManager: unknown,
      protected readonly forwardEmptyMessageResponse: boolean,
    ) {
      super({} as never, sessionManager as never);
    }

    protected getConfig() { return { apiKey: 'test-key', model: 'test/model' }; }
    protected missingApiKeyError(): Error { return new Error('missing key'); }
    protected estimateTokens(): number { return 0; }
    protected buildLastUsage(): ActiveSession['lastUsage'] { return null; }

    protected async query(history: ConversationMessage[]): Promise<ProviderQueryResult> {
      this.sentHistories.push(history[history.length - 1].content);
      const step = this.replySteps.shift();
      if (step instanceof Error) throw step;
      return { content: step ?? '' };
    }
  }

  function observation(toolName: string) {
    return { type: 'observation', tool_name: toolName, tool_input: {}, tool_response: {}, prompt_number: 2 };
  }

  function stubSessionManager(messages: unknown[]) {
    const confirmClaimedMessages = mock(async () => {});
    return {
      confirmClaimedMessages,
      manager: {
        getMessageIterator: async function* () { yield* messages; },
        confirmClaimedMessages,
        resetProcessingToPending: async () => {},
        getClaimedMessages: () => [],
      },
    };
  }

  function observerSession(): ActiveSession {
    return {
      sessionDbId: 4402, contentSessionId: 'output-failure', memorySessionId: 'output-failure', project: 'test',
      platformSource: 'claude', userPrompt: 'test', abortController: new AbortController(), generatorPromise: null,
      lastPromptNumber: 1, startTime: Date.now(), cumulativeInputTokens: 0, cumulativeOutputTokens: 0,
      earliestPendingTimestamp: null, claimedMessageIds: [], conversationHistory: [], currentProvider: null,
      consecutiveRestarts: 0, consecutiveInvalidOutputs: 0, lastGeneratorActivity: Date.now(),
    } as unknown as ActiveSession;
  }

  function stubModeAndSettings() {
    spyOn(ModeManager, 'getInstance').mockImplementation(() => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: { init: 'init prompt', observation: 'obs prompt', summary: 'summary prompt' },
        observation_types: [{ id: 'discovery' }],
        observation_concepts: [],
      }),
      loadMode: () => {},
    } as never));
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
    }));
  }

  for (const forwardEmptyMessageResponse of [true, false]) {
    it(`does not resend the failed batch or end the session (forwardEmptyMessageResponse=${forwardEmptyMessageResponse})`, async () => {
      stubModeAndSettings();
      const outputFailure = classifyOpenRouterError({ status: 200, bodyText: LITELLM_OUTPUT_FAILURE_BODY, cause: null });
      expect(paidSendOutcomeOf(outputFailure)).toBe('output_failure');

      const session = observerSession();
      const { manager } = stubSessionManager([observation('FailedBatchTool'), observation('NextBatchTool')]);
      // No separate init reply: by default the user prompt rides on the first
      // batch's request (CLAUDE_MEM_OBSERVE_BARE_PROMPTS).
      const observer = new ScriptedObserverProvider(
        [outputFailure, 'NEXT_BATCH_REPLY'],
        manager,
        forwardEmptyMessageResponse,
      );

      // Resolves: an unrecoverable error would have finalized the session
      // (handleSessionError rethrows) and dropped everything buffered.
      await observer.startSession(session);

      // The failed batch once + the batch behind it: nothing resent.
      expect(observer.sentHistories).toHaveLength(2);
      expect(observer.sentHistories.filter(prompt => prompt.includes('FailedBatchTool'))).toHaveLength(1);
      expect(observer.sentHistories[1]).toContain('NextBatchTool');
      expect(session.abortReason ?? null).toBeNull();
      expect(session.conversationHistory.some(turn => turn.role === 'assistant' && turn.content === 'NEXT_BATCH_REPLY')).toBe(true);
    });
  }

  it('a real OpenRouter litellm failure is sent once and charged to the batch budget', async () => {
    const fetch = scriptFetch([() => new Response(LITELLM_OUTPUT_FAILURE_BODY, { status: 200 })]);
    const budget = new PaidSendBudget(7);
    const error = await provider().runQuery(budget).catch((caught: unknown) => caught);
    expect(fetch.sends()).toBe(1);
    expect(budget.spentPaidSends).toBe(1);
    expect(isClassified(error) && error.clientAttemptId).toBe(budget.clientAttemptId);
  });
});
