import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore, type ClaudeMemCore } from '../../src/integrations/opencode-plugin/core.js';

const refusal = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

const ignoredResponses: Array<{ name: string; status: number; run: (core: ClaudeMemCore) => Promise<unknown> }> = [
  { name: 'accepted session init', status: 200, run: core => core.captureUserPrompt('accepted-body', 'prompt') },
  { name: 'rejected session init', status: 503, run: core => core.captureUserPrompt('rejected-body', 'prompt') },
  { name: 'rejected context', status: 503, run: core => core.memoryContext('rejected-context-body') },
  { name: 'rejected search', status: 503, run: core => core.search('query') },
  { name: 'rejected timeline', status: 503, run: core => core.timeline(1) },
  { name: 'rejected observation batch', status: 503, run: core => core.getObservations([1]) },
];

for (const { name, status, run } of ignoredResponses) {
  test(`${name} releases its unread response when the operation returns`, async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    let cancelled = false;
    let calls = 0;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('ignored worker response')); },
      cancel() { cancelled = true; },
    }), { status });
    globalThis.fetch = (async () => { calls++; return response; }) as typeof fetch;
    console.warn = () => {};
    try {
      await run(createCore({ directory: '/work/response-ownership' }));
      assert.equal(calls, 1, 'response cleanup must not resend a request');
      assert.equal(cancelled, true, 'the operation owns the body even when it does not read it');
    } finally {
      await response.body?.cancel();
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
  });
}

test('an outage never replays old OpenCode observations or summaries after recovery', async () => {
  const originalFetch = globalThis.fetch;
  const accepted: Array<{ route: string; body: any }> = [];
  let available = false;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!available) throw refusal();
    accepted.push({ route: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    const core = createCore({ directory: '/work/live-only' });
    await core.captureTool({ tool: 'read', sessionID: 'outage', args: { filePath: 'old.ts' }, output: 'old tool output' });
    await core.captureAssistantMessage('outage', 'old assistant message');
    await core.captureSummary('outage', { lastAssistantMessage: 'old summary input' });
    available = true;
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepEqual(accepted, [], 'recovery cannot turn old capture into new inference');

    await core.captureTool({ tool: 'read', sessionID: 'fresh', args: { filePath: 'new.ts' }, output: 'fresh output' });
    await core.captureSummary('fresh', { lastAssistantMessage: 'fresh summary' });
    assert.deepEqual(accepted.map(item => item.route), ['/api/sessions/observations', '/api/sessions/summarize']);
    assert.equal(accepted[0].body.tool_response, 'fresh output');
    assert.equal(accepted[1].body.last_assistant_message, 'fresh summary');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a live request uses the 250ms handoff budget and releases its response body', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let cancelled = false;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_url, init) => {
    signal = init?.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  }) as typeof fetch;
  console.warn = () => {};
  try {
    const core = createCore({ directory: '/work/bounded' });
    await core.captureTool({ tool: 'read', sessionID: 'bounded', output: 'result' });
    assert.equal(cancelled, true, 'capture does not retain an unread response stream');
    assert.ok(signal);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(signal.aborted, true, 'live transport deadline remains 250ms');
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('a refused POST is not re-sent after worker recovery', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const scheduled: Array<() => void> = [];
  const routes: string[] = [];
  let available = false;
  globalThis.setTimeout = ((callback: () => void) => {
    scheduled.push(callback);
    return 0;
  }) as unknown as typeof setTimeout;
  globalThis.fetch = (async url => {
    if (!available) throw refusal();
    routes.push(new URL(String(url)).pathname);
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    const core = createCore({ directory: '/work/metadata' });
    await core.captureUserPrompt('metadata', 'outage prompt');
    available = true;
    for (const callback of scheduled.splice(0)) callback();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(routes, [], 'recovery must not resend the refused POST');

    await core.captureUserPrompt('metadata', 'fresh prompt');
    assert.deepEqual(routes, ['/api/sessions/init']);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});
