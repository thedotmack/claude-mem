// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  ServerClassifiedProviderError,
  classifyHttpProviderError,
  parseRetryAfterMs,
} from '../../../src/server/generation/providers/shared/error-classification.js';
import { classifyClaudeServerError } from '../../../src/server/generation/providers/ClaudeObservationProvider.js';
import {
  ClaudeObservationProvider,
} from '../../../src/server/generation/providers/ClaudeObservationProvider.js';
import {
  GeminiObservationProvider,
  categorizeGeminiBadRequest,
  classifyGeminiServerError,
  type GeminiBadRequestCategory,
} from '../../../src/server/generation/providers/GeminiObservationProvider.js';
import { OpenRouterObservationProvider } from '../../../src/server/generation/providers/OpenRouterObservationProvider.js';
import { buildServerGenerationPrompt } from '../../../src/server/generation/providers/shared/prompt-builder.js';
import type { ServerGenerationContext } from '../../../src/server/generation/providers/shared/types.js';

function makeContext(overrides: Partial<{ payload: unknown; serverSessionId: string | null }> = {}): ServerGenerationContext {
  return {
    job: {
      id: 'job-1',
      projectId: 'proj-1',
      teamId: 'team-1',
      agentEventId: 'evt-1',
      sourceType: 'agent_event',
      sourceId: 'evt-1',
      serverSessionId: overrides.serverSessionId ?? null,
      jobType: 'observation_generate_for_event',
      status: 'processing',
      idempotencyKey: 'k',
      bullmqJobId: null,
      attempts: 1,
      maxAttempts: 3,
      nextAttemptAtEpoch: null,
      lockedAtEpoch: null,
      lockedBy: null,
      completedAtEpoch: null,
      failedAtEpoch: null,
      cancelledAtEpoch: null,
      lastError: null,
      payload: {},
      createdAtEpoch: 0,
      updatedAtEpoch: 0,
    },
    events: [
      {
        id: 'evt-1',
        projectId: 'proj-1',
        teamId: 'team-1',
        serverSessionId: overrides.serverSessionId ?? null,
        sourceAdapter: 'api',
        sourceEventId: null,
        idempotencyKey: 'k',
        eventType: 'tool_use',
        payload: overrides.payload ?? { tool: 'bash', input: 'ls' },
        metadata: {},
        occurredAtEpoch: 0,
        receivedAtEpoch: 0,
        createdAtEpoch: 0,
      },
    ],
    project: {
      projectId: 'proj-1',
      teamId: 'team-1',
      serverSessionId: overrides.serverSessionId ?? null,
      projectName: 'demo',
    },
  };
}

