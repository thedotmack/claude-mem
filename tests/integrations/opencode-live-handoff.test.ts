import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../../src/integrations/opencode-plugin/core.js';
import { REFUSED_RETRY_DELAYS_MS } from '../../src/integrations/opencode-plugin/worker-retry.js';

const refusal = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

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
    await new Promise(resolve => setTimeout(resolve, REFUSED_RETRY_DELAYS_MS[0] + 100));
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

test('non-inference prompt metadata can still retry during worker startup', async () => {
  const originalFetch = globalThis.fetch;
  const routes: string[] = [];
  let available = false;
  globalThis.fetch = (async url => {
    if (!available) throw refusal();
    routes.push(new URL(String(url)).pathname);
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    await createCore({ directory: '/work/metadata' }).captureUserPrompt('metadata', 'current prompt');
    available = true;
    await new Promise(resolve => setTimeout(resolve, REFUSED_RETRY_DELAYS_MS[0] + 100));
    assert.deepEqual(routes, ['/api/sessions/init']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
