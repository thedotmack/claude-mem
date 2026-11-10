import { afterEach, beforeEach, expect, it } from 'bun:test';
import extension, { type PiExtensionAPI } from '../../src/integrations/pi-extension/index.js';
import { stripMemoryTags } from '../../src/utils/tag-stripping.js';

let originalFetch: typeof fetch;
let handlers: Map<string, (...args: any[]) => any>;
let observations: any[];
const user = { role: 'user', content: 'Inspect this tool result', timestamp: 100 };
const context = { cwd: '/work/project', sessionManager: {
  getSessionId: () => 'pi-private-output',
  getBranch: () => [{ type: 'message', id: 'persisted-user', message: user }],
} };

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  handlers = new Map(); observations = [];
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
  extension({ on: (name, handler) => handlers.set(name, handler), registerTool: () => {} } as PiExtensionAPI);
  await handlers.get('session_start')!({}, context);
  await handlers.get('before_agent_start')!({}, context);
  await handlers.get('context_with_system')!({ messages: [{ role: 'system', content: 'System' }, user] }, context);
});
afterEach(() => { globalThis.fetch = originalFetch; });

for (const isError of [false, true]) {
  it(`strips a complete private block before the response limit (isError=${isError})`, async () => {
    const prefix = 'public '.repeat(14_000);
    const content = prefix + '<private>' + 'PRIVATE-CONTENT '.repeat(2_000) + '</private> public suffix';
    await handlers.get('tool_result')!({ toolName: 'custom', content, isError }, context);
    const response = observations[0].tool_response;
    const text = isError ? response.error : response;
    expect(text.includes('PRIVATE-CONTENT')).toBe(false);
    expect(text.endsWith('public suffix')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(100_000);
    // The worker strips tags on the serialized response. A closing tag lost
    // to truncation cannot be recovered by this later privacy boundary.
    expect(stripMemoryTags(JSON.stringify(response)).includes('PRIVATE-CONTENT')).toBe(false);
    if (isError) expect(response.is_error).toBe(true);
  });
}

it('keeps the public-output cap after privacy filtering', async () => {
  await handlers.get('tool_result')!({ toolName: 'custom', content: 'x'.repeat(100_001) }, context);
  expect(observations[0].tool_response).toBe('x'.repeat(100_000));
});
