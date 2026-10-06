import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import extension, { extractTextContent, type PiExtensionAPI } from '../../src/integrations/pi-extension/index.js';

type Handler = (event: any, context: any) => any;
let originalFetch: typeof fetch;
let handlers: Map<string, Handler>;
let tools: Map<string, any>;
let calls: Array<{ route: string; url: URL; body?: any }>;
let context: any;
let branch: any[];
let messages: any[];
let stamp: number;
let initResponse: (body: any) => Promise<Response>;
let capabilityResponse: () => Promise<Response>;
const acknowledge = (body: any, extra: object = {}) =>
  Response.json({ sessionDbId: 42, nativePromptId: body.nativePromptId, nativePromptCurrent: true, ...extra });
const useSession = (sid: string, cwd = '/work/project') => {
  branch = []; messages = [];
  context = { cwd, sessionManager: { getSessionId: () => sid, getBranch: () => branch } };
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  handlers = new Map(); tools = new Map(); calls = []; stamp = 100;
  useSession('real-session-id');
  initResponse = async body => acknowledge(body);
  capabilityResponse = async () => Response.json({ nativePromptId: 1 });
  globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof options?.body === 'string' ? JSON.parse(options.body) : undefined;
    calls.push({ route: url.pathname, url, body });
    if (url.pathname === '/api/sessions/native-prompt-capability') return capabilityResponse();
    if (url.pathname === '/api/sessions/init') return initResponse(body);
    if (url.pathname === '/api/context/inject') return new Response('Useful project memory');
    return Response.json({ content: [{ type: 'text', text: 'Found memory' }] });
  }) as typeof fetch;
  extension({ on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool) } as PiExtensionAPI);
});
afterEach(() => { globalThis.fetch = originalFetch; });
const emit = async (name: string, event: any = {}) => handlers.get(name)?.(event, context);
const request = () => emit('context_with_system', { messages });
// This models the SDK order: the extension user hook finishes before append;
// the actual host's persisted ID is supplied only by the later branch getter.
const ask = async (text: string, id: string, timestamp = ++stamp) => {
  await emit('before_agent_start', { prompt: text, systemPrompt: 'Base prompt' });
  const user = { role: 'user', content: [{ type: 'text', text }], timestamp };
  await emit('message_end', { message: user });
  branch.push({ type: 'message', id, message: user });
  messages = [{ role: 'system', content: 'Base prompt', toolsAdded: [{ name: 'read' }] }, user];
  return request();
};
const inits = () => calls.filter(call => call.route === '/api/sessions/init');

