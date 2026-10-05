import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import plugin from '../../src/integrations/opencode-plugin/v2.js';
import { extractObservationFileEvidence } from '../../src/services/worker/agents/ResponseProcessor.js';

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
let handledEvents: string[];
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
// 2.0.23 emits session.execution.* and session.deleted without a location envelope.
function sendUnlocated(type: string, data: any = {}): void {
  const value = { type, data: { sessionID: 'ses_real-host-id', ...data } };
  if (pending) { const resolve = pending; pending = undefined; resolve(value); } else buffered.push(value);
}
beforeEach(async () => {
  originalFetch = globalThis.fetch;
  messages = [user('msg_real-1', 'Read the parser')];
  calls = []; hooks = new Map(); location = '/work/project'; disposed = 0; buffered = []; handledEvents = []; pending = undefined;
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
          if (next) { yield next; handledEvents.push((next as any).type); }
        }
      },
    },
  };
  cleanup = await plugin.setup(ctx);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('OpenCode v2 callback lifetime', () => {
  for (const type of ['session.text.ended', 'session.execution.succeeded', 'session.compaction.ended']) {
    it(`deletion aborts a pending ${type} ownership lookup while another session stays live`, async () => {
      await emit('context', context());
      const held = deferred<void>();
      const getFixture = ctx.session.get;
      let entered = false;
      let signal: AbortSignal | undefined;
      ctx.session.get = async (input: { sessionID: string }, options?: { signal?: AbortSignal }) => {
        if (input.sessionID === 'ses_real-host-id') {
          entered = true; signal = options?.signal;
          // A late successful SDK response must not revive the deleted session.
          await held.promise;
        }
        return getFixture(input, options);
      };
      send(type, { text: 'Deleted session answer' });
      await until(() => entered);
      let afterStop = 0;
      try {
        send('session.deleted');
        await until(() => handledEvents.includes('session.deleted'));
        expect(signal?.aborted).toBe(true);
        afterStop = calls.length;
        const sessionID = 'ses_live-during-ownership';
        await emit('context', { ...context(), sessionID });
        await emit('execute.after', { sessionID, tool: 'read', id: 'call_live-ownership', input: { path: 'live.ts' }, status: 'completed', result: 'Live contents' });
        send('session.text.ended', { sessionID, text: 'Live session answer' });
        send('session.execution.succeeded', { sessionID });
        await until(() => calls.some(call => call.route === '/api/sessions/summarize'));
      } finally { held.resolve(); }
      await emit('context', context()); await read();
      await new Promise(resolve => setTimeout(resolve, 5));
      const writes = calls.slice(afterStop).filter(call => call.body);
      expect(writes.map(call => call.route)).toEqual(['/api/sessions/init', '/api/sessions/observations', '/api/sessions/summarize']);
      expect(writes.every(call => call.body.contentSessionId === 'ses_live-during-ownership')).toBe(true);
      expect(writes[2].body.last_assistant_message).toBe('Live session answer');
    });
  }

  it('keeps tools and public events behind a pending context ownership lookup', async () => {
    const held = deferred<void>();
    const getFixture = ctx.session.get;
    let entered = false;
    ctx.session.get = async (input: unknown, options: unknown) => {
      if (!entered) { entered = true; await held.promise; }
      return getFixture(input, options);
    };
    const prompt = emit('context', context());
    await until(() => entered);
    const tool = read();
    send('session.text.ended', { text: 'Ordered answer' });
    send('session.execution.succeeded');
    try {
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(calls).toEqual([]);
    } finally { held.resolve(); }
    await Promise.all([prompt, tool]);
    await until(() => calls.some(call => call.route === '/api/sessions/summarize'));
    const writes = calls.filter(call => call.body);
    expect(writes.map(call => call.route)).toEqual(['/api/sessions/init', '/api/sessions/observations', '/api/sessions/summarize']);
    expect(writes[2].body.last_assistant_message).toBe('Ordered answer');
  });

  it('deleting one pending session preserves ordered capture in another live session', async () => {
    const held = deferred<void>();
    const fetchFixture = globalThis.fetch;
    let entered = false;
    globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
      if (new URL(String(input)).pathname !== '/api/health' || entered) return fetchFixture(input, options);
      entered = true; calls.push({ route: '/api/health' });
      await held.promise;
      return Response.json({ status: 'ok' });
    }) as typeof fetch;
    const deletedContext = context();
    const pendingContext = emit('context', deletedContext);
    await until(() => entered);
    try {
      send('session.deleted');
      await until(() => handledEvents.includes('session.deleted'));
      const sessionID = 'ses_other-live-session';
      await emit('context', { ...context(), sessionID });
      await emit('execute.after', { sessionID, tool: 'read', id: 'call_other-session', input: { path: 'other.ts' }, status: 'completed', result: 'Other contents' });
      send('session.text.ended', { sessionID, text: 'Other session finished' });
      send('session.execution.succeeded', { sessionID });
      await until(() => calls.some(call => call.route === '/api/sessions/summarize'));
    } finally { held.resolve(); }
    await pendingContext;
    const writes = calls.filter(call => call.body);
    expect(writes.map(call => call.route)).toEqual(['/api/sessions/init', '/api/sessions/observations', '/api/sessions/summarize']);
    expect(writes.every(call => call.body.contentSessionId === 'ses_other-live-session')).toBe(true);
    expect(writes[2].body.last_assistant_message).toBe('Other session finished');
    expect(deletedContext.system).toEqual(context().system);
  });

  for (const ending of ['unload', 'delete'] as const) {
    for (const stage of [
      'ownership', 'delivered context', 'prompt health', 'prompt init', 'prompt body',
      'context health', 'context request', 'context body', 'previous summary',
    ] as const) {
      it(`${ending} during ${stage} cancels pending and queued work without changing model context`, async () => {
        if (stage === 'previous summary') {
          await emit('context', context());
          messages.push(user('msg_real-2', 'Read another file'));
        }
        const held = deferred<void>();
        let started = false;
        let signal: AbortSignal | undefined;
        const hold = async (value: AbortSignal | null | undefined) => {
          started = true; signal = value ?? undefined;
          await held.promise;
        };
        if (stage === 'ownership') {
          ctx.session.get = async (_input: unknown, options?: { signal?: AbortSignal }) => {
            await hold(options?.signal);
            return { location: { directory: location } };
          };
        } else if (stage === 'delivered context') {
          ctx.session.context = async (_input: unknown, options?: { signal?: AbortSignal }) => {
            await hold(options?.signal);
            return messages;
          };
        } else {
          const fetchFixture = globalThis.fetch;
          let health = 0;
          globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
            const url = new URL(String(input));
            if (url.pathname === '/api/health') health++;
            const target = stage === 'prompt health' ? url.pathname === '/api/health' && health === 1
              : stage === 'context health' ? url.pathname === '/api/health' && health === 2
              : stage.startsWith('prompt') ? url.pathname === '/api/sessions/init'
              : stage === 'previous summary' ? url.pathname === '/api/sessions/summarize'
              : url.pathname === '/api/context/inject';
            if (!target) return fetchFixture(input, options);
            // Deliberately ignore fetch aborts: even late successful responses must be inert.
            calls.push({ route: url.pathname, body: typeof options?.body === 'string' ? JSON.parse(options.body) : undefined });
            const response = url.pathname === '/api/context/inject' ? new Response('Late project memory') : Response.json({ sessionDbId: 42 });
            if (stage === 'prompt body') {
              response.json = async () => { await hold(options?.signal); return { sessionDbId: 42 }; };
            } else if (stage === 'context body') {
              response.text = async () => { await hold(options?.signal); return 'Late project memory'; };
            } else await hold(options?.signal);
            return response;
          }) as typeof fetch;
        }
        const event = context();
        event.system.push({ type: 'text', text: '<claude-mem-context>Existing context</claude-mem-context>' });
        const original = event.system;
        const contents = structuredClone(original);
        const pendingContext = emit('context', event);
        await until(() => started);
        const pendingTool = read();
        let afterStop = 0;
        try {
          if (ending === 'unload') { await cleanup(); cleanup = async () => {}; }
          else { send('session.deleted'); await until(() => handledEvents.includes('session.deleted')); }
          afterStop = calls.length;
        } finally { held.resolve(); }
        await Promise.all([pendingContext, pendingTool]);
        expect(calls.slice(afterStop)).toEqual([]);
        expect(event.system).toBe(original);
        expect(event.system).toEqual(contents);
        expect(signal?.aborted).toBe(true);
        await emit('context', context()); await read();
        expect(calls.slice(afterStop)).toEqual([]);
      });
    }

    for (const route of ['/api/sessions/observations', '/api/sessions/summarize']) {
      it(`${ending} cancels an in-flight ${route} and does not block deletion behind queued capture`, async () => {
        await emit('context', context());
        const held = deferred<void>();
        const fetchFixture = globalThis.fetch;
        let signal: AbortSignal | undefined;
        let started = false;
        globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
          if (new URL(String(input)).pathname !== route) return fetchFixture(input, options);
          calls.push({ route, body: JSON.parse(String(options?.body)) });
          signal = options?.signal ?? undefined; started = true;
          await held.promise;
          return Response.json({ status: 'queued' });
        }) as typeof fetch;
        const pendingTool = route === '/api/sessions/observations' ? read() : Promise.resolve();
        if (route === '/api/sessions/summarize') send('session.execution.succeeded');
        await until(() => started);
        if (route === '/api/sessions/observations') send('session.execution.succeeded');
        let afterStop = 0;
        try {
          if (ending === 'unload') { await cleanup(); cleanup = async () => {}; }
          else { send('session.deleted'); await until(() => handledEvents.includes('session.deleted')); }
          expect(signal?.aborted).toBe(true);
          afterStop = calls.length;
        } finally { held.resolve(); }
        await pendingTool;
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(calls.slice(afterStop)).toEqual([]);
        expect(calls.filter(call => call.route === '/api/sessions/summarize')).toHaveLength(route === '/api/sessions/summarize' ? 1 : 0);
      });
    }
  }
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

  it('captures a late tool result from the turn it ran in when the next prompt cannot anchor', async () => {
    let finish!: (response: Response) => void;
    let inits = 0;
    init = () => ++inits === 1
      ? new Promise<Response>(resolve => { finish = resolve; })
      : Response.json({ skipped: true, reason: 'project_excluded' });
    const first = emit('context', context());
    await until(() => !!finish);
    messages.push(user('msg_real-2', 'Excluded turn'));
    const second = emit('context', context());
    const tool = read();
    await new Promise(resolve => setTimeout(resolve, 2));
    finish(Response.json({ sessionDbId: 42 }));
    await Promise.all([first, second, tool]);
    await new Promise(resolve => setTimeout(resolve, 5));
    const observations = calls.filter(call => call.route === '/api/sessions/observations');
    expect(observations).toHaveLength(1);
    expect(observations[0].body).toMatchObject({ tool_use_id: 'call_host-7', tool_input: { path: 'parser.ts' } });
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

  it('summarizes from a location-less execution event, the envelope 2.0.23 emits', async () => {
    await emit('context', context()); await read();
    send('session.text.ended', { text: 'Parser checked', assistantMessageID: 'msg_answer', ordinal: 0 });
    sendUnlocated('session.execution.succeeded');
    await until(() => calls.some(call => call.route === '/api/sessions/summarize'));
    const writes = calls.filter(call => call.body);
    expect(writes.map(call => call.route)).toEqual(['/api/sessions/init', '/api/sessions/observations', '/api/sessions/summarize']);
    expect(writes[2].body.last_assistant_message).toBe('Parser checked');
  });

  it('aborts a session from a location-less deleted event, the envelope 2.0.23 emits', async () => {
    await emit('context', context());
    sendUnlocated('session.deleted');
    await until(() => handledEvents.includes('session.deleted'));
    await new Promise(resolve => setTimeout(resolve, 5));
    await emit('context', context()); await read();
    expect(calls.filter(call => call.route === '/api/sessions/init')).toHaveLength(1);
    expect(calls.some(call => call.route === '/api/sessions/observations')).toBe(false);
  });
});

