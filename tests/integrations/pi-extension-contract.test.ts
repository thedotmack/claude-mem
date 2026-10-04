import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import extension, { extractTextContent, type PiExtensionAPI } from '../../src/integrations/pi-extension/index.js';

type Handler = (event: any, context: any) => any;
let originalFetch: typeof fetch;
let handlers: Map<string, Handler>;
let tools: Map<string, any>;
let calls: Array<{ route: string; url: URL; body?: any }>;
let context: any;
let initResponse: () => Promise<Response>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  handlers = new Map(); tools = new Map(); calls = [];
  context = { cwd: '/work/project', sessionManager: { getSessionId: () => 'real-session-id' } };
  initResponse = async () => Response.json({ sessionDbId: 42 });
  globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof options?.body === 'string' ? JSON.parse(options.body) : undefined;
    calls.push({ route: url.pathname, url, body });
    if (url.pathname === '/api/sessions/init') return initResponse();
    if (url.pathname === '/api/context/inject') return new Response('Useful project memory');
    return Response.json({ content: [{ type: 'text', text: 'Found memory' }] });
  }) as typeof fetch;
  extension({ on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool) } as PiExtensionAPI);
});
afterEach(() => { globalThis.fetch = originalFetch; });
const emit = async (name: string, event: any = {}) => handlers.get(name)?.(event, context);

describe('native Pi capture', () => {
  it('uses the session manager identity and current cwd; session_start itself has no ID', async () => {
    await emit('session_start', { reason: 'new', sessionId: 'wrong-event-id' });
    expect(calls.map(call => call.route)).toEqual(['/api/health', '/api/context/inject']);
    expect(calls[1].url.searchParams.get('cwd')).toBe('/work/project');
    const result = await emit('before_agent_start', { prompt: 'Fix the parser', systemPrompt: 'Base prompt' });
    expect(calls[2].body).toMatchObject({ contentSessionId: 'real-session-id', cwd: '/work/project', platformSource: 'pi' });
    expect(result.systemPrompt).toContain('Base prompt');
    expect(result.systemPrompt).toContain('Useful project memory');
  });

  it('queues prompt before tool before summary, carries tool-call identity, and summarizes each turn once', async () => {
    await emit('session_start');
    let finishInit!: (response: Response) => void;
    initResponse = () => new Promise(resolve => { finishInit = resolve; });
    const prompt = emit('before_agent_start', { prompt: 'Read the file' });
    const tool = emit('tool_result', { toolName: 'read', toolCallId: 'tool-7', input: { path: 'x.ts' }, content: [{ type: 'text', text: 'file text' }] });
    await Promise.resolve(); await Promise.resolve();
    expect(calls.some(call => call.route === '/api/sessions/observations')).toBe(false);
    finishInit(Response.json({ sessionDbId: 42 }));
    await Promise.all([prompt, tool]);
    await emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'The fix works' }] } });
    await emit('agent_end'); await emit('session_before_compact'); await emit('session_shutdown');
    expect(calls.filter(call => call.body).map(call => call.route)).toEqual(['/api/sessions/init', '/api/sessions/observations', '/api/sessions/summarize']);
    expect(calls.find(call => call.route === '/api/sessions/observations')?.body).toMatchObject({ tool_use_id: 'tool-7', tool_response: 'file text' });
    expect(calls.at(-1)?.body.last_assistant_message).toBe('The fix works');
  });

  it('starts a clean session after a switch or fork and does not reuse the old prompt', async () => {
    await emit('session_start');
    await emit('before_agent_start', { prompt: 'Old project' });
    context = { cwd: '/work/another', sessionManager: { getSessionId: () => 'fork-id' } };
    await emit('session_start', { reason: 'fork' });
    await emit('tool_result', { toolName: 'read', content: 'unanchored' });
    expect(calls.some(call => call.route === '/api/sessions/observations')).toBe(false);
    await emit('before_agent_start', { prompt: 'New project' });
    expect(calls.at(-1)?.body).toMatchObject({ contentSessionId: 'fork-id', cwd: '/work/another' });
  });

  it('honors skipped sessions, skips memory tools, and does not write unanchored tools', async () => {
    await emit('session_start');
    await emit('tool_result', { toolName: 'read', content: 'no prompt' });
    initResponse = async () => Response.json({ skipped: true });
    expect(await emit('before_agent_start', { prompt: 'Excluded project' })).toBeUndefined();
    await emit('tool_result', { toolName: 'read', content: 'private result' });
    await emit('tool_result', { toolName: 'mem_search', content: 'memory' });
    await emit('agent_end');
    expect(calls.filter(call => call.body)).toHaveLength(1);
  });

  it('fails open when init fails and retries on the next prompt', async () => {
    await emit('session_start');
    initResponse = async () => new Response('unavailable', { status: 503 });
    await emit('before_agent_start', { prompt: 'First try' });
    await emit('tool_result', { toolName: 'read', content: 'must not orphan' });
    expect(calls.some(call => call.route === '/api/sessions/observations')).toBe(false);
    initResponse = async () => Response.json({ sessionDbId: 42 });
    await emit('before_agent_start', { prompt: 'Retry' });
    await emit('tool_result', { toolName: 'read', content: 'record this' });
    expect(calls.at(-1)?.route).toBe('/api/sessions/observations');
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
});