describe('shared error classification', () => {
  it('parseRetryAfterMs returns ms for numeric values', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it('classifyHttpProviderError returns rate_limit on 429', () => {
    const err = classifyHttpProviderError({ status: 429, cause: new Error('rl'), providerLabel: 'X' });
    expect(err.kind).toBe('rate_limit');
  });

  it('classifyHttpProviderError returns auth_invalid on 401/403', () => {
    expect(classifyHttpProviderError({ status: 401, cause: 'x', providerLabel: 'X' }).kind).toBe('auth_invalid');
    expect(classifyHttpProviderError({ status: 403, cause: 'x', providerLabel: 'X' }).kind).toBe('auth_invalid');
  });

  it('classifyHttpProviderError detects quota body markers regardless of status', () => {
    const err = classifyHttpProviderError({
      status: 500,
      bodyText: 'RESOURCE_EXHAUSTED',
      cause: new Error(''),
      providerLabel: 'Gemini',
    });
    expect(err.kind).toBe('quota_exhausted');
  });

  // Mirror of the worker classifier's OpenRouter marker list (Phase 2): the
  // "Key limit exceeded" body arrives on a 403, "Rate limit exceeded" on a
  // 429 stays a rate limit, and a bare 402 is quota with no body marker.
  it('classifyHttpProviderError maps a 403 "Key limit exceeded" body to quota_exhausted', () => {
    const err = classifyHttpProviderError({
      status: 403,
      bodyText: 'Key limit exceeded (total limit). Manage it using https://openrouter.ai/keys/abc',
      cause: new Error(''),
      providerLabel: 'OpenRouter',
    });
    expect(err.kind).toBe('quota_exhausted');
  });

  it('classifyHttpProviderError keeps a 429 "Rate limit exceeded" body as rate_limit', () => {
    const err = classifyHttpProviderError({
      status: 429,
      bodyText: 'Rate limit exceeded',
      cause: new Error(''),
      providerLabel: 'OpenRouter',
    });
    expect(err.kind).toBe('rate_limit');
  });

  it('classifyHttpProviderError maps a bare 402 to quota_exhausted', () => {
    const err = classifyHttpProviderError({
      status: 402,
      cause: new Error(''),
      providerLabel: 'OpenRouter',
    });
    expect(err.kind).toBe('quota_exhausted');
  });

  it('classifyHttpProviderError redacts fallback response bodies from message and cause', () => {
    const rawBody = 'RAW_PROVIDER_BODY with credential sk-secret';
    const err = classifyHttpProviderError({
      status: 418,
      bodyText: rawBody,
      cause: new Error(`provider said ${rawBody}`),
      providerLabel: 'Gemini',
    });
    expect(err.kind).toBe('unrecoverable');
    expect(err.message).toBe('Gemini API error (status 418)');
    expect(err.message).not.toContain(rawBody);
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain('status 418');
    expect((err.cause as Error).message).not.toContain(rawBody);
  });

  it('classifyClaudeServerError treats 529 as transient', () => {
    expect(classifyClaudeServerError({ status: 529, cause: 'x' }).kind).toBe('transient');
  });

  it('classifyClaudeServerError treats prompt-too-long as unrecoverable', () => {
    expect(
      classifyClaudeServerError({ status: 400, bodyText: 'prompt is too long', cause: 'x' }).kind,
    ).toBe('unrecoverable');
  });
});

describe('buildServerGenerationPrompt', () => {
  it('strips <private> tags from event payload before sending', () => {
    const context = makeContext({
      payload: '<private>secret</private>visible',
    });
    const result = buildServerGenerationPrompt(context);
    expect(result.prompt).not.toContain('secret');
    expect(result.prompt).toContain('visible');
    expect(result.hadPrivateContent).toBe(true);
    expect(result.skippedAll).toBe(false);
  });

  it('marks skippedAll when every event is fully private', () => {
    const context = makeContext({ payload: '<private>secret</private>' });
    const result = buildServerGenerationPrompt(context);
    expect(result.skippedAll).toBe(true);
    expect(result.hadPrivateContent).toBe(true);
  });

  it('includes generation_job_id and project metadata in the prompt', () => {
    const result = buildServerGenerationPrompt(makeContext({ serverSessionId: 'session-x' }));
    expect(result.prompt).toContain('<generation_job_id>job-1</generation_job_id>');
    expect(result.prompt).toContain('<server_session_id>session-x</server_session_id>');
    expect(result.prompt).toContain('<project_name>demo</project_name>');
  });
});

class FakeFetch {
  constructor(private readonly response: Response | (() => Response)) {}
  fetch: typeof fetch = async () => {
    return typeof this.response === 'function' ? this.response() : this.response;
  };
}

class CapturingFetch {
  lastUrl: string | undefined;
  lastInit: RequestInit | undefined;
  constructor(private readonly response: Response) {}
  fetch: typeof fetch = async (input, init) => {
    this.lastUrl = typeof input === 'string' ? input : input.toString();
    this.lastInit = init;
    return this.response;
  };
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
}

// Returns a fresh Response per call (Response bodies are single-use) and
// records every request body so a test can assert the retry budget / passthrough.
// An unexpected extra call throws rather than silently reusing a response.
class SequenceCapturingFetch {
  calls = 0;
  bodies: unknown[] = [];
  constructor(private readonly responses: Array<() => Response>) {}
  fetch: typeof fetch = async (_input, init) => {
    this.bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    const make = this.responses[this.calls];
    this.calls += 1;
    if (!make) throw new Error(`SequenceCapturingFetch: unexpected request #${this.calls}`);
    return make();
  };
}

describe('ClaudeObservationProvider', () => {
  it('returns synthetic skip when prompt builder reports skippedAll', async () => {
    const provider = new ClaudeObservationProvider({ apiKey: 'fake', fetchImpl: async () => {
      throw new Error('should not be called');
    } });
    const context = makeContext({ payload: '<private>secret</private>' });
    const result = await provider.generate(context);
    expect(result.rawText).toContain('<skip_summary');
  });

  it('parses Anthropic Messages text content into rawText', async () => {
    const fakeFetch = new FakeFetch(
      jsonResponse(200, {
        content: [
          { type: 'text', text: '<observation><type>x</type><title>t</title></observation>' },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    );
    const provider = new ClaudeObservationProvider({
      apiKey: 'sk-fake',
      fetchImpl: fakeFetch.fetch,
    });
    const result = await provider.generate(makeContext());
    expect(result.rawText).toContain('<observation>');
    expect(result.tokensUsed).toBe(30);
    expect(result.providerLabel).toBe('claude');
  });

  it('classifies non-OK responses through classifyClaudeServerError', async () => {
    const fakeFetch = new FakeFetch(jsonResponse(401, { error: { message: 'Invalid API key' } }));
    const provider = new ClaudeObservationProvider({ apiKey: 'sk-fake', fetchImpl: fakeFetch.fetch });
    await expect(provider.generate(makeContext())).rejects.toBeInstanceOf(ServerClassifiedProviderError);
  });
});

describe('GeminiObservationProvider', () => {
  const closedBadRequestCategories = new Set<GeminiBadRequestCategory>([
    'role_sequence',
    'context_limit',
    'model_unsupported',
    'api_key',
    'unknown_bad_request',
  ]);

  for (const [expectedCategory, bodyText] of [
    ['role_sequence', 'Please ensure that multiturn requests alternate between user and model.'],
    ['context_limit', 'Request contains 120000 tokens which exceeds the maximum token limit.'],
    ['model_unsupported', 'Model gemini-example is not supported for generateContent.'],
    ['api_key', 'API_KEY_INVALID: API key not valid.'],
    ['unknown_bad_request', 'Invalid JSON payload received. Unknown name "foo".'],
  ] as const) {
    it(`classifies Gemini 400 as closed category ${expectedCategory}`, () => {
      const rawBody = `${bodyText} RAW_PROVIDER_BODY`;
      const category = categorizeGeminiBadRequest(rawBody);
      const err = classifyGeminiServerError({
        status: 400,
        bodyText: rawBody,
        cause: new Error(`Gemini API error: 400 - ${rawBody}`),
      });

      expect(category).toBe(expectedCategory);
      expect(closedBadRequestCategories.has(category)).toBe(true);
      expect(err.kind).toBe('unrecoverable');
      expect(err.message).toBe(`Gemini bad request: ${expectedCategory}`);
      expect(err.message).not.toContain('RAW_PROVIDER_BODY');
      expect(err.cause).toBeInstanceOf(Error);
      expect((err.cause as Error).message).toContain('status 400');
      expect((err.cause as Error).message).not.toContain('RAW_PROVIDER_BODY');
    });
  }

  it('parses generateContent response into rawText', async () => {
    const fakeFetch = new FakeFetch(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: '<observation><type>x</type><title>g</title></observation>' }] } }],
        usageMetadata: { totalTokenCount: 42 },
      }),
    );
    const provider = new GeminiObservationProvider({ apiKey: 'fake', fetchImpl: fakeFetch.fetch });
    const result = await provider.generate(makeContext());
    expect(result.rawText).toContain('<observation>');
    expect(result.tokensUsed).toBe(42);
    expect(result.providerLabel).toBe('gemini');
  });

  it('redacts raw Gemini 400 response body from top-level message and cause', async () => {
    const rawBody = 'Please ensure that multiturn requests alternate between user and model. RAW_PROVIDER_BODY';
    const fakeFetch = new FakeFetch(new Response(rawBody, { status: 400 }));
    const provider = new GeminiObservationProvider({ apiKey: 'fake', fetchImpl: fakeFetch.fetch });

    try {
      await provider.generate(makeContext());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServerClassifiedProviderError);
      const classified = error as ServerClassifiedProviderError;
      expect(classified.kind).toBe('unrecoverable');
      expect(classified.message).toBe('Gemini bad request: role_sequence');
      expect(classified.message).not.toContain('RAW_PROVIDER_BODY');
      expect(classified.cause).toBeInstanceOf(Error);
      expect((classified.cause as Error).message).not.toContain('RAW_PROVIDER_BODY');
    }
  });

  it('redacts raw Gemini non-400 response body from top-level message and cause', async () => {
    const rawBody = 'RAW_PROVIDER_BODY with credential sk-secret';
    const fakeFetch = new FakeFetch(new Response(rawBody, { status: 418 }));
    const provider = new GeminiObservationProvider({ apiKey: 'fake', fetchImpl: fakeFetch.fetch });

    try {
      await provider.generate(makeContext());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServerClassifiedProviderError);
      const classified = error as ServerClassifiedProviderError;
      expect(classified.kind).toBe('unrecoverable');
      expect(classified.message).toBe('Gemini API error (status 418)');
      expect(classified.message).not.toContain(rawBody);
      expect(classified.cause).toBeInstanceOf(Error);
      expect((classified.cause as Error).message).toContain('status 418');
      expect((classified.cause as Error).message).not.toContain(rawBody);
    }
  });

  it('redacts raw Gemini response error message when HTTP status is OK', async () => {
    const rawMessage = 'RAW_PROVIDER_BODY from data.error.message';
    const fakeFetch = new FakeFetch(
      jsonResponse(200, {
        error: { status: 'FAILED_PRECONDITION', message: rawMessage },
      }),
    );
    const provider = new GeminiObservationProvider({ apiKey: 'fake', fetchImpl: fakeFetch.fetch });

    try {
      await provider.generate(makeContext());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServerClassifiedProviderError);
      const classified = error as ServerClassifiedProviderError;
      expect(classified.kind).toBe('unrecoverable');
      expect(classified.message).toBe('Gemini API error (status 200)');
      expect(classified.message).not.toContain(rawMessage);
      expect(classified.cause).toBeInstanceOf(Error);
      expect((classified.cause as Error).message).toContain('status 200');
      expect((classified.cause as Error).message).not.toContain(rawMessage);
    }
  });
});

