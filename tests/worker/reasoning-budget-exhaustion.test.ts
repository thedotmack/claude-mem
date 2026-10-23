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
import { resetReasoningFieldRejectionsForTesting } from '../../src/services/worker/reasoning-budget.js';
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
async function startReasoningServer(mode: 'honor-disable' | 'always-burn' | 'reject-reasoning-field') {
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
      } else if (mode !== 'reject-reasoning-field' && (mode === 'always-burn' || !reasoningDisabled(body))) {
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

function queryCompat(url: string) {
  return (new OpenAICompatProvider({} as never, {} as never) as unknown as {
    query(h: unknown[], c: unknown): Promise<{ content: string; finishReason?: string }>;
  }).query([{ role: 'user', content: 'Observe this tool call and write one observation.' }], compatConfig(url));
}

function queryOpenRouter(url: string, extra: Record<string, unknown> = {}) {
  return (new OpenRouterProvider({} as never, {} as never) as unknown as {
    query(h: unknown[], c: unknown): Promise<{ content: string; finishReason?: string }>;
  }).query([{ role: 'user', content: 'Observe this tool call and write one observation.' }], {
    apiKey: 'sk-or-v1-fixture',
    model: 'deepseek/deepseek-v4-flash',
    fallbackModels: [],
    apiUrl: url,
    ...extra,
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
        query(h: unknown[], c: unknown): Promise<{ content: string }>;
      };
      const result = await provider.query(
        [{ role: 'user', content: 'Observe this tool call.' }],
        { apiKey: 'fixture-gemini', apiKeys: ['fixture-gemini'], model: 'gemini-2.5-flash', rateLimitingEnabled: false },
      );
      expect(result.content).toContain('Kept the answer');
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
