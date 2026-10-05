import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { OpenAICompatProvider, classifyOpenAICompatError } from '../../src/services/worker/OpenAICompatProvider.js';
import type { ProviderQueryResult } from '../../src/services/worker/OpenAICompatibleProvider.js';
import { isClassified, paidSendOutcomeOf } from '../../src/services/worker/provider-errors.js';
import { PaidSendBudget } from '../../src/services/worker/paid-send-budget.js';
import { STREAM_INTERRUPTED_CODE, resetStreamingEndpointMemoryForTests, sendChatCompletion } from '../../src/services/worker/streamed-chat-completion.js';
import { logger } from '../../src/utils/logger.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';
import {
  createStreamFetchMock,
  trackLiveTimers,
  type LiveTimerTracker,
  type StreamBodyStep,
  type StreamFetchScript,
} from '../helpers/stream-fetch-mock.js';

/**
 * Phase 3 "secret stream": OpenRouter and openai-compatible requests are
 * streamed and judged by liveness. Real but short intervals stand in for the
 * production 90s idle window (see stream-fetch-mock.ts on fake timers).
 */

const IDLE_MS = 80;
const HISTORY: ConversationMessage[] = [{ role: 'user', content: 'observe this' }];
const SSE_HEADERS = { 'content-type': 'text/event-stream' };

const OPENROUTER_CONFIG = {
  apiKey: 'test-key',
  apiKeys: ['test-key'],
  model: 'test/model',
  fallbackModels: [],
  apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
};

const COMPAT_CONFIG = {
  apiKey: 'compat-key',
  apiKeys: ['compat-key'],
  model: 'compat-model',
  apiUrl: 'https://compat.example/v1/chat/completions',
  requiresApiKey: true,
  preset: { id: 'custom', label: 'Compat Endpoint' },
};

class TestOpenRouterProvider extends OpenRouterProvider {
  constructor() {
    super({} as never, {} as never);
    this.streamIdleTimeoutMs = IDLE_MS;
  }
  runQuery(paidSendBudget?: PaidSendBudget): Promise<ProviderQueryResult> {
    return this.query(HISTORY, OPENROUTER_CONFIG as never, undefined, undefined, paidSendBudget);
  }
}

class TestOpenAICompatProvider extends OpenAICompatProvider {
  constructor() {
    super({} as never, {} as never);
    this.streamIdleTimeoutMs = IDLE_MS;
  }
  runQuery(paidSendBudget?: PaidSendBudget): Promise<ProviderQueryResult> {
    return this.query(HISTORY, COMPAT_CONFIG as never, undefined, undefined, paidSendBudget);
  }
}

