import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import {
  fetchWithOpenRouterTokenCompatibility,
  isMaxCompletionTokensCompatibilityError,
} from '../../src/shared/openrouter-token-compatibility.js';

const issueReport = readFileSync(new URL('../fixtures/claude-mem-issue-3712.md', import.meta.url), 'utf8');
const compatibilityError = issueReport.match(/Unsupported parameter:[\s\S]*?instead\./)?.[0] ?? '';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('OpenRouter token compatibility', () => {
  it('matches only the exact 400 replacement error', () => {
    expect(isMaxCompletionTokensCompatibilityError(400, compatibilityError)).toBe(true);
    expect(isMaxCompletionTokensCompatibilityError(400, "Unsupported parameter: 'max_tokens'\nUse 'max_completion_tokens' instead.")).toBe(true);
    expect(isMaxCompletionTokensCompatibilityError(400, JSON.stringify({ error: { code: 'unsupported_parameter', param: 'max_tokens', message: "Use 'max_completion_tokens' instead." } }))).toBe(true);
    expect(isMaxCompletionTokensCompatibilityError(500, compatibilityError)).toBe(false);
    expect(isMaxCompletionTokensCompatibilityError(400, "Unsupported parameter: 'max_tokens' is not supported with this model.")).toBe(false);
    expect(isMaxCompletionTokensCompatibilityError(400, "Unsupported parameter: 'max_tokens' is not supported with this model.")).toBe(false);
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
      { model: 'gpt-5', messages: [{ role: 'user', content: 'hello' }], temperature: 0.3 },
      42,
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
      {},
      42,
    );

    expect(response.status).toBe(400);
    expect(calls).toBe(1);
  });

  it('retries a structured compatibility error returned inside a 200 response', async () => {
    const requests: RequestInit[] = [];
    const responses = [
      jsonResponse(200, { error: { code: 'unsupported_parameter', param: 'max_tokens', message: "Use 'max_completion_tokens' instead." } }),
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
    ];
    const response = await fetchWithOpenRouterTokenCompatibility(
      async (_input, init) => {
        requests.push(init ?? {});
        return responses.shift()!;
      },
      'https://example.test/chat/completions',
      { method: 'POST' },
      { model: 'gpt-5' },
      42,
    );

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(String(requests[1].body))).toEqual({ model: 'gpt-5', max_completion_tokens: 42 });
  });

  it('does not retry a 400 body that only mentions max_tokens', async () => {
    let calls = 0;
    const response = await fetchWithOpenRouterTokenCompatibility(
      async () => {
        calls += 1;
        return jsonResponse(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported" } });
      },
      'https://example.test/chat/completions',
      { method: 'POST' },
      {},
      42,
    );

    expect(response.status).toBe(400);
    expect(calls).toBe(1);
  });

  it('returns native Response body semantics after inspecting a non-retry response', async () => {
    const response = await fetchWithOpenRouterTokenCompatibility(
      async () => new Response(
        JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported" } }),
        { status: 400, statusText: 'Gateway Rejected', headers: { 'Content-Type': 'application/json' } },
      ),
      'https://example.test/chat/completions',
      { method: 'POST' },
      {},
      42,
    );

    expect(response.status).toBe(400);
    expect(response.statusText).toBe('Gateway Rejected');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.bodyUsed).toBe(false);

    const clone = response.clone();
    expect(await clone.text()).toContain('max_tokens');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(response.bodyUsed).toBe(true);
    await expect(response.text()).rejects.toThrow(/body|used/i);
  });

  it('preserves native Response body semantics for ordinary inspected 2xx responses', async () => {
    const response = await fetchWithOpenRouterTokenCompatibility(
      async () => new Response('ok', { status: 200, statusText: 'Success', headers: { 'x-test': 'preserved' } }),
      'https://example.test/chat/completions',
      { method: 'POST' },
      {},
      42,
    );

    expect(response.status).toBe(200);
    expect(response.statusText).toBe('Success');
    expect(response.headers.get('x-test')).toBe('preserved');
    expect(response.bodyUsed).toBe(false);
    expect(await response.clone().text()).toBe('ok');
  });
});
