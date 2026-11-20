import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { FIELD_OPTIMIZE_TIMEOUT_MS, optimizeField } from '../../src/services/worker/field-optimizer.js';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { markEndpointRefusesStreamingForTests, resetStreamingEndpointMemoryForTests } from '../../src/services/worker/streamed-chat-completion.js';

test('field deadline cancels real OpenRouter fetch and prevents retries', async () => {
  let requests = 0;
  let disconnected = false;
  // A raw TCP server, not node:http: Bun's node:http server emits no request or
  // socket 'close' when a client aborts before response headers (Bun 1.3.9), so
  // it cannot observe the disconnect this test is about. The TCP socket closing
  // is the runtime-agnostic signal that the client cancelled.
  const server = createNetServer(socket => {
    let received = '';
    socket.on('data', chunk => {
      received += chunk.toString('latin1');
      const requestLines = received.match(/^POST [^\r\n]* HTTP\/1\.1\r$/gm)?.length ?? 0;
      if (requestLines > 0) { requests += requestLines; received = received.replace(/^POST [^\r\n]* HTTP\/1\.1\r$/gm, ''); }
    });
    socket.on('error', () => {});
    socket.on('close', () => { disconnected = true; });
    // Deliberately never send a response: cancellation must reach the socket.
  });
  const openSockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => { openSockets.add(socket); socket.on('close', () => openSockets.delete(socket)); });
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
    for (const socket of openSockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 5000);

// #4134: CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS only helps if the OpenAI-compatible
// request path uses it too. A non-streamed request must use the field deadline
// when the backend takes longer than CLAUDE_MEM_LLM_TIMEOUT_MS to answer.
test('a field deadline longer than CLAUDE_MEM_LLM_TIMEOUT_MS governs a non-streamed OpenRouter request (#4134)', async () => {
  const server = createServer((req, res) => {
    req.resume();
    const reply = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'condensed by the model' } }] }));
    }, 700);
    res.on('close', () => clearTimeout(reply));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const originalLlmTimeout = process.env.CLAUDE_MEM_LLM_TIMEOUT_MS;
  process.env.CLAUDE_MEM_LLM_TIMEOUT_MS = '500';
  const provider = new OpenRouterProvider({} as any, {} as any);
  const config = {
    apiKey: 'fixture-not-a-secret', model: 'fixture',
    apiUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`,
  };
  markEndpointRefusesStreamingForTests(config.apiUrl);
  const raw = JSON.stringify({ content: 'x'.repeat(20_000) });
  const context = { sessionDbId: 0, field: 'outcome' };
  try {
    // Wired the way OpenAICompatibleProvider wires it: the deadline is forwarded.
    const condensed = await optimizeField(raw, (text, budget, signal, deadlineMs) =>
      (provider as any).compressField(text, budget, config, signal, deadlineMs), context, undefined, 3000);
    expect(String(condensed)).toContain('condensed by the model');

    const withoutForwardedDeadline = await optimizeField(raw, (text, budget, signal) =>
      (provider as any).compressField(text, budget, config, signal), context, undefined, 3000);
    expect(withoutForwardedDeadline).toBe(raw);
  } finally {
    if (originalLlmTimeout === undefined) delete process.env.CLAUDE_MEM_LLM_TIMEOUT_MS;
    else process.env.CLAUDE_MEM_LLM_TIMEOUT_MS = originalLlmTimeout;
    resetStreamingEndpointMemoryForTests();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10_000);
