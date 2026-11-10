import { afterEach, beforeEach, expect, it } from 'bun:test';
import extension, { type PiExtensionAPI } from '../../src/integrations/pi-extension/index.js';

let originalFetch: typeof fetch;
let handlers: Map<string, (...args: any[]) => any>;
let posted: Array<{ route: string; body: any }>;
let holdObservation: (() => Promise<Response>) | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  handlers = new Map(); posted = []; holdObservation = undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (route === '/api/sessions/native-prompt-capability') return Response.json({ nativePromptId: 1 });
    if (route === '/api/sessions/init') return Response.json({
      sessionDbId: 42, nativePromptId: body.nativePromptId, nativePromptCurrent: true,
    });
    if (init?.method === 'POST') posted.push({ route, body });
    if (route === '/api/sessions/observations' && holdObservation) return holdObservation();
    return new Response('');
  }) as typeof fetch;
  extension({ on: (name, handler) => handlers.set(name, handler), registerTool: () => {} } as PiExtensionAPI);
});
afterEach(() => { globalThis.fetch = originalFetch; });

async function begin(id: string) {
  const user = { role: 'user', content: 'Inspect ' + id, timestamp: 100 };
  const ctx = { cwd: '/work/' + id, sessionManager: {
    getSessionId: () => id,
    getBranch: () => [{ type: 'message', id: id + '-entry', message: user }],
  } };
  await handlers.get('session_start')!({}, ctx);
  await handlers.get('before_agent_start')!({}, ctx);
  await handlers.get('context_with_system')!({ messages: [{ role: 'system', content: 'System' }, user] }, ctx);
  return ctx;
}

it('finishes capture the old session admitted before another session became current', async () => {
  const old = await begin('old-session');
  let release!: (response: Response) => void;
  let started!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  holdObservation = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const inFlight = handlers.get('tool_result')!({ toolName: 'read', toolCallId: 'sent', content: 'already sent' }, old);
  await reached;
  const queued = handlers.get('tool_result')!({ toolName: 'read', toolCallId: 'unsent', content: 'old pending input' }, old);
  const summary = handlers.get('agent_end')!({}, old);
  const current = await begin('new-session');
  holdObservation = undefined;
  release(new Response(''));
  await Promise.all([inFlight, queued, summary]);
  // Admitted work posts under the session that owned capture when it was admitted.
  expect(posted.map(call => [call.route, call.body.contentSessionId, call.body.tool_use_id])).toEqual([
    ['/api/sessions/observations', 'old-session', 'sent'],
    ['/api/sessions/observations', 'old-session', 'unsent'],
    ['/api/sessions/summarize', 'old-session', undefined],
  ]);

  await handlers.get('tool_result')!({ toolName: 'read', toolCallId: 'fresh', content: 'fresh input' }, current);
  expect(posted.at(-1)!.body).toMatchObject({ contentSessionId: 'new-session', tool_use_id: 'fresh' });
});

it('ignores callbacks whose session context no longer owns capture', async () => {
  const old = await begin('old-session');
  const current = await begin('new-session');
  await handlers.get('tool_result')!({ toolName: 'read', toolCallId: 'stale', content: 'old result' }, old);
  await handlers.get('message_end')!({ message: { role: 'assistant', content: 'old answer' } }, old);
  await handlers.get('agent_end')!({}, old);
  expect(posted).toEqual([]);

  await handlers.get('message_end')!({ message: { role: 'assistant', content: 'new answer' } }, current);
  await handlers.get('agent_end')!({}, current);
  expect(posted).toHaveLength(1);
  expect(posted[0].body).toMatchObject({ contentSessionId: 'new-session', last_assistant_message: 'new answer' });
});
