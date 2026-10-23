// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { OpenAICompatProvider } from '../../src/services/worker/OpenAICompatProvider.js';
import {
  OpenRouterProvider,
  buildOpenRouterRequestBody,
} from '../../src/services/worker/OpenRouterProvider.js';
import { GeminiProvider } from '../../src/services/worker/GeminiProvider.js';
import { OpenRouterObservationProvider } from '../../src/server/generation/providers/OpenRouterObservationProvider.js';
import { resolveOpenAICompatPreset } from '../../src/shared/openai-compat-presets.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { logger } from '../../src/utils/logger.js';
import { getAuthMethodDescription } from '../../src/shared/EnvManager.js';
import { describeObserverAuthMethod } from '../../src/services/worker/observer-auth-method.js';
import { PaidSendBudget } from '../../src/services/worker/paid-send-budget.js';
import {
  endpointRejectsReasoningField,
  isUnknownReasoningParameter,
  resetReasoningFieldRejectionsForTesting,
} from '../../src/services/worker/reasoning-budget.js';
import {
  markEndpointRefusesStreamingForTests,
  resetStreamingEndpointMemoryForTests,
} from '../../src/services/worker/streamed-chat-completion.js';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';

/**
 * A reasoning-by-default model spends max_tokens on reasoning and returns
 * empty content with finish_reason=length unless the request disables
 * reasoning. These tests are the repro: they fail on the pre-fix client,
 * which neither sends reasoning:{enabled:false} on observation turns nor
 * retries a length-truncated empty reply.
 */

const OBSERVATION = '<observation><title>Kept the answer</title><narrative>Reasoning was disabled, so the observer wrote this.</narrative></observation>';

type Body = Record<string, unknown>;

function reasoningDisabled(body: Body): boolean {
  const reasoning = body.reasoning;
  if (!reasoning || typeof reasoning !== 'object') return false;
  return (reasoning as { enabled?: unknown }).enabled === false;
}

function lengthBurn(body: Body): Body {
  const max = typeof body.max_tokens === 'number' ? body.max_tokens : 4096;
  return {
    model: body.model,
    choices: [{
      message: { role: 'assistant', content: '', reasoning: 'x'.repeat(40), reasoning_content: 'spent the budget thinking' },
      finish_reason: 'length',
    }],
    usage: {
      prompt_tokens: 800,
      completion_tokens: max,
      total_tokens: 800 + max,
      completion_tokens_details: { reasoning_tokens: max },
    },
  };
}