describe('OpenRouterObservationProvider', () => {
  it('parses OpenAI-style response and reports tokensUsed', async () => {
    const fakeFetch = new FakeFetch(
      jsonResponse(200, {
        choices: [{ message: { content: '<observation><type>x</type><title>o</title></observation>' } }],
        usage: { total_tokens: 100 },
      }),
    );
    const provider = new OpenRouterObservationProvider({ apiKey: 'fake', fetchImpl: fakeFetch.fetch });
    const result = await provider.generate(makeContext());
    expect(result.rawText).toContain('<observation>');
    expect(result.tokensUsed).toBe(100);
    expect(result.providerLabel).toBe('openrouter');
  });

  it('classifies a 429 response as rate_limit', async () => {
    const fakeFetch = new FakeFetch(jsonResponse(429, { error: { message: 'rl' } }));
    const provider = new OpenRouterObservationProvider({ apiKey: 'fake', fetchImpl: fakeFetch.fetch });
    try {
      await provider.generate(makeContext());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServerClassifiedProviderError);
      expect((error as ServerClassifiedProviderError).kind).toBe('rate_limit');
    }
  });

  // #2382/#2590/#2622/#2393 — configurable OpenAI-compatible base URL.
  it('POSTs to the default OpenRouter URL when baseUrl is unset', async () => {
    const capturing = new CapturingFetch(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    );
    const provider = new OpenRouterObservationProvider({ apiKey: 'fake', fetchImpl: capturing.fetch });
    await provider.generate(makeContext());
    expect(capturing.lastUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('appends /chat/completions to a DeepSeek-style base URL', async () => {
    const capturing = new CapturingFetch(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    );
    const provider = new OpenRouterObservationProvider({
      apiKey: 'fake',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: capturing.fetch,
    });
    await provider.generate(makeContext());
    expect(capturing.lastUrl).toBe('https://api.deepseek.com/chat/completions');
  });

  it('uses a full chat/completions base URL verbatim and normalizes trailing slash', async () => {
    const capturing = new CapturingFetch(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    );
    const provider = new OpenRouterObservationProvider({
      apiKey: 'fake',
      baseUrl: 'http://localhost:1234/v1/chat/completions/',
      fetchImpl: capturing.fetch,
    });
    await provider.generate(makeContext());
    expect(capturing.lastUrl).toBe('http://localhost:1234/v1/chat/completions');
  });

  it('sends the configured model verbatim in the request body (#2393)', async () => {
    const capturing = new CapturingFetch(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    );
    const provider = new OpenRouterObservationProvider({
      apiKey: 'fake',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      fetchImpl: capturing.fetch,
    });
    await provider.generate(makeContext());
    const body = JSON.parse(String(capturing.lastInit?.body)) as { model?: string };
    expect(body.model).toBe('deepseek-chat');
  });
});

// #3630 — empty HTTP 200 caused by budget spent on hidden thinking/reasoning.
describe('empty-response budget-bump retry (#3630)', () => {
  it('Claude retries once with a larger budget on empty text + stop_reason=max_tokens', async () => {
    const seq = new SequenceCapturingFetch([
      () => jsonResponse(200, { content: [], stop_reason: 'max_tokens', usage: { output_tokens: 4096 } }),
      () => jsonResponse(200, {
        content: [{ type: 'text', text: '<observation><type>x</type><title>t</title></observation>' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 20 },
      }),
    ]);
    const provider = new ClaudeObservationProvider({ apiKey: 'fake', fetchImpl: seq.fetch });
    const result = await provider.generate(makeContext());
    expect(seq.calls).toBe(2);
    expect((seq.bodies[0] as { max_tokens?: number }).max_tokens).toBe(4096);
    expect((seq.bodies[1] as { max_tokens?: number }).max_tokens).toBe(8192);
    expect(result.rawText).toContain('<observation>');
  });

  it('Claude does not retry when empty text has a normal stop reason', async () => {
    const seq = new SequenceCapturingFetch([
      () => jsonResponse(200, { content: [], stop_reason: 'end_turn' }),
    ]);
    const provider = new ClaudeObservationProvider({ apiKey: 'fake', fetchImpl: seq.fetch });
    const result = await provider.generate(makeContext());
    expect(seq.calls).toBe(1);
    expect(result.rawText).toBe('');
  });

  it('Claude does not retry when an empty response carries no stop reason', async () => {
    const seq = new SequenceCapturingFetch([
      () => jsonResponse(200, { content: [] }),
    ]);
    const provider = new ClaudeObservationProvider({ apiKey: 'fake', fetchImpl: seq.fetch });
    const result = await provider.generate(makeContext());
    expect(seq.calls).toBe(1);
    expect(result.rawText).toBe('');
  });

  it('Claude keeps the retry budget even when providerParams also sets max_tokens', async () => {
    const seq = new SequenceCapturingFetch([
      () => jsonResponse(200, { content: [], stop_reason: 'max_tokens' }),
      () => jsonResponse(200, { content: [{ type: 'text', text: '<observation><type>x</type><title>t</title></observation>' }] }),
    ]);
    const provider = new ClaudeObservationProvider({
      apiKey: 'fake',
      providerParams: { max_tokens: 123 },
      fetchImpl: seq.fetch,
    });
    const result = await provider.generate(makeContext());
    expect(seq.calls).toBe(2);
    expect((seq.bodies[0] as { max_tokens?: number }).max_tokens).toBe(4096);
    expect((seq.bodies[1] as { max_tokens?: number }).max_tokens).toBe(8192);
    expect(result.rawText).toContain('<observation>');
  });

  it('Claude merges providerParams into the request body', async () => {
    const capturing = new CapturingFetch(
      jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] }),
    );
    const provider = new ClaudeObservationProvider({
      apiKey: 'fake',
      providerParams: { thinking: { type: 'disabled' } },
      fetchImpl: capturing.fetch,
    });
    await provider.generate(makeContext());
    const body = JSON.parse(String(capturing.lastInit?.body)) as { thinking?: unknown };
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('OpenRouter retries once with a larger budget on empty text + finish_reason=length', async () => {
    const seq = new SequenceCapturingFetch([
      () => jsonResponse(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
      () => jsonResponse(200, {
        choices: [{ message: { content: '<observation><type>x</type><title>o</title></observation>' }, finish_reason: 'stop' }],
        usage: { total_tokens: 30 },
      }),
    ]);
    const provider = new OpenRouterObservationProvider({ apiKey: 'fake', fetchImpl: seq.fetch });
    const result = await provider.generate(makeContext());
    expect(seq.calls).toBe(2);
    expect((seq.bodies[1] as { max_tokens?: number }).max_tokens).toBe(8192);
    expect(result.rawText).toContain('<observation>');
  });

  it('OpenRouter merges providerParams into the request body', async () => {
    const capturing = new CapturingFetch(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    );
    const provider = new OpenRouterObservationProvider({
      apiKey: 'fake',
      providerParams: { reasoning: { effort: 'none' } },
      fetchImpl: capturing.fetch,
    });
    await provider.generate(makeContext());
    const body = JSON.parse(String(capturing.lastInit?.body)) as { reasoning?: unknown };
    expect(body.reasoning).toEqual({ effort: 'none' });
  });

  it('Gemini retries once with a larger budget on empty text + finishReason=MAX_TOKENS', async () => {
    const seq = new SequenceCapturingFetch([
      () => jsonResponse(200, { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }),
      () => jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: '<observation><type>x</type><title>g</title></observation>' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 40 },
      }),
    ]);
    const provider = new GeminiObservationProvider({ apiKey: 'fake', fetchImpl: seq.fetch });
    const result = await provider.generate(makeContext());
    expect(seq.calls).toBe(2);
    const secondConfig = (seq.bodies[1] as { generationConfig?: { maxOutputTokens?: number } }).generationConfig;
    expect(secondConfig?.maxOutputTokens).toBe(8192);
    expect(result.rawText).toContain('<observation>');
  });

  it('Gemini merges providerParams into generationConfig', async () => {
    const capturing = new CapturingFetch(
      jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );
    const provider = new GeminiObservationProvider({
      apiKey: 'fake',
      providerParams: { thinkingConfig: { thinkingBudget: 0 } },
      fetchImpl: capturing.fetch,
    });
    await provider.generate(makeContext());
    const body = JSON.parse(String(capturing.lastInit?.body)) as { generationConfig?: { thinkingConfig?: unknown } };
    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
});
