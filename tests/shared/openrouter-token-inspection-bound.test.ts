import { describe, expect, it } from 'bun:test';
import { MAX_ERROR_BODY_BYTES } from '../../src/shared/capped-error-body.js';
import { fetchWithOpenRouterTokenCompatibility } from '../../src/shared/openrouter-token-compatibility.js';

const compatibilityError = "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.";

describe('bounded OpenRouter compatibility inspection', () => {
  for (const status of [200, 400]) {
    it(`returns an oversized ${status} response without waiting for its end`, async () => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let sourceCancelled = false;
      const head = new Uint8Array(MAX_ERROR_BODY_BYTES).fill(120);
      const tail = new TextEncoder().encode(' original response tail');
      const original = new Response(new ReadableStream<Uint8Array>({
        start(value) { controller = value; value.enqueue(head); },
        cancel() { sourceCancelled = true; },
      }), { status, headers: { 'x-provider': 'fixture' } });
      let requests = 0;
      const pending = fetchWithOpenRouterTokenCompatibility(async () => {
        requests++;
        return original;
      }, 'https://example.test/chat/completions', { method: 'POST' }, {}, 42);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          pending,
          new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 250); }),
        ]);
        expect(response).toBe(original);
        expect(requests).toBe(1);
        expect(original.bodyUsed).toBe(false);
        expect(sourceCancelled).toBe(false);
        expect(response?.headers.get('x-provider')).toBe('fixture');
      } finally {
        clearTimeout(timeout);
        controller.enqueue(tail);
        controller.close();
        await pending;
      }
      expect(new Uint8Array(await original.arrayBuffer())).toEqual(new Uint8Array([...head, ...tail]));
    });
  }

  it('does not inspect a compatibility marker beyond the bounded head', async () => {
    const original = new Response('x'.repeat(MAX_ERROR_BODY_BYTES) + compatibilityError, { status: 400 });
    let requests = 0;
    const response = await fetchWithOpenRouterTokenCompatibility(async () => {
      requests++;
      return original;
    }, 'https://example.test/chat/completions', { method: 'POST' }, {}, 42);
    expect(response).toBe(original);
    expect(requests).toBe(1);
    expect(await response.text()).toEndWith(compatibilityError);
  });

  it('keeps the existing single retry for a small structured compatibility error', async () => {
    const requests: Record<string, unknown>[] = [];
    const response = await fetchWithOpenRouterTokenCompatibility(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1
        ? new Response(JSON.stringify({ error: { message: compatibilityError } }), { status: 400 })
        : new Response('accepted');
    }, 'https://example.test/chat/completions', { method: 'POST' }, { model: 'fixture' }, 42);
    expect(requests).toEqual([
      { model: 'fixture', max_tokens: 42 },
      { model: 'fixture', max_completion_tokens: 42 },
    ]);
    expect(await response.text()).toBe('accepted');
  });

  it('releases the discarded original body when the bounded head warrants a retry', async () => {
    let sourceCancelled = false;
    const first = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(compatibilityError + 'x'.repeat(MAX_ERROR_BODY_BYTES)));
      },
      cancel() { sourceCancelled = true; },
    }), { status: 400 });
    let requests = 0;
    const response = await fetchWithOpenRouterTokenCompatibility(async () => {
      requests++;
      return requests === 1 ? first : new Response('accepted');
    }, 'https://example.test/chat/completions', { method: 'POST' }, {}, 42);
    expect(requests).toBe(2);
    expect(sourceCancelled).toBe(true);
    expect(await response.text()).toBe('accepted');
  });
});