function observationReply(body: Body): Body {
  return {
    model: body.model,
    choices: [{ message: { role: 'assistant', content: OBSERVATION }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 800, completion_tokens: 40, total_tokens: 840 },
  };
}

/** Scripted chat-completions endpoint: empty+length unless reasoning is disabled. */
async function startReasoningServer(mode: 'honor-disable' | 'always-burn' | 'reject-reasoning-field' | 'reject-unsupported-parameter' | 'reject-mandatory-reasoning') {
  const bodies: Body[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Body;
      bodies.push(body);
      let payload: Body;
      let status = 200;
      if (mode === 'reject-reasoning-field' && 'reasoning' in body) {
        status = 400;
        payload = { error: { message: "Unknown parameter: 'reasoning'. Extra fields are not permitted.", type: 'invalid_request_error', code: 'unknown_parameter' } };
      } else if (mode === 'reject-unsupported-parameter' && 'reasoning' in body) {
        status = 400;
        payload = { error: { message: "Unsupported parameter: 'reasoning'", type: 'invalid_request_error', code: 'unsupported_parameter' } };
      } else if (mode === 'reject-mandatory-reasoning' && 'reasoning' in body) {
        status = 400;
        payload = { error: { message: "Invalid parameter: reasoning.effort 'none' is unsupported for this model", type: 'invalid_request_error' } };
      } else if (
        mode !== 'reject-reasoning-field'
        && mode !== 'reject-unsupported-parameter'
        && mode !== 'reject-mandatory-reasoning'
        && (mode === 'always-burn' || !reasoningDisabled(body))
      ) {
        payload = lengthBurn(body);
      } else {
        payload = observationReply(body);
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  return {
    bodies,
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function compatConfig(url: string) {
  return {
    apiKey: 'fixture-not-a-secret',
    apiKeys: ['fixture-not-a-secret'],
    model: 'deepseek-v4-flash',
    apiUrl: url,
    preset: resolveOpenAICompatPreset('custom'),
    requiresApiKey: true,
  };
}

type QueryResult = {
  content: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  tokensUsed?: number;
};

function queryCompat(url: string, budget?: PaidSendBudget) {
  return (new OpenAICompatProvider({} as never, {} as never) as unknown as {
    query(h: unknown[], c: unknown, signal?: AbortSignal, perAttemptTimeoutMs?: number, paidSendBudget?: PaidSendBudget): Promise<QueryResult>;
  }).query(
    [{ role: 'user', content: 'Observe this tool call and write one observation.' }],
    compatConfig(url),
    undefined,
    undefined,
    budget,
  );
}

function queryOpenRouter(url: string, extra: Record<string, unknown> = {}, budget?: PaidSendBudget, timeoutMs?: number) {
  return (new OpenRouterProvider({} as never, {} as never) as unknown as {
    query(h: unknown[], c: unknown, signal?: AbortSignal, perAttemptTimeoutMs?: number, paidSendBudget?: PaidSendBudget): Promise<QueryResult>;
  }).query([{ role: 'user', content: 'Observe this tool call and write one observation.' }], {
    apiKey: 'sk-or-v1-fixture',
    model: 'deepseek/deepseek-v4-flash',
    fallbackModels: [],
    apiUrl: url,
    ...extra,
  }, undefined, timeoutMs, budget);
}

function hangUntilAbort(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('retry was not aborted')), 3000);
    const signal = init?.signal;
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

describe('reasoning budget exhaustion', () => {
  let settingsOverrides: Record<string, string> = {};
  const spies: Array<{ mockRestore(): void }> = [];

  beforeEach(() => {
    settingsOverrides = {};
    spies.push(spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      ...settingsOverrides,
    }) as ReturnType<typeof SettingsDefaultsManager.loadFromFile>));
  });

  afterEach(() => {
    resetReasoningFieldRejectionsForTesting();
    resetStreamingEndpointMemoryForTests();
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  it('sends reasoning disabled on OpenRouter and cmem observation requests by default', () => {
    const label = { kind: 'observation' as const, sessionId: 'sess' };
    const openrouter = buildOpenRouterRequestBody({
      model: 'deepseek/deepseek-v4-flash',
      fallbackModels: [],
      messages: [{ role: 'user', content: 'observe' }],
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
      label,
    });
    const cmem = buildOpenRouterRequestBody({
      model: 'cmem-observer',
      fallbackModels: [],
      messages: [{ role: 'user', content: 'observe' }],
      apiUrl: 'https://cmem.ai/api/inference/v1/chat/completions',
      label,
    });
    expect(openrouter.reasoning).toEqual({ enabled: false });
    expect(cmem.reasoning).toEqual({ enabled: false });
    expect(openrouter.max_tokens).toBe(4096);
  });

  it('openai-compatible: a mock reasoning model returns the observation once reasoning is off', async () => {
    const server = await startReasoningServer('honor-disable');
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    spies.push(errorSpy);
    try {
      const result = await queryCompat(server.url);
      expect(server.bodies[0]?.reasoning).toEqual({ enabled: false });
      expect(result.content).toContain('<observation>');
      expect(result.content).toContain('Kept the answer');
      expect(server.bodies).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('openai-compatible: reasoning=on burns the budget, logs, and retries with reasoning off', async () => {
    settingsOverrides.CLAUDE_MEM_OPENAI_COMPAT_REASONING = 'on';
    const server = await startReasoningServer('honor-disable');
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    spies.push(errorSpy);
    try {
      const result = await queryCompat(server.url);
      expect(reasoningDisabled(server.bodies[0] ?? {})).toBe(false);
      expect(server.bodies[1]?.reasoning).toEqual({ enabled: false });
      expect(result.content).toContain('Kept the answer');
      expect(errorSpy.mock.calls.some(call => String(call[1]).includes('output budget'))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('openai-compatible: an OpenAI-style unsupported parameter is retried without the field', async () => {
    const server = await startReasoningServer('reject-unsupported-parameter');
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    spies.push(warnSpy);
    try {
      const result = await queryCompat(server.url);
      expect('reasoning' in (server.bodies[0] ?? {})).toBe(true);
      expect('reasoning' in (server.bodies[1] ?? {})).toBe(false);
      expect(result.content).toContain('Kept the answer');
      expect(endpointRejectsReasoningField(server.url)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('openai-compatible: a strict server that rejects the reasoning field is retried without it', async () => {
    const server = await startReasoningServer('reject-reasoning-field');
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    spies.push(warnSpy);
    try {
      const result = await queryCompat(server.url);
      expect('reasoning' in (server.bodies[0] ?? {})).toBe(true);
      expect('reasoning' in (server.bodies[1] ?? {})).toBe(false);
      expect(result.content).toContain('Kept the answer');
    } finally {
      await server.close();
    }
  });

  it('openai-compatible: empty+length after reasoning was already disabled is one loud failure, not a loop', async () => {
    const server = await startReasoningServer('always-burn');
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    spies.push(errorSpy);
    try {
      const result = await queryCompat(server.url);
      expect(result.content).toBe('');
      expect(server.bodies).toHaveLength(1);
      expect(server.bodies[0]?.reasoning).toEqual({ enabled: false });
      const messages = errorSpy.mock.calls.map(call => String(call[1]));
      expect(messages.some(message => message.includes('output budget'))).toBe(true);
      expect(messages.some(message => message.includes('no observations'))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('OpenRouter custom gateway: empty+length retries once with reasoning disabled', async () => {
    const server = await startReasoningServer('honor-disable');
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    spies.push(errorSpy);
    try {
      const result = await queryOpenRouter(server.url);
      expect(reasoningDisabled(server.bodies[0] ?? {})).toBe(false);
      expect(server.bodies[1]?.reasoning).toEqual({ enabled: false });
      expect(result.content).toContain('Kept the answer');
      expect(errorSpy.mock.calls.some(call => String(call[1]).includes('output budget'))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('openrouter.ai and the cmem gateway get the observation on the first request', async () => {
    const seen: Body[] = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as Body;
      seen.push(body);
      const payload = reasoningDisabled(body) ? observationReply(body) : lengthBurn(body);
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    spies.push(fetchSpy);
    try {
      const openrouter = await queryOpenRouter('https://openrouter.ai/api/v1/chat/completions');
      const cmem = await queryOpenRouter('https://cmem.ai/api/inference/v1/chat/completions', { model: 'cmem-observer' });
      expect(openrouter.content).toContain('Kept the answer');
      expect(cmem.content).toContain('Kept the answer');
      expect(seen).toHaveLength(2);
      expect(seen.every(reasoningDisabled)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('Gemini: empty MAX_TOKENS retries once with thinking disabled', async () => {
    const bodies: Body[] = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as Body;
      bodies.push(body);
      const config = body.generationConfig as { thinkingConfig?: { thinkingBudget?: number } } | undefined;
      const disabled = config?.thinkingConfig?.thinkingBudget === 0;
      const payload = disabled
        ? { candidates: [{ content: { parts: [{ text: OBSERVATION }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } }
        : { candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, thoughtsTokenCount: 4096, totalTokenCount: 4106 } };
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    spies.push(fetchSpy);
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    spies.push(errorSpy);
    try {
      const provider = new GeminiProvider({} as never, {} as never) as unknown as {
        query(h: unknown[], c: unknown): Promise<QueryResult>;
      };
      const result = await provider.query(
        [{ role: 'user', content: 'Observe this tool call.' }],
        { apiKey: 'fixture-gemini', apiKeys: ['fixture-gemini'], model: 'gemini-2.5-flash', rateLimitingEnabled: false },
      );
      expect(result.content).toContain('Kept the answer');
      // First reply billed 4096 thought tokens; the retry billed 20 answer tokens.
      // Context size stays the retry's prompt.
      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(4116);
      expect(bodies).toHaveLength(2);
      expect((bodies[1]?.generationConfig as { thinkingConfig?: { thinkingBudget?: number } }).thinkingConfig).toEqual({ thinkingBudget: 0 });
      expect(errorSpy.mock.calls.some(call => String(call[1]).includes('output budget'))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('server runtime OpenRouter retries an empty length reply with reasoning disabled', async () => {
    const bodies: Body[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      const payload = reasoningDisabled(body) ? observationReply(body) : lengthBurn(body);
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    spies.push(errorSpy);
    const provider = new OpenRouterObservationProvider({
      apiKey: 'sk-or-v1-fixture',
      baseUrl: 'https://gateway.example/v1',
      model: 'deepseek-v4-flash',
      fetchImpl,
    });
    const context = {
      job: { id: 'job-1' },
      events: [{
        id: 'evt-1', eventType: 'tool_use', payload: { tool: 'bash', input: 'ls' }, metadata: {},
        occurredAtEpoch: 0,
      }],
      project: { projectName: 'demo' },
    };
    const result = await provider.generate(context as never);
    expect(result.rawText).toContain('Kept the answer');
    expect(reasoningDisabled(bodies[0] ?? {})).toBe(false);
    expect(bodies[1]?.reasoning).toEqual({ enabled: false });
    // Both calls were metered: the empty length reply (800 + 4096) and the observation (840).
    expect(result.tokensUsed).toBe(800 + 4096 + 840);
  });

  it('counts the reasoning retry on the paid-send budget and sums billed output', async () => {
    const server = await startReasoningServer('honor-disable');
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    spies.push(errorSpy);
    const budget = new PaidSendBudget(1, 2);
    try {
      const result = await queryOpenRouter(server.url, {}, budget);
      expect(result.content).toContain('Kept the answer');
      expect(server.bodies).toHaveLength(2);
      expect(budget.spentPaidSends).toBe(2);
      expect(result.inputTokens).toBe(800);
      expect(result.outputTokens).toBe(4096 + 40);
    } finally {
      await server.close();
    }
  });

  it('does not buy a third paid send once the allowance is spent', async () => {
    const server = await startReasoningServer('honor-disable');
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    spies.push(errorSpy);
    const openRouter = new PaidSendBudget(1, 1);
    const compat = new PaidSendBudget(1, 1);
    settingsOverrides.CLAUDE_MEM_OPENAI_COMPAT_REASONING = 'on';
    try {
      const openRouterResult = await queryOpenRouter(server.url, {}, openRouter);
      expect(openRouterResult.content).toBe('');
      expect(openRouter.spentPaidSends).toBe(1);
      const compatResult = await queryCompat(server.url, compat);
      expect(compatResult.content).toBe('');
      expect(compat.spentPaidSends).toBe(1);
      expect(server.bodies).toHaveLength(2);
      expect(errorSpy.mock.calls.filter(call => String(call[1]).includes('paid sends'))).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('adds both requests costs and keeps the retry prompt size', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as Body;
      const payload = reasoningDisabled(body)
        ? {
          model: body.model,
          choices: [{ message: { role: 'assistant', content: OBSERVATION }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.02 },
        }
        : {
          model: body.model,
          choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 90, completion_tokens: 50, total_tokens: 140, cost: 0.01, cost_details: { upstream_inference_cost: 0.005 } },
        };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    spies.push(fetchSpy);
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    spies.push(errorSpy);
    const result = await queryOpenRouter('http://127.0.0.1:9/v1/chat/completions');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(60);
    expect(result.costUsd).toBeCloseTo(0.035);
  });

  it('aborts a non-streamed OpenRouter reasoning retry at the per-attempt deadline', async () => {
    const url = 'http://127.0.0.1:9/v1/chat/completions';
    markEndpointRefusesStreamingForTests(url);
    let calls = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      calls += 1;
      if (calls === 1) {
        const body = JSON.parse(String((init as RequestInit).body)) as Body;
        return Promise.resolve(new Response(JSON.stringify(lengthBurn(body)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return hangUntilAbort(init);
    });
    spies.push(fetchSpy);
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    spies.push(errorSpy);
    const started = Date.now();
    const result = await queryOpenRouter(url, {}, undefined, 200);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(calls).toBe(2);
    expect(result.content).toBe('');
    expect(errorSpy.mock.calls.some(call => String(call[1]).includes('no observations'))).toBe(true);
  });

  it('aborts the Gemini thinking retry at the per-attempt deadline and skips it when the allowance is spent', async () => {
    const provider = new GeminiProvider({} as never, {} as never) as unknown as {
      query(h: unknown[], c: unknown, signal?: AbortSignal, perAttemptTimeoutMs?: number, paidSendBudget?: PaidSendBudget): Promise<QueryResult>;
    };
    const config = { apiKey: 'fixture-gemini', apiKeys: ['fixture-gemini'], model: 'gemini-2.5-flash', rateLimitingEnabled: false };
    let calls = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, thoughtsTokenCount: 20, totalTokenCount: 30 },
        }), { status: 200 }));
      }
      return hangUntilAbort(init);
    });
    spies.push(fetchSpy);
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    spies.push(errorSpy);
    const started = Date.now();
    const hung = await provider.query([{ role: 'user', content: 'Observe this tool call.' }], config, undefined, 200);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(calls).toBe(2);
    expect(hung.content).toBe('');
    expect(hung.outputTokens).toBe(20);

    const spent = new PaidSendBudget(7, 1);
    calls = 0;
    const skipped = await provider.query([{ role: 'user', content: 'Observe this tool call.' }], config, undefined, undefined, spent);
    expect(calls).toBe(1);
    expect(skipped.content).toBe('');
    expect(spent.spentPaidSends).toBe(1);
    expect(errorSpy.mock.calls.some(call => String(call[1]).includes('paid sends'))).toBe(true);
  });

  it('does not treat a mandatory or invalid-effort refusal as an unknown reasoning field', async () => {
    expect(isUnknownReasoningParameter("Unknown parameter: 'reasoning'. Extra fields are not permitted.")).toBe(true);
    expect(isUnknownReasoningParameter("Unsupported parameter: 'reasoning'")).toBe(true);
    expect(isUnknownReasoningParameter("Invalid parameter: reasoning.effort 'none' is unsupported for this model")).toBe(false);
    expect(isUnknownReasoningParameter('This model requires reasoning')).toBe(false);
    const server = await startReasoningServer('reject-mandatory-reasoning');
    try {
      await expect(queryCompat(server.url)).rejects.toThrow(/unsupported/);
      expect(server.bodies).toHaveLength(1);
      expect('reasoning' in (server.bodies[0] ?? {})).toBe(true);
      expect(endpointRejectsReasoningField(server.url)).toBe(false);
    } finally {
      await server.close();
    }
  });
});

describe('observer auth method', () => {
  const settings = () => SettingsDefaultsManager.getAllDefaults();

  it('names the active provider instead of always describing Claude', () => {
    const defaults = settings();
    expect(describeObserverAuthMethod('claude', defaults)).toBe(getAuthMethodDescription());
    expect(describeObserverAuthMethod('codex', defaults)).toBe('Codex CLI subscription');
    expect(describeObserverAuthMethod('gemini', defaults)).toBe('Gemini API key');
    expect(describeObserverAuthMethod('openrouter', defaults)).toBe('OpenRouter API key');
    expect(describeObserverAuthMethod('openrouter', {
      ...defaults,
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/inference/v1',
    })).toBe('cmem.ai gateway');
    const previous = process.env.OPENROUTER_BASE_URL;
    process.env.OPENROUTER_BASE_URL = 'https://cmem.ai/api/inference/v1';
    try {
      expect(defaults.CLAUDE_MEM_OPENROUTER_BASE_URL).toBe('');
      expect(describeObserverAuthMethod('openrouter', defaults)).toBe('cmem.ai gateway');
      expect(describeObserverAuthMethod('openrouter', {
        ...defaults,
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      })).toBe('OpenRouter API key');
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_BASE_URL;
      else process.env.OPENROUTER_BASE_URL = previous;
    }
    expect(describeObserverAuthMethod('openai-compatible', {
      ...defaults,
      CLAUDE_MEM_OPENAI_COMPAT_PRESET: 'nvidia-nim',
    })).toBe('NVIDIA NIM (build.nvidia.com) API key');
    expect(describeObserverAuthMethod('openai-compatible', defaults)).toBe('OpenAI-compatible API key');
  });
});

describe('CLAUDE_MEM_OPENAI_COMPAT_REASONING validation', () => {
  const validate = (value: string) => (new SettingsRoutes({} as never) as unknown as {
    validateSettings(settings: unknown): { valid: boolean; error?: string };
  }).validateSettings({ CLAUDE_MEM_OPENAI_COMPAT_REASONING: value });

  it('accepts off and on, including the aliases, and rejects anything else', () => {
    for (const value of ['', 'off', 'false', 'disabled', 'none', 'on', 'true', 'enabled']) {
      expect(validate(value).valid).toBe(true);
    }
    const rejected = validate('high');
    expect(rejected.valid).toBe(false);
    expect(rejected.error).toContain('must be "off" (default) or "on"');
  });
});
