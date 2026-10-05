import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import plugin from '../../src/integrations/opencode-plugin/v2.js';

let originalFetch: typeof fetch;
let messages: any[];
let calls: Array<{ route: string; body?: any }>;
let hooks: Map<string, (event: any) => any>;
let cleanup: () => Promise<void>;
let location: string;
let init: () => Promise<Response>;
let disposed: number;
let pending: ((event: any) => void) | undefined;
let buffered: any[];
let ctx: any;
const user = (id: string, text: string, metadata?: any) => ({ id, type: 'user', text, metadata });
const context = () => ({ sessionID: 'ses_real-host-id', system: [{ type: 'text', text: 'Base instructions' }], model: { id: 'fixture' } });
async function until(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !condition(); index++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(condition()).toBe(true);
}
function send(type: string, data: any = {}, directory = '/work/project'): void {
  const value = { type, data: { sessionID: 'ses_real-host-id', ...data }, location: { directory } };
  if (pending) { const resolve = pending; pending = undefined; resolve(value); } else buffered.push(value);
}
beforeEach(async () => {
  originalFetch = globalThis.fetch;
  messages = [user('msg_real-1', 'Read the parser')];
  calls = []; hooks = new Map(); location = '/work/project'; disposed = 0; buffered = []; pending = undefined;
  init = async () => Response.json({ sessionDbId: 42 });
  globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof options?.body === 'string' ? JSON.parse(options.body) : undefined;
    calls.push({ route: url.pathname, body });
    if (url.pathname === '/api/sessions/init') return init();
    if (url.pathname === '/api/context/inject') return new Response('Project memory');
    return Response.json({ status: 'queued' });
  }) as typeof fetch;
  const hook = async (name: string, callback: (event: any) => any) => {
    hooks.set(name, callback);
    return { dispose: async () => { disposed++; } };
  };
  ctx = {
    location: { directory: '/work/project' },
    session: { hook, get: async () => ({ location: { directory: location } }), context: async () => messages },
    tool: { hook },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          const next = buffered.shift() ?? await new Promise(resolve => {
            const done = () => { signal.removeEventListener('abort', abort); resolve(undefined); };
            const abort = done;
            pending = event => { signal.removeEventListener('abort', abort); resolve(event); };
            signal.addEventListener('abort', abort, { once: true });
          });
          if (next) yield next;
        }
      },
    },
  };
  cleanup = await plugin.setup(ctx);
});
afterEach(async () => { await cleanup(); globalThis.fetch = originalFetch; });
const emit = (name: string, event: any) => hooks.get(name)!(event);
const read = () => emit('execute.after', {
  sessionID: 'ses_real-host-id', tool: 'read', id: 'call_host-7', input: { path: 'parser.ts' },
  status: 'completed', result: { content: [{ type: 'text', text: 'Parser contents' }, { type: 'file', uri: 'image-data' }] },
});

