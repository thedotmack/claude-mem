import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { askApiTarget, resolveApiTarget, type ApiTarget } from '../../../src/services/agent-runner/api-agent.js';
import { resetReasoningFieldRejectionsForTesting } from '../../../src/services/worker/reasoning-budget.js';
import { logger } from '../../../src/utils/logger.js';

interface FetchCall { url: string; headers: Record<string, string>; body: Record<string, unknown>; timeout: unknown }

/** Replace global fetch with a recorder that answers with the given replies in order. */
function fakeFetch(replies: Array<{ status?: number; body?: unknown; text?: string }>): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    calls.push({ url: String(input), headers: init.headers ?? {}, body: JSON.parse(String(init.body ?? '{}')), timeout: init.timeout });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    const status = reply.status ?? 200;
    const text = reply.text ?? JSON.stringify(reply.body ?? { choices: [{ message: { content: 'answer' } }] });
    return new Response(status === 200 ? text : text, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls };
}

const target = (url = 'https://openrouter.ai/api/v1/chat/completions'): ApiTarget =>
  ({ provider: 'openrouter', url, apiKey: 'sk-or-test', model: 'vendor/model' });

describe('the API agent talks to the selected provider', () => {
  let savedFetch: typeof fetch;

  beforeEach(() => { savedFetch = globalThis.fetch; resetReasoningFieldRejectionsForTesting(); });
  afterEach(() => { globalThis.fetch = savedFetch; resetReasoningFieldRejectionsForTesting(); });

  it('sends the question to the provider with its own key and no answer format', async () => {
    const { calls } = fakeFetch([{ body: { choices: [{ message: { content: 'the answer' } }] } }]);
    expect(await askApiTarget(target(), 'the question')).toBe('the answer');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((calls[0].headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
    expect(calls[0].body.model).toBe('vendor/model');
    expect(calls[0].body.messages).toEqual([
      expect.objectContaining({ role: 'system' }),
      { role: 'user', content: 'the question' },
    ]);
    // A step without a schema asks for prose: a JSON format would break its parsing.
    expect(calls[0].body.response_format).toBeUndefined();
  });

  it('asks for the step\'s answer shape when the step names one', async () => {
    const { calls } = fakeFetch([{ body: { choices: [{ message: { content: '{}' } }] } }]);
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    await askApiTarget(target(), 'the question', { answerSchema: schema });
    expect(calls[0].body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', schema, strict: false } });
  });

  it('refuses an answer the provider cut off at the token limit instead of returning it', async () => {
    // A truncated JSON answer must fail loudly, never reach the step's validators half-written.
    const { calls } = fakeFetch([{ body: { choices: [{ finish_reason: 'length', message: { content: '{"narrative": "The record holds' } }] } }]);
    await expect(askApiTarget(target(), 'the question')).rejects.toThrow(/finish reason: length/);
    expect(calls.length).toBe(1);
    expect(calls[0].body.max_tokens).toBe(16_000);
  });

  it('turns off Bun\'s fetch idle timeout, so a long silent answer runs to the request deadline', async () => {
    // A non-streamed answer sends no byte until it is done; Bun's 5-minute idle timeout fired first (#6222).
    const { calls } = fakeFetch([{ body: { choices: [{ message: { content: 'a' } }] } }]);
    await askApiTarget(target(), 'the question');
    expect(calls[0].timeout).toBe(false);
  });

  it('uses the step\'s model over the provider\'s own', async () => {
    const { calls } = fakeFetch([{ body: { choices: [{ message: { content: 'a' } }] } }]);
    await askApiTarget(target(), 'the question', { model: 'vendor/other' });
    expect(calls[0].body.model).toBe('vendor/other');
  });

  it('resends without the reasoning field when the endpoint does not know it', async () => {
    const { calls } = fakeFetch([
      { status: 422, text: JSON.stringify({ error: { message: "Unknown parameter: 'reasoning'" } }) },
      { body: { choices: [{ message: { content: 'the answer' } }] } },
    ]);
    expect(await askApiTarget(target('https://example.test/v1/chat/completions'), 'the question')).toBe('the answer');
    expect(calls.length).toBe(2);
    expect((calls[0].body as Record<string, unknown>).reasoning).toEqual({ enabled: false });
    expect(calls[1].body.reasoning).toBeUndefined();
  });

  it('asks again as a plain JSON object when the endpoint refuses the schema', async () => {
    const { calls } = fakeFetch([
      { status: 400, text: JSON.stringify({ error: { message: 'response_format is not supported' } }) },
      { body: { choices: [{ message: { content: '{}' } }] } },
    ]);
    await askApiTarget(target('https://example.test/v2/chat/completions'), 'the question', { answerSchema: { type: 'object' } });
    expect(calls.length).toBe(2);
    expect(calls[0].body.response_format).toEqual({ type: 'json_schema', json_schema: expect.objectContaining({ name: 'answer' }) });
    expect(calls[1].body.response_format).toEqual({ type: 'json_object' });
  });

  it('resends without the reasoning field when the endpoint says reasoning cannot be disabled', async () => {
    const { calls } = fakeFetch([
      { status: 400, text: JSON.stringify({ error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.' } }) },
      { body: { choices: [{ message: { content: 'the answer' } }] } },
    ]);
    const router = target('https://openrouter.test/api/v1/chat/completions');
    expect(await askApiTarget(router, 'the question')).toBe('the answer');
    expect(calls.length).toBe(2);
    expect(calls[0].body.reasoning).toEqual({ enabled: false });
    expect(calls[1].body.reasoning).toBeUndefined();
    // Not remembered against the URL: the next question tries the field again.
    const again = fakeFetch([{ body: { choices: [{ message: { content: 'ok' } }] } }]);
    await askApiTarget(router, 'next');
    expect(again.calls[0].body.reasoning).toEqual({ enabled: false });
  });

  it('resends with max_completion_tokens when the endpoint refuses max_tokens', async () => {
    const { calls } = fakeFetch([
      { status: 400, text: JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", param: 'max_tokens', code: 'unsupported_parameter' } }) },
      { body: { choices: [{ message: { content: 'the answer' } }] } },
    ]);
    expect(await askApiTarget(target('https://example.test/v6/chat/completions'), 'the question')).toBe('the answer');
    expect(calls.length).toBe(2);
    expect(calls[0].body.max_tokens).toBe(16_000);
    expect(calls[0].body.max_completion_tokens).toBeUndefined();
    expect(calls[1].body.max_tokens).toBeUndefined();
    expect(calls[1].body.max_completion_tokens).toBe(16_000);
  });

  it('resends with max_completion_tokens only once', async () => {
    const { calls } = fakeFetch([
      { status: 400, text: JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }) },
    ]);
    await expect(askApiTarget(target('https://example.test/v7/chat/completions'), 'the question')).rejects.toThrow(/HTTP 400/);
    expect(calls.length).toBe(2);
  });

  it('does not resend a schema-backed question when the 400 is about something else', async () => {
    const { calls } = fakeFetch([{ status: 400, text: JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens, however you requested 9000 tokens" } }) }]);
    await expect(askApiTarget(target('https://example.test/v5/chat/completions'), 'the question', { answerSchema: { type: 'object' } }))
      .rejects.toThrow(/maximum context length/);
    // A context refusal fails the same way in any answer format: one request, the original error.
    expect(calls.length).toBe(1);
  });

  it('reports the provider\'s own refusal and never asks anyone else', async () => {
    const { calls } = fakeFetch([{ status: 401, text: JSON.stringify({ error: { message: 'invalid api key' } }) }]);
    await expect(askApiTarget(target('https://example.test/v3/chat/completions'), 'the question')).rejects.toThrow(/not authenticated/i);
    // One request, no retry, no other provider: a refusal is not a reason to spend another account.
    expect(calls.length).toBe(1);
  });

  it('reports an exhausted quota as the provider\'s own limit', async () => {
    fakeFetch([{ status: 429, text: JSON.stringify({ error: { message: 'rate limited' } }) }]);
    await expect(askApiTarget(target('https://example.test/v4/chat/completions'), 'the question')).rejects.toThrow(/quota/i);
  });

  it('merges the extra body into the request, but never over the fields the agent sets itself', async () => {
    // vLLM ignores `reasoning`; a Qwen chat template reads chat_template_kwargs.enable_thinking (#6223).
    const { calls } = fakeFetch([{ body: { choices: [{ message: { content: '{}' } }] } }]);
    const extraBody = {
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0.7,
      reasoning: { effort: 'high' },
      response_format: { type: 'text' },
      model: 'other', messages: [], max_tokens: 1, stream: true,
    };
    await askApiTarget({ ...target('https://llm.test/v1/chat/completions'), extraBody }, 'the question', { answerSchema: { type: 'object' } });
    const body = calls[0].body;
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.temperature).toBe(0.7);
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.response_format).toEqual(expect.objectContaining({ type: 'json_schema' }));
    expect(body.model).toBe('vendor/model');
    expect(body.messages).toHaveLength(2);
    expect(body.max_tokens).toBe(16_000);
    expect(body.stream).toBe(false);
  });
});

describe('the API target follows the selected provider', () => {
  const withSettings = async <T>(file: Record<string, string>, body: (path: string) => T | Promise<T>): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'api-agent-'));
    const saved = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) if (key.startsWith('CLAUDE_MEM_')) delete process.env[key];
      const path = join(dir, 'settings.json');
      writeFileSync(path, JSON.stringify(file));
      return await body(path);
    } finally {
      for (const key of Object.keys(process.env)) if (key.startsWith('CLAUDE_MEM_')) delete process.env[key];
      Object.assign(process.env, saved);
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('resolves OpenRouter\'s endpoint, key and model', async () => {
    await withSettings({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-test', CLAUDE_MEM_OPENROUTER_MODEL: 'vendor/model' }, path => {
      const resolution = resolveApiTarget(path);
      expect(resolution.target).toEqual({ provider: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'sk-or-test', model: 'vendor/model' });
    });
  });

  it('resolves an OpenAI-compatible endpoint', async () => {
    await withSettings({ CLAUDE_MEM_PROVIDER: 'openai-compatible', CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'https://llm.test/v1', CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'sk-test', CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'local/model' }, path => {
      const resolution = resolveApiTarget(path);
      expect(resolution.target).toEqual({ provider: 'openai-compatible', url: 'https://llm.test/v1/chat/completions', apiKey: 'sk-test', model: 'local/model' });
    });
  });

  it('has no target on a provider that is not an API endpoint', async () => {
    await withSettings({ CLAUDE_MEM_PROVIDER: 'claude' }, path => {
      const resolution = resolveApiTarget(path);
      expect(resolution.target).toBeNull();
      expect(resolution.reason).toContain('claude');
    });
  });

  it('has no target when the chosen provider has no key', async () => {
    await withSettings({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_MODEL: 'vendor/model' }, path => {
      const resolution = resolveApiTarget(path);
      expect(resolution.target).toBeNull();
      expect(resolution.reason).toMatch(/no API key/i);
    });
  });

  it('reads CLAUDE_MEM_API_AGENT_EXTRA_BODY, without the fields it cannot set', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await withSettings({
        CLAUDE_MEM_PROVIDER: 'openai-compatible', CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'https://llm.test/v1', CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'sk-test', CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'local/model',
        CLAUDE_MEM_API_AGENT_EXTRA_BODY: '{"chat_template_kwargs":{"enable_thinking":false},"max_tokens":1}',
      }, path => {
        expect(resolveApiTarget(path).target?.extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
      });
      expect(warn.mock.calls.some(call => String(call[1]).includes('CLAUDE_MEM_API_AGENT_EXTRA_BODY cannot set max_tokens'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores a CLAUDE_MEM_API_AGENT_EXTRA_BODY that is not valid JSON, with a warning', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await withSettings({
        CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-test', CLAUDE_MEM_OPENROUTER_MODEL: 'vendor/model',
        CLAUDE_MEM_API_AGENT_EXTRA_BODY: '{not json',
      }, path => {
        const resolution = resolveApiTarget(path);
        expect(resolution.target?.model).toBe('vendor/model');
        expect(resolution.target?.extraBody).toBeUndefined();
      });
      expect(warn.mock.calls.some(call => String(call[1]).includes('CLAUDE_MEM_API_AGENT_EXTRA_BODY is not valid JSON'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
