import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { DEFAULT_OPENROUTER_MODEL } from '../../src/shared/SettingsDefaultsManager.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

// Expose the protected query() so the fallback path can be driven without the
// full session machinery.
class TestOpenRouterProvider extends OpenRouterProvider {
  run(history: ConversationMessage[], config: { apiKey: string; model: string; apiUrl: string }) {
    return (this as any).query(history, config);
  }
}

function okResponse(model: string): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function deprecatedResponse(): Response {
  return new Response(
    JSON.stringify({ error: { message: 'This model has been deprecated', code: 404 } }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  );
}

function modelFromRequest(init: RequestInit | undefined): string {
  return JSON.parse(String(init?.body)).model;
}

describe('OpenRouter deprecated-model fallback', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  const provider = new TestOpenRouterProvider({} as any, {} as any);
  const history: ConversationMessage[] = [{ role: 'user', content: 'hi' }];

  it('falls back to the default model when the configured model is deprecated', async () => {
    const models: string[] = [];
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const model = modelFromRequest(init as RequestInit);
      models.push(model);
      return model === DEFAULT_OPENROUTER_MODEL ? okResponse(model) : deprecatedResponse();
    });

    const result = await provider.run(history, {
      apiKey: 'k',
      model: 'xiaomi/mimo-v2-flash:free',
      apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    });

    expect(result.content).toBe('ok');
    expect(models).toEqual(['xiaomi/mimo-v2-flash:free', DEFAULT_OPENROUTER_MODEL]);
  });

  it('does not fall back when the deprecated model is already the default', async () => {
    let calls = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++;
      return deprecatedResponse();
    });

    await expect(
      provider.run(history, {
        apiKey: 'k',
        model: DEFAULT_OPENROUTER_MODEL,
        apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
      }),
    ).rejects.toThrow();

    expect(calls).toBe(1);
  });

  it('does not fall back on a custom (non-openrouter.ai) gateway', async () => {
    let calls = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++;
      return deprecatedResponse();
    });

    await expect(
      provider.run(history, {
        apiKey: 'k',
        model: 'some/deprecated-model',
        apiUrl: 'https://api.deepseek.com/chat/completions',
      }),
    ).rejects.toThrow();

    expect(calls).toBe(1);
  });
});
