import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import { FIELD_OPTIMIZE_TIMEOUT_MS, optimizeField } from '../../src/services/worker/field-optimizer.js';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';

test('field deadline cancels real OpenRouter fetch and prevents retries', async () => {
  let requests = 0;
  let disconnected = false;
  const server = createServer((req, res) => {
    requests++;
    // Do not resume() the body: on older Bun versions that keeps the keep-alive
    // socket open and `res.on('close')` does not fire within the observation
    // window. The request's own abort/error and socket-close events are the
    // event-driven, runtime-agnostic signal that the client disconnected.
    req.on('error', () => { disconnected = true; });
    req.on('close', () => { if ((req as any).aborted || (req as any).destroyed) disconnected = true; });
    req.socket.on('close', () => { disconnected = true; });
    // Deliberately never send headers: cancellation must reach the socket.
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const nativeTimeout = globalThis.setTimeout;
  const priorLlmTimeout = process.env.CLAUDE_MEM_LLM_TIMEOUT_MS;
  // Keep the per-attempt deadline alive well past the field deadline so this test
  // exercises field cancellation, not the attempt deadline or a timer tie. Pinned
  // here rather than inferred from the default, which no longer equals the
  // field budget.
  process.env.CLAUDE_MEM_LLM_TIMEOUT_MS = '1000';
  globalThis.setTimeout = ((fn: any, ms: number, ...args: any[]) =>
    nativeTimeout(fn, ms === FIELD_OPTIMIZE_TIMEOUT_MS ? 100 : ms, ...args)) as typeof setTimeout;
  const provider = new OpenRouterProvider({} as any, {} as any);
  const raw = JSON.stringify({ oldString: 'a', newString: 'b', content: 'x'.repeat(20_000) });
  let signal: AbortSignal | undefined;
  try {
    const result = await optimizeField(raw, (text, budget, abortSignal) => {
      signal = abortSignal;
      return (provider as any).compressField(text, budget, {
        apiKey: 'fixture-not-a-secret', model: 'fixture',
        apiUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      }, abortSignal);
    }, { sessionDbId: 0, field: 'outcome', toolName: 'Edit' });
    await new Promise(resolve => nativeTimeout(resolve, 450));
    expect(result).toBe(raw);
    expect(signal?.aborted).toBe(true);
    expect(requests).toBe(1);
    expect(disconnected).toBe(true);
  } finally {
    globalThis.setTimeout = nativeTimeout;
    if (priorLlmTimeout === undefined) delete process.env.CLAUDE_MEM_LLM_TIMEOUT_MS;
    else process.env.CLAUDE_MEM_LLM_TIMEOUT_MS = priorLlmTimeout;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 5000);