const sse = (payload: unknown): StreamBodyStep => ({ chunk: `data: ${JSON.stringify(payload)}\n\n` });
const done: StreamBodyStep = { chunk: 'data: [DONE]\n\n' };
const delta = (content: string): StreamBodyStep =>
  sse({ id: 'gen-1', model: 'served/model', choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const finish = (reason: string): StreamBodyStep =>
  sse({ id: 'gen-1', model: 'served/model', choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usage = (extra: Record<string, unknown> = {}): StreamBodyStep =>
  sse({ id: 'gen-1', model: 'served/model', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, ...extra } });

const streamScript = (body: StreamBodyStep[]): StreamFetchScript => ({ headers: SSE_HEADERS, body });

function installFetch(...scripts: StreamFetchScript[]) {
  const mock = createStreamFetchMock(...scripts);
  spyOn(globalThis, 'fetch').mockImplementation(mock.fetch);
  return mock;
}

const sentBody = (mock: ReturnType<typeof createStreamFetchMock>, index = 0) =>
  JSON.parse(String(mock.calls[index].init?.body)) as Record<string, unknown>;

let timers: LiveTimerTracker | null = null;
const priorLlmTimeout = process.env.CLAUDE_MEM_LLM_TIMEOUT_MS;

afterEach(() => {
  resetStreamingEndpointMemoryForTests();
  timers?.restore();
  timers = null;
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
  if (priorLlmTimeout === undefined) delete process.env.CLAUDE_MEM_LLM_TIMEOUT_MS;
  else process.env.CLAUDE_MEM_LLM_TIMEOUT_MS = priorLlmTimeout;
});

describe('OpenRouter secret stream', () => {
  it('asks for a stream with usage on the final chunk', async () => {
    const mock = installFetch(streamScript([delta('<observation/>'), finish('stop'), usage(), done]));
    await new TestOpenRouterProvider().runQuery();
    const body = sentBody(mock);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('a slow-but-alive stream (pings far past the idle window and the old deadline) succeeds', async () => {
    // The old per-attempt deadline (here its 500ms minimum) is not a
    // wall-clock limit on a stream any more; only silence ends it.
    process.env.CLAUDE_MEM_LLM_TIMEOUT_MS = '500';
    timers = trackLiveTimers();
    const mock = installFetch(streamScript([
      { pings: 35, intervalMs: 20, text: ': OPENROUTER PROCESSING\n\n' },
      delta('<observation>'),
      { pings: 5, intervalMs: 20, text: ': OPENROUTER PROCESSING\n\n' },
      delta('slow</observation>'),
      finish('stop'),
      usage(),
      done,
    ]));
    const startedAt = Date.now();
    const result = await new TestOpenRouterProvider().runQuery();
    expect(Date.now() - startedAt).toBeGreaterThan(500);
    expect(result.content).toBe('<observation>slow</observation>');
    expect(mock.calls).toHaveLength(1);
    expect(timers.liveCount()).toBe(0);
  });

  it('assembles the deltas and captures usage, cost, finish_reason and the served model', async () => {
    installFetch(streamScript([
      delta('<observation>'),
      delta('part two'),
      delta('</observation>'),
      finish('length'),
      usage({ cost: 0.002, cost_details: { upstream_inference_cost: 0.001 } }),
      done,
    ]));
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const result = await new TestOpenRouterProvider().runQuery();
      expect(result.content).toBe('<observation>part two</observation>');
      expect(result.inputTokens).toBe(11);
      expect(result.outputTokens).toBe(7);
      expect(result.tokensUsed).toBe(18);
      expect(result.costUsd).toBeCloseTo(0.003, 10);
      expect(result.servedModel).toBe('served/model');
      expect(result.finishReason).toBe('length');
      // The cut-off warning reads the same fields it read off a JSON reply.
      const cutOff = warn.mock.calls.find(([, message]) => String(message).includes('cut off'));
      expect(cutOff?.[2]).toMatchObject({ model: 'served/model', outputTokens: 7, contentChars: '<observation>part two</observation>'.length });
    } finally {
      warn.mockRestore();
    }
  });

  it('silence after output started trips the idle timer once and is never resent', async () => {
    timers = trackLiveTimers();
    const mock = installFetch(streamScript([delta('<observation>half'), { hang: true }]));
    const budget = new PaidSendBudget(1);
    const error = await new TestOpenRouterProvider().runQuery(budget).catch((caught: unknown) => caught);
    expect(mock.calls).toHaveLength(1);
    expect(paidSendOutcomeOf(error)).toBe('output_failure');
    expect(isClassified(error) && error.code).toBe(STREAM_INTERRUPTED_CODE);
    expect(String((error as Error).message)).toContain(`timed out after ${IDLE_MS}ms idle`);
    expect(budget.spentPaidSends).toBe(1);
    expect(timers.liveCount()).toBe(0);
  });

  it('silence before any output is ambiguous and resent once, charged to the batch budget', async () => {
    const mock = installFetch(
      streamScript([{ pings: 1, intervalMs: 10 }, { hang: true }]),
      streamScript([delta('<observation/>'), finish('stop'), done]),
    );
    const budget = new PaidSendBudget(1);
    const result = await new TestOpenRouterProvider().runQuery(budget);
    expect(result.content).toBe('<observation/>');
    expect(mock.calls).toHaveLength(2);
    expect(budget.spentPaidSends).toBe(2);
    // Both sends carry the batch's tracing id.
    for (const call of mock.calls) {
      expect((call.init?.headers as Record<string, string>)['x-client-request-id']).toBe(budget.clientAttemptId);
    }
  });

  it('a network failure before the first delta is resent only once', async () => {
    const mock = installFetch({ failBeforeHeaders: new TypeError('fetch failed') });
    const error = await new TestOpenRouterProvider().runQuery().catch((caught: unknown) => caught);
    expect(mock.calls).toHaveLength(2);
    expect(paidSendOutcomeOf(error)).toBe('ambiguous');
    expect(isClassified(error) && error.failedBeforeOutput).toBe(true);
  });

  it('a failure before the first delta is not resent when the batch budget is spent', async () => {
    const mock = installFetch({ hangBeforeHeaders: true });
    const budget = new PaidSendBudget(1);
    budget.recordPaidSend(); // an earlier send of this batch (e.g. before a transport resume)
    const error = await new TestOpenRouterProvider().runQuery(budget).catch((caught: unknown) => caught);
    expect(mock.calls).toHaveLength(1);
    expect(paidSendOutcomeOf(error)).toBe('ambiguous');
    expect(String((error as Error).message)).toContain('idle');
    expect(budget.spentPaidSends).toBe(2);
  });

  it('a stream that ends early after output started is an output failure', async () => {
    const mock = installFetch(streamScript([delta('<observation>cut')]));
    const error = await new TestOpenRouterProvider().runQuery().catch((caught: unknown) => caught);
    expect(mock.calls).toHaveLength(1);
    expect(paidSendOutcomeOf(error)).toBe('output_failure');
  });

  it('a mid-stream error before any output is classified as a 200 carrying it was', async () => {
    const mock = installFetch(streamScript([
      sse({ error: { code: 402, message: 'Insufficient credits. Add more using https://openrouter.ai/credits' } }),
    ]));
    const error = await new TestOpenRouterProvider().runQuery().catch((caught: unknown) => caught);
    expect(mock.calls).toHaveLength(1);
    expect(isClassified(error) && error.kind).toBe('quota_exhausted');
  });

  it('a mid-stream error after output started is an output failure, never resent', async () => {
    const mock = installFetch(streamScript([
      delta('<observation>'),
      sse({ error: { code: 'server_error', message: 'Provider disconnected' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] }),
    ]));
    const error = await new TestOpenRouterProvider().runQuery().catch((caught: unknown) => caught);
    expect(mock.calls).toHaveLength(1);
    expect(paidSendOutcomeOf(error)).toBe('output_failure');
    expect(String((error as Error).message)).toContain('Provider disconnected');
  });

  it('reads one JSON body from a backend that ignores stream: true', async () => {
    installFetch({
      headers: { 'content-type': 'application/json' },
      body: [{ chunk: JSON.stringify({ model: 'json/model', choices: [{ message: { content: '<observation/>' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) }],
    });
    const result = await new TestOpenRouterProvider().runQuery();
    expect(result).toMatchObject({ content: '<observation/>', servedModel: 'json/model', inputTokens: 3, outputTokens: 2, finishReason: 'stop' });
  });
});

describe('openai-compatible secret stream', () => {
  it('streams, assembles the reply (leading think block removed) and captures usage', async () => {
    const mock = installFetch(streamScript([
      { chunk: ': keep-alive\n\n' },
      delta('<think>planning</think>'),
      delta('<observation/>'),
      finish('stop'),
      usage(),
      done,
    ]));
    const result = await new TestOpenAICompatProvider().runQuery();
    const body = sentBody(mock);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(result).toMatchObject({ content: '<observation/>', inputTokens: 11, outputTokens: 7, tokensUsed: 18, servedModel: 'served/model', finishReason: 'stop' });
  });

  it('classifies a mid-stream error before output with its own classifier', async () => {
    installFetch(streamScript([sse({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } })]));
    const error = await new TestOpenAICompatProvider().runQuery().catch((caught: unknown) => caught);
    expect(isClassified(error) && error.kind).toBe('quota_exhausted');
  });

  it('resends max_completion_tokens when a streamed request is refused for max_tokens (#4003)', async () => {
    const mock = installFetch(
      {
        status: 400,
        body: [{ chunk: JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", param: 'max_tokens', code: 'unsupported_parameter' } }) }],
      },
      streamScript([delta('ok'), finish('stop'), done]),
    );
    const result = await new TestOpenAICompatProvider().runQuery();
    expect(result.content).toBe('ok');
    expect(sentBody(mock, 0).max_tokens).toBeDefined();
    expect(sentBody(mock, 1).max_tokens).toBeUndefined();
    expect(sentBody(mock, 1).max_completion_tokens).toBeDefined();
  });

  it('silence after output started is an output failure, sent once', async () => {
    const mock = installFetch(streamScript([delta('<observation>'), { hang: true }]));
    const error = await new TestOpenAICompatProvider().runQuery().catch((caught: unknown) => caught);
    expect(mock.calls).toHaveLength(1);
    expect(paidSendOutcomeOf(error)).toBe('output_failure');
  });

  it('a 400 refusing stream_options is resent once non-streamed, and the endpoint is not streamed again', async () => {
    const info = spyOn(logger, 'info');
    try {
      const mock = installFetch(
        {
          status: 400,
          body: [{ chunk: JSON.stringify({ object: 'error', message: '[{"type":"extra_forbidden","loc":["body","stream_options"],"msg":"Extra inputs are not permitted"}]' }) }],
        },
        { headers: { 'content-type': 'application/json' }, body: [{ chunk: JSON.stringify({ choices: [{ message: { content: 'first' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) }] },
        { headers: { 'content-type': 'application/json' }, body: [{ chunk: JSON.stringify({ choices: [{ message: { content: 'second' }, finish_reason: 'stop' }] }) }] },
      );
      const budget = new PaidSendBudget(1);
      const first = await new TestOpenAICompatProvider().runQuery(budget);
      expect(first).toMatchObject({ content: 'first', inputTokens: 3, outputTokens: 2 });
      // The refusal is free: only the answered send is charged.
      expect(budget.spentPaidSends).toBe(1);
      expect(sentBody(mock, 0).stream).toBe(true);
      expect(sentBody(mock, 1).stream).toBeUndefined();
      expect(sentBody(mock, 1).stream_options).toBeUndefined();
      expect(sentBody(mock, 1).max_tokens).toBeDefined();

      // A later query (a new provider instance, same endpoint) goes straight to the plain body.
      const second = await new TestOpenAICompatProvider().runQuery();
      expect(second.content).toBe('second');
      expect(mock.calls).toHaveLength(3);
      expect(sentBody(mock, 2).stream).toBeUndefined();
      expect(sentBody(mock, 2).stream_options).toBeUndefined();

      const refusalLogs = info.mock.calls.filter(call => String(call[1]).includes('refused streamed requests'));
      expect(refusalLogs).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });

  it('a 400 that names only an upstream failure is not taken for a streaming refusal', async () => {
    const mock = installFetch({
      status: 400,
      body: [{ chunk: JSON.stringify({ error: { message: 'upstream rejected the prompt', code: 'bad_request' } }) }],
    });
    const error = await new TestOpenAICompatProvider().runQuery().catch((caught: unknown) => caught);
    expect(mock.calls).toHaveLength(1);
    expect(isClassified(error)).toBe(true);
  });

  it('a stream with no usage chunk still returns the reply and warns once for the endpoint', async () => {
    const warn = spyOn(logger, 'warn');
    try {
      installFetch(
        streamScript([delta('<observation/>'), finish('stop'), done]),
        streamScript([delta('<observation/>'), finish('stop'), done]),
      );
      const first = await new TestOpenAICompatProvider().runQuery();
      const second = await new TestOpenAICompatProvider().runQuery();
      expect(first.content).toBe('<observation/>');
      expect(second.content).toBe('<observation/>');
      expect(first.inputTokens).toBeUndefined();
      expect(first.tokensUsed).toBeUndefined();
      const usageWarnings = warn.mock.calls.filter(call => String(call[1]).includes('no usage chunk'));
      expect(usageWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('non-streamed sends (liveness null: the cmem gateway, endpoints that refused streaming)', () => {
  it('releases the response body when a JSON reply breaks off mid-read', async () => {
    const mock = createStreamFetchMock({
      headers: { 'content-type': 'application/json' },
      body: [{ chunk: '{"choices":[' }, { fail: new TypeError('connection reset') }],
    });
    const responses: Response[] = [];
    spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await mock.fetch(input, init);
      responses.push(response);
      return response;
    });
    const label = COMPAT_CONFIG.preset.label;
    const error = await sendChatCompletion({
      url: COMPAT_CONFIG.apiUrl,
      headers: { 'Content-Type': 'application/json' },
      body: { model: COMPAT_CONFIG.model, messages: [] },
      maxOutputTokens: 64,
      signal: new AbortController().signal,
      liveness: null,
      label,
      classify: (input) => classifyOpenAICompatError({ ...input, endpointLabel: label, requestUrl: COMPAT_CONFIG.apiUrl }),
    }).catch((caught: unknown) => caught);
    expect(mock.calls).toHaveLength(1);
    expect(paidSendOutcomeOf(error)).toBe('output_failure');
    expect(String((error as Error).message)).toContain('connection reset');
    // Cancelling an errored body rejects with its error; the reader lock is released anyway.
    expect(responses[0].body?.locked).toBe(false);
  });
});