describe('OpenCode v2 native file evidence', () => {
  for (const [tool, name, input] of [
    ['read', 'Read', { filePath: '/work/project/parser.ts', offset: 1, limit: 20 }],
    ['write', 'Write', { filePath: '/work/project/parser.ts', content: 'new parser' }],
    ['edit', 'Edit', { filePath: '/work/project/parser.ts', oldString: 'old', newString: 'new' }],
  ] as const) {
    it(`captures native ${tool} with its real call ID and worker-readable file evidence`, async () => {
      await emit('context', context());
      await emit('execute.after', {
        sessionID: 'ses_real-host-id', agent: 'build', messageID: 'msg_real-response',
        tool, id: 'call_native-' + tool, input: Object.freeze(input),
        status: 'completed', result: { content: [{ type: 'text', text: 'Native result' }] },
      });
      const body = calls.find(call => call.route === '/api/sessions/observations')!.body;
      expect(body).toMatchObject({ contentSessionId: 'ses_real-host-id', tool_name: name, tool_use_id: 'call_native-' + tool, tool_input: input });
      expect(extractObservationFileEvidence([{ type: 'observation', tool_name: body.tool_name, tool_input: body.tool_input }])).toEqual({
        files_read: tool === 'read' ? ['/work/project/parser.ts'] : [],
        files_modified: tool === 'read' ? [] : ['/work/project/parser.ts'],
      });
    });
  }

  it('renames native patchText without duplicating the patch or mutating host input', async () => {
    await emit('context', context());
    const patchText = '*** Begin Patch\n*** Update File: parser.ts\n@@\n-old\n+new\n*** End Patch';
    const input = Object.freeze({ patchText, patch: 'stale patch', reason: 'Fix parser' });
    await emit('execute.after', {
      sessionID: 'ses_real-host-id', agent: 'build', messageID: 'msg_real-response',
      tool: 'apply_patch', id: 'call_native-patch', input,
      status: 'completed', result: { content: [{ type: 'text', text: 'Patched parser.ts' }] },
    });
    const body = calls.find(call => call.route === '/api/sessions/observations')!.body;
    expect(body).toMatchObject({ tool_name: 'apply_patch', tool_use_id: 'call_native-patch', tool_input: { patch: patchText, reason: 'Fix parser' } });
    expect(Object.hasOwn(body.tool_input, 'patchText')).toBe(false);
    expect(JSON.stringify(body).match(/\*\*\* Begin Patch/g)).toHaveLength(1);
    expect(input).toEqual({ patchText, patch: 'stale patch', reason: 'Fix parser' });
    expect(extractObservationFileEvidence([{ type: 'observation', tool_name: body.tool_name, tool_input: body.tool_input }])).toEqual({
      files_read: [], files_modified: ['parser.ts'],
    });
  });
});
