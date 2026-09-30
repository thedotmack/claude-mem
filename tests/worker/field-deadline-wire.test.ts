import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import { optimizeField } from '../../src/services/worker/field-optimizer.js';
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
  let budgetTimers = 0;
  // query() arms its attempt timeout before optimizeField arms the field deadline.
  // Keep the attempt alive longer so this test exercises field cancellation, not a timer tie.
  globalThis.setTimeout = ((fn: any, ms: number, ...args: any[]) =>
    nativeTimeout(fn, ms === 30_000 ? (++budgetTimers === 1 ? 1000 : 100) : ms, ...args)) as typeof setTimeout;
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
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 5000);

// #4134: CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS only helps if the OpenAI-compatible
// request path uses it too. Scaled down: a 3s field deadline must outlast a 600ms
// CLAUDE_MEM_LLM_TIMEOUT_MS when the backend answers in 1.2s.
test('a field deadline longer than CLAUDE_MEM_LLM_TIMEOUT_MS governs the OpenRouter request (#4134)', async () => {
  const server = createServer((req, res) => {
    req.resume();
    const reply = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'condensed by the model' } }] }));
    }, 1200);
    res.on('close', () => clearTimeout(reply));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const originalLlmTimeout = process.env.CLAUDE_MEM_LLM_TIMEOUT_MS;
  process.env.CLAUDE_MEM_LLM_TIMEOUT_MS = '600';
  const provider = new OpenRouterProvider({} as any, {} as any);
  const config = {
    apiKey: 'fixture-not-a-secret', model: 'fixture',
    apiUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`,
  };
  const raw = JSON.stringify({ content: 'x'.repeat(20_000) });
  const context = { sessionDbId: 0, field: 'outcome' };
  try {
    // Wired the way OpenAICompatibleProvider wires it: the deadline is forwarded.
    const condensed = await optimizeField(raw, (text, budget, signal, deadlineMs) =>
      (provider as any).compressField(text, budget, config, signal, deadlineMs), context, undefined, 3000);
    expect(String(condensed)).toContain('condensed by the model');

    // The old wiring dropped it: the 600ms LLM default cuts the pass off first,
    // so the field falls back to truncation despite the 3s knob.
    const truncated = await optimizeField(raw, (text, budget, signal) =>
      (provider as any).compressField(text, budget, config, signal), context, undefined, 3000);
    expect(truncated).toBe(raw);
  } finally {
    if (originalLlmTimeout === undefined) delete process.env.CLAUDE_MEM_LLM_TIMEOUT_MS;
    else process.env.CLAUDE_MEM_LLM_TIMEOUT_MS = originalLlmTimeout;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10_000);
