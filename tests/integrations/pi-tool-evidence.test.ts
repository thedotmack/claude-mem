import { test } from 'node:test';
import assert from 'node:assert/strict';
import extension, { type PiExtensionAPI } from '../../src/integrations/pi-extension/index.js';

async function capture(events: Array<Record<string, unknown>>) {
  const realFetch = globalThis.fetch;
  const handlers = new Map<string, (...args: any[]) => any>();
  const observations: any[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (route === '/api/sessions/native-prompt-capability') return Response.json({ nativePromptId: 1 });
    if (route === '/api/sessions/init') return Response.json({
      sessionDbId: 42, nativePromptId: body.nativePromptId, nativePromptCurrent: true,
    });
    if (route === '/api/sessions/observations') observations.push(body);
    return new Response('');
  }) as typeof fetch;
  const user = { role: 'user', content: 'Update the file', timestamp: 100 };
  const context = { cwd: '/work/project', sessionManager: {
    getSessionId: () => 'pi-evidence-session',
    getBranch: () => [{ type: 'message', id: 'persisted-user', message: user }],
  } };
  try {
    extension({ on: (name, handler) => handlers.set(name, handler), registerTool: () => {} } as PiExtensionAPI);
    await handlers.get('session_start')!({}, context);
    await handlers.get('before_agent_start')!({}, context);
    await handlers.get('context_with_system')!({ messages: [{ role: 'system', content: 'System' }, user] }, context);
    for (const event of events) await handlers.get('tool_result')!(event, context);
    return observations;
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('Pi built-in reads and writes use the worker file-evidence vocabulary', async () => {
  const input = { path: 'src/example.ts', offset: 10 };
  const observations = await capture([
    { toolName: 'read', input, content: 'contents' },
    { toolName: 'write', input: { path: 'new.ts', content: 'new' }, content: 'written' },
    { toolName: 'edit', input: { path: 'old.ts', oldText: 'a', newText: 'b' }, content: 'edited' },
    { toolName: 'bash', input: { command: 'git status' }, content: 'clean' },
  ]);
  assert.deepEqual(observations.map(item => item.tool_name), ['Read', 'Write', 'Edit', 'Bash']);
  assert.deepEqual(observations[0].tool_input, { path: 'src/example.ts', file_path: 'src/example.ts', offset: 10 });
  assert.equal(observations[1].tool_input.file_path, 'new.ts');
  assert.equal(observations[2].tool_input.file_path, 'old.ts');
  assert.equal(observations[3].tool_input.command, 'git status');
  assert.deepEqual(input, { path: 'src/example.ts', offset: 10 });
});

test('Pi failures retain an explicit failure marker and the captured error text', async () => {
  const observations = await capture([
    { toolName: 'write', input: { path: 'denied.ts' }, content: [{ type: 'text', text: 'Permission denied' }], isError: true },
    { toolName: 'write', input: { path: 'saved.ts' }, content: 'Saved', isError: false },
  ]);
  assert.deepEqual(observations[0].tool_response, { is_error: true, error: 'Permission denied' });
  assert.equal(observations[1].tool_response, 'Saved');
});

test('custom tools pass through and memory tools remain excluded', async () => {
  const input = { path: 'custom', file_path: 'canonical' };
  const observations = await capture([
    { toolName: 'custom_read', input, content: 'custom output' },
    { toolName: 'mem_search', content: 'memory result' },
  ]);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].tool_name, 'custom_read');
  assert.deepEqual(observations[0].tool_input, input);
});
