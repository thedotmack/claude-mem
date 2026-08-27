import { describe, expect, it } from 'bun:test';
import {
  fetchWithOpenRouterTokenCompatibility,
  isMaxCompletionTokensCompatibilityError,
} from '../../src/shared/openrouter-token-compatibility.js';

const compatibilityError = "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('OpenRouter token compatibility', () => {
  it('matches only the exact 400 replacement error', () => {
    expect(isMaxCompletionTokensCompatibilityError(400, compatibilityError)).toBe(true);
    expect(isMaxCompletionTokensCompatibilityError(500, compatibilityError)).toBe(false);
    expect(isMaxCompletionTokensCompatibilityError(400, "Unsupported parameter: 'max_tokens' is not supported with this model.")).toBe(false);
    expect(isMaxCompletionTokensCompatibilityError(400, compatibilityError.replace(' instead.', '.'))).toBe(false);
  });

  it('changes only the token field on the one-shot fallback', async () => {
    const requests: RequestInit[] = [];
    const responses = [
      jsonResponse(400, { error: { message: compatibilityError } }),
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    ];
    const fetchImpl: typeof fetch = async (_input, init) => {
      requests.push(init ?? {});
      return responses.shift()!;
    };

    const response = await fetchWithOpenRouterTokenCompatibility(
      fetchImpl,
      'https://example.test/chat/completions',
      { method: 'POST', headers: { Authorization: 'Bearer fake' } },
      { model: 'gpt-5', messages: [{ role: 'user', content: 'hello' }], temperature: 0.3, max_tokens: 42 },
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    const first = JSON.parse(String(requests[0].body)) as Record<string, unknown>;
    const second = JSON.parse(String(requests[1].body)) as Record<string, unknown>;
    expect(first.max_tokens).toBe(42);
    expect(second).toEqual({ model: 'gpt-5', messages: [{ role: 'user', content: 'hello' }], temperature: 0.3, max_completion_tokens: 42 });
    expect(requests[1].headers).toEqual(requests[0].headers);
  });

  it('does not retry an incomplete compatibility error', async () => {
    let calls = 0;
    const response = await fetchWithOpenRouterTokenCompatibility(
      async () => {
        calls += 1;
        return jsonResponse(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported" } });
      },
      'https://example.test/chat/completions',
      { method: 'POST' },
      { max_tokens: 42 },
    );

    expect(response.status).toBe(400);
    expect(calls).toBe(1);
  });
});