describe('native Pi capture', () => {
  it('waits for the persisted user entry, retains the real SID/cwd, and preserves system context fields', async () => {
    await emit('session_start', { reason: 'new', sessionId: 'wrong-event-id' });
    expect(calls.map(call => call.route)).toEqual(['/api/health', '/api/context/inject']);
    expect(calls[1].url.searchParams.get('cwd')).toBe('/work/project');
    const user = { role: 'user', content: 'Fix the parser', timestamp: ++stamp };
    branch.push({ type: 'message', id: 'prior-user', message: { ...user, timestamp: 1 } });
    expect(await emit('before_agent_start', { prompt: 'Fix the parser', systemPrompt: 'Base prompt' })).toBeUndefined();
    await emit('message_end', { message: user });
    expect(inits()).toHaveLength(0);
    branch.push({ type: 'message', id: 'persisted-user-1', message: user });
    branch.push({ type: 'session_info', id: 'non-user-leaf' });
    messages = [{ role: 'system', content: 'Base prompt', toolsAdded: [{ name: 'read' }] }, user];
    const result = await request();
    expect(inits()[0].body).toMatchObject({
      contentSessionId: 'real-session-id', cwd: '/work/project', platformSource: 'pi',
      prompt: 'Fix the parser', nativePromptId: 'persisted-user-1',
    });
    expect(result.messages[0]).toMatchObject({ toolsAdded: [{ name: 'read' }] });
    expect(result.messages[0].content).toContain('Base prompt');
    expect(result.messages[0].content).toContain('Useful project memory');
    expect(result.messages[1]).toBe(user);
    expect(messages[0].content).toBe('Base prompt');
  });

  it('queues native prompt before tool before summary and preserves tool-call identity', async () => {
    await emit('session_start');
    let finishInit!: (response: Response) => void;
    let reachedInit!: () => void;
    const initStarted = new Promise<void>(resolve => { reachedInit = resolve; });
    initResponse = () => { reachedInit(); return new Promise(resolve => { finishInit = resolve; }); };
    const pending = ask('Read the file', 'user-read');
    // Wait for the mocked init request before enqueueing a tool.
    await initStarted;
    const tool = emit('tool_result', { toolName: 'read', toolCallId: 'tool-7', input: { path: 'x.ts' }, content: [{ type: 'text', text: 'file text' }] });
    expect(calls.some(call => call.route === '/api/sessions/observations')).toBe(false);
    finishInit(acknowledge({ nativePromptId: 'user-read' }));
    await Promise.all([pending, tool]);
    await emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'The fix works' }] } });
    await emit('agent_end'); await emit('session_before_compact'); await emit('session_shutdown');
    expect(calls.filter(call => call.body).map(call => call.route)).toEqual([
      '/api/sessions/init', '/api/sessions/observations', '/api/sessions/summarize',
    ]);
    expect(calls.find(call => call.route === '/api/sessions/observations')?.body).toMatchObject({ tool_use_id: 'tool-7', tool_response: 'file text' });
    expect(calls.at(-1)?.body.last_assistant_message).toBe('The fix works');
  });

  it('uses actual switched/forked SID and cwd without reusing the previous prompt', async () => {
    await emit('session_start');
    await ask('Old project', 'old-user');
    useSession('fork-id', '/work/another');
    await emit('session_start', { reason: 'fork' });
    await emit('tool_result', { toolName: 'read', content: 'unanchored' });
    expect(calls.some(call => call.route === '/api/sessions/observations')).toBe(false);
    await ask('New project', 'fork-user');
    expect(inits().at(-1)?.body).toMatchObject({ contentSessionId: 'fork-id', cwd: '/work/another', nativePromptId: 'fork-user' });
  });

  it('honors excluded sessions, skips memory tools, and does not write unanchored tools', async () => {
    await emit('session_start');
    await emit('tool_result', { toolName: 'read', content: 'no prompt' });
    initResponse = async () => Response.json({ skipped: true, reason: 'project_excluded' });
    expect(await ask('Excluded project', 'excluded-user')).toBeUndefined();
    await emit('tool_result', { toolName: 'read', content: 'private result' });
    await emit('tool_result', { toolName: 'mem_search', content: 'memory' });
    await emit('agent_end');
    expect(calls.filter(call => call.body)).toHaveLength(1);
  });

  it('fails open on worker outage, then retries the same persisted entry', async () => {
    await emit('session_start');
    initResponse = async () => new Response('unavailable', { status: 503 });
    expect(await ask('First try', 'retry-user')).toBeUndefined();
    await emit('tool_result', { toolName: 'read', content: 'must not orphan' });
    expect(calls.some(call => call.route === '/api/sessions/observations')).toBe(false);
    initResponse = async body => acknowledge(body, { skipped: true, reason: 'duplicate' });
    await request();
    await emit('tool_result', { toolName: 'read', content: 'record this' });
    expect(inits().map(call => call.body.nativePromptId)).toEqual(['retry-user', 'retry-user']);
    expect(calls.at(-1)?.route).toBe('/api/sessions/observations');
  });


  it.each(['empty', 'mismatch'])('reanchors the same admitted entry after nonthrowing %s branch data recovers without a turn reset', async (invalid: string) => {
    await emit('session_start');
    const first = await ask('Stable native prompt', 'recovered-entry');
    expect(first.messages[0].content).toContain('Useful project memory');
    expect(inits()).toHaveLength(1);
    const acceptedEntry = branch[0];
    const acceptedMessages = messages;

    branch = invalid === 'empty' ? [] : [{
      ...acceptedEntry,
      message: { ...acceptedEntry.message, timestamp: acceptedEntry.message.timestamp + 1 },
    }];
    expect(await request()).toBeUndefined();
    await emit('tool_result', { toolName: 'read', toolCallId: 'orphan-tool', content: 'must remain suppressed' });
    await emit('message_end', { message: { role: 'assistant', content: 'suppressed answer' } });
    await emit('agent_end');
    expect(calls.filter(call => call.body).map(call => call.route)).toEqual(['/api/sessions/init']);

    // Restore the genuine entry/request without before_agent_start, session_tree
    // or session_start; those resets would hide the initialized-state bug.
    branch = [acceptedEntry];
    messages = acceptedMessages;
    initResponse = async body => acknowledge(body, { skipped: true, reason: 'duplicate' });
    const recovered = await request();
    expect(calls.filter(call => call.route === '/api/sessions/native-prompt-capability')).toHaveLength(2);
    expect(inits()).toHaveLength(2);
    expect(inits().map(call => call.body)).toEqual([
      { contentSessionId: 'real-session-id', cwd: '/work/project', prompt: 'Stable native prompt', platformSource: 'pi', nativePromptId: 'recovered-entry' },
      { contentSessionId: 'real-session-id', cwd: '/work/project', prompt: 'Stable native prompt', platformSource: 'pi', nativePromptId: 'recovered-entry' },
    ]);
    expect(recovered.messages[0].content).toContain('Useful project memory');
    expect(recovered.messages[1]).toBe(acceptedEntry.message);
    expect(messages[0].content).toBe('Base prompt');
    await emit('tool_result', { toolName: 'read', toolCallId: 'recovered-tool', input: { path: 'same.ts' }, content: 'current result' });
    await emit('message_end', { message: { role: 'assistant', content: 'recovered answer' } });
    await emit('agent_end');
    await emit('session_before_compact');
    expect(calls.filter(call => call.body).map(call => call.route)).toEqual([
      '/api/sessions/init', '/api/sessions/init', '/api/sessions/observations', '/api/sessions/summarize',
    ]);
    expect(calls.find(call => call.route === '/api/sessions/observations')?.body).toMatchObject({
      contentSessionId: 'real-session-id', cwd: '/work/project', tool_use_id: 'recovered-tool', tool_response: 'current result',
    });
    expect(calls.at(-1)?.body).toMatchObject({
      contentSessionId: 'real-session-id', cwd: '/work/project', last_assistant_message: 'recovered answer',
    });
  });

  it('captures tools after the current duplicate acknowledgement and survives same-entry restart', async () => {
    await emit('session_start');
    initResponse = async body => acknowledge(body, { skipped: true, reason: 'duplicate' });
    await ask('Already persisted', 'stable-user');
    await request();
    expect(inits()).toHaveLength(1);
    await emit('session_start', { reason: 'switch' });
    await request();
    expect(inits().map(call => call.body.nativePromptId)).toEqual(['stable-user', 'stable-user']);
    await emit('tool_result', { toolName: 'read', toolCallId: 'after-retry', content: 'result' });
    await emit('agent_end');
    expect(calls.filter(call => call.body).map(call => call.route)).toEqual([
      '/api/sessions/init', '/api/sessions/init', '/api/sessions/observations', '/api/sessions/summarize',
    ]);
  });

  it('suppresses all private-turn context and capture, then accepts a public turn', async () => {
    await emit('session_start');
    initResponse = async () => Response.json({ sessionDbId: 42, skipped: true, reason: 'private' });
    expect(await ask('<private>secret</private>', 'private-user')).toBeUndefined();
    await emit('tool_result', { toolName: 'read', content: 'private result' });
    await emit('agent_end');
    expect(calls.filter(call => call.body).map(call => call.route)).toEqual(['/api/sessions/init']);
    initResponse = async body => acknowledge(body);
    const result = await ask('Public prompt', 'public-user');
    expect(result.messages[0].content).toContain('Useful project memory');
    await emit('tool_result', { toolName: 'read', content: 'public result' });
    await emit('agent_end');
    expect(calls.filter(call => call.body).map(call => call.route)).toEqual([
      '/api/sessions/init', '/api/sessions/init', '/api/sessions/observations', '/api/sessions/summarize',
    ]);
    expect(calls.find(call => call.route === '/api/sessions/observations')?.body.tool_response).toBe('public result');
  });

  it('offers progressive recall, validates timeline anchoring, and excludes image data', async () => {
    expect([...tools.keys()]).toEqual(['mem_search', 'mem_timeline', 'mem_get_observations']);
    const result = await tools.get('mem_search').execute('id', { query: 'test', limit: 3 });
    expect(result.content[0].text).toBe('Found memory');
    expect(calls.at(-1)?.url.searchParams.get('limit')).toBe('3');
    const invalid = await tools.get('mem_timeline').execute('id', { anchor: 1, query: 'two anchors' });
    expect(invalid.content[0].text).toContain('exactly one');
    expect(extractTextContent([{ type: 'image', data: 'secret' }, { type: 'text', text: 'safe' }])).toBe('safe');
  });

  it('distinguishes equal text in distinct native entries even when their timestamps are equal', async () => {
    await emit('session_start');
    await ask('Repeat me', 'entry-a', 123);
    await ask('Repeat me', 'entry-b', 123);
    expect(inits().map(call => call.body.nativePromptId)).toEqual(['entry-a', 'entry-b']);
    expect(inits().map(call => call.body.prompt)).toEqual(['Repeat me', 'Repeat me']);
  });

  it('refuses missing or mismatched host IDs and never borrows a prior leaf', async () => {
    await emit('session_start');
    await emit('before_agent_start', { prompt: 'New ask' });
    messages = [{ role: 'system', content: 'Base' }, { role: 'user', content: 'New ask', timestamp: 200 }];
    branch = [{ type: 'message', id: 'prior-id', message: { role: 'user', content: 'Old ask', timestamp: 100 } }];
    expect(await request()).toBeUndefined();
    branch = [{ type: 'message', message: messages[1] }];
    expect(await request()).toBeUndefined();
    delete context.sessionManager.getBranch;
    expect(await request()).toBeUndefined();
    expect(inits()).toHaveLength(0);
    await emit('tool_result', { toolName: 'read', content: 'unanchored' });
    await emit('agent_end');
    expect(calls.filter(call => call.body)).toHaveLength(0);
  });

  it('probes an unknown worker without legacy capture or context injection', async () => {
    await emit('session_start');
    capabilityResponse = async () => new Response('not supported', { status: 404 });
    expect(await ask('Native ask', 'real-id')).toBeUndefined();
    expect(inits()).toHaveLength(0);
    await emit('tool_result', { toolName: 'read', content: 'must not orphan' });
    await emit('agent_end');
    expect(calls.filter(call => call.body)).toHaveLength(0);
  });

  it('admits a new branch ask but suppresses older same-SID branch tool/summary attachment', async () => {
    await emit('session_start');
    await ask('Branch A', 'branch-a');
    await ask('Branch B', 'branch-b');
    await emit('session_tree');
    branch = [branch[0]];
    messages = [{ role: 'system', content: 'Base' }, branch[0].message];
    initResponse = async body => acknowledge(body, { skipped: true, reason: 'duplicate', nativePromptCurrent: false });
    expect(await request()).toBeUndefined();
    await emit('tool_result', { toolName: 'read', content: 'older branch result' });
    await emit('agent_end');
    expect(inits().map(call => call.body.nativePromptId)).toEqual(['branch-a', 'branch-b', 'branch-a']);
    expect(calls.some(call => call.route === '/api/sessions/observations' || call.route === '/api/sessions/summarize')).toBe(false);
  });

  it('sends only native-entry text from mixed messages and leaves image-only turns unanchored', async () => {
    await emit('session_start');
    const imageUser = { role: 'user', content: [{ type: 'image', data: 'IMAGE-SECRET' }], timestamp: 100 };
    branch = [{ type: 'message', id: 'image-user', message: imageUser }];
    messages = [{ role: 'system', content: 'Base' }, imageUser];
    expect(await request()).toBeUndefined();
    expect(inits()).toHaveLength(0);
    const mixedUser = { role: 'user', content: [{ type: 'image', data: 'IMAGE-SECRET' }, { type: 'text', text: 'Explain image' }], timestamp: 101 };
    branch.push({ type: 'message', id: 'mixed-user', message: mixedUser });
    messages = [{ role: 'system', content: 'Base' }, mixedUser];
    await request();
    expect(inits()[0].body.prompt).toBe('Explain image');
    expect(JSON.stringify(inits()[0].body)).not.toContain('IMAGE-SECRET');
  });

  it('disarms a prior anchor when the genuine branch getter refuses', async () => {
    await emit('session_start');
    await ask('First ask', 'first-entry');
    context.sessionManager.getBranch = () => { throw new Error('stale native context'); };
    expect(await request()).toBeUndefined();
    await emit('tool_result', { toolName: 'read', content: 'not the previous ask' });
    await emit('agent_end');
    expect(calls.some(call => call.route === '/api/sessions/observations' || call.route === '/api/sessions/summarize')).toBe(false);
  });
});