describe('OpenCode v2 consumed-turn capture', () => {
  it('uses native IDs, anchors before tools and summarizes once across execution/compaction events', async () => {
    const event = context();
    await emit('context', event); await read();
    send('session.text.ended', { text: 'Parser checked', assistantMessageID: 'msg_answer', ordinal: 0 });
    send('session.execution.succeeded'); send('session.compaction.ended');
    await until(() => calls.filter(call => call.route === '/api/sessions/summarize').length === 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(event.system[0].text).toBe('Base instructions');
    expect(event.system[1].text).toContain('Project memory');
    const writes = calls.filter(call => call.body);
    expect(writes.map(call => call.route)).toEqual(['/api/sessions/init', '/api/sessions/observations', '/api/sessions/summarize']);
    expect(writes.every(call => call.body.contentSessionId === 'ses_real-host-id' && call.body.cwd === '/work/project')).toBe(true);
    expect(writes[1].body).toMatchObject({ tool_use_id: 'call_host-7', tool_input: { path: 'parser.ts' }, tool_response: 'Parser contents' });
    expect(writes[2].body.last_assistant_message).toBe('Parser checked');
  });

  it('does not anchor admitted/queued prompts until they enter delivered context', async () => {
    await emit('context', context());
    await emit('context', context());
    expect(calls.filter(call => call.route === '/api/sessions/init').map(call => call.body.prompt)).toEqual(['Read the parser']);
    messages.push(user('msg_real-2', 'Now inspect the test'));
    await emit('context', context());
    await read();
    expect(calls.filter(call => call.route === '/api/sessions/init').map(call => call.body.prompt)).toEqual(['Read the parser', 'Now inspect the test']);
    expect(hooks.has('prompt')).toBe(false);
  });

  it('queues a concurrent tool behind a pending prompt acknowledgement', async () => {
    let finish!: (response: Response) => void;
    init = () => new Promise(resolve => { finish = resolve; });
    const prompt = emit('context', context());
    await until(() => !!finish);
    const tool = read();
    await new Promise(resolve => setTimeout(resolve, 2));
    expect(calls.some(call => call.route === '/api/sessions/observations')).toBe(false);
    finish(Response.json({ sessionDbId: 42 }));
    await Promise.all([prompt, tool]);
    expect(calls.filter(call => call.body).map(call => call.route)).toEqual(['/api/sessions/init', '/api/sessions/observations']);
  });

  it('keeps duplicate acknowledgements anchored and suppresses excluded turns', async () => {
    init = async () => Response.json({ sessionDbId: 42, skipped: true, reason: 'duplicate' });
    await emit('context', context()); await read();
    expect(calls.filter(call => call.route === '/api/sessions/observations')).toHaveLength(1);
    messages.push(user('msg_real-2', 'Excluded turn'));
    init = async () => Response.json({ skipped: true, reason: 'project_excluded' });
    await emit('context', context()); await read();
    expect(calls.filter(call => call.route === '/api/sessions/observations')).toHaveLength(1);
  });

  it('does not capture synthetic or private activity against an earlier real prompt', async () => {
    await emit('context', context());
    messages.push({ type: 'synthetic', id: 'msg_helper', text: 'Internal continuation' });
    await emit('context', context()); await read();
    messages.push(user('msg_private', '<private>secret</private>'));
    await emit('context', context()); await read();
    messages.push(user('msg_public', 'Public continuation'));
    await emit('context', context()); await read();
    expect(calls.filter(call => call.route === '/api/sessions/init').map(call => call.body.prompt)).toEqual(['Read the parser', 'Public continuation']);
    expect(calls.filter(call => call.route === '/api/sessions/observations')).toHaveLength(1);
  });

  it('retries a failed anchor before accepting tools and skips its own MCP recall', async () => {
    init = async () => new Response('Unavailable', { status: 503 });
    await emit('context', context()); await read();
    expect(calls.some(call => call.route === '/api/sessions/observations')).toBe(false);
    init = async () => Response.json({ sessionDbId: 42 });
    await emit('context', context());
    await emit('execute.after', { sessionID: 'ses_real-host-id', tool: 'claude-mem_search' });
    await read();
    expect(calls.filter(call => call.route === '/api/sessions/observations')).toHaveLength(1);
  });

  it('verifies ownership after a session moves and ignores other locations on the public stream', async () => {
    location = '/work/other';
    await emit('context', context()); await read();
    expect(calls).toHaveLength(0);
    location = '/work/project'; await emit('context', context());
    send('session.execution.succeeded', {}, '/work/other');
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(calls.some(call => call.route === '/api/sessions/summarize')).toBe(false);
    location = '/work/other'; await read();
    expect(calls.some(call => call.route === '/api/sessions/observations')).toBe(false);
  });

  it('does not resurrect deleted sessions and disposes native registrations on unload', async () => {
    await emit('context', context());
    send('session.deleted');
    await new Promise(resolve => setTimeout(resolve, 5));
    await emit('context', context()); await read();
    expect(calls.filter(call => call.route === '/api/sessions/init')).toHaveLength(1);
    expect(calls.some(call => call.route === '/api/sessions/observations')).toBe(false);
    await cleanup();
    expect(disposed).toBe(3);
    cleanup = async () => {};
  });
});
