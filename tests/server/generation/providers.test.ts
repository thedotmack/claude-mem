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
import { GeminiObservationProvider } from '../../../src/server/generation/providers/GeminiObservationProvider.js';
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

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
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
});
