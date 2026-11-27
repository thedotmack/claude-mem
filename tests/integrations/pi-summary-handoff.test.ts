import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension, { type PiExtensionAPI } from '../../src/integrations/pi-extension/index.js';

type Handler = Parameters<PiExtensionAPI['on']>[1];
type Failure = 401 | 429 | 503 | 'disconnect';

describe('Pi summary live handoff', () => {
  let server: Server;
  let directory: string;
  let handlers: Map<string, Handler>;
  let summaries: Array<Record<string, unknown>>;
  let failure: Failure | undefined;
  let beforeSummary: (() => Promise<void>) | undefined;
  let savedEnv: Map<string, string | undefined>;
  const envKeys = ['CLAUDE_MEM_DATA_DIR', 'CLAUDE_MEM_WORKER_URL', 'CLAUDE_MEM_WORKER_HOST', 'CLAUDE_MEM_WORKER_PORT'];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'claude-mem-pi-summary-'));
    savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
    handlers = new Map();
    summaries = [];
    failure = undefined;
    beforeSummary = undefined;
    server = createServer(async (request, response) => {
      let text = '';
      for await (const chunk of request) text += chunk.toString();
      const body = text ? JSON.parse(text) as Record<string, unknown> : {};
      const route = new URL(request.url!, 'http://localhost').pathname;
      response.setHeader('content-type', 'application/json');
      if (route === '/api/sessions/native-prompt-capability') {
        response.end(JSON.stringify({ nativePromptId: 1 }));
      } else if (route === '/api/sessions/init') {
        response.end(JSON.stringify({ sessionDbId: 42, nativePromptId: body.nativePromptId, nativePromptCurrent: true }));
      } else if (route === '/api/sessions/summarize') {
        summaries.push(body);
        await beforeSummary?.();
        if (failure === 'disconnect') {
          // The input arrived, but its acknowledgement is lost.
          request.socket.destroy();
          return;
        }
        response.statusCode = failure ?? 200;
        response.end('{}');
      } else if (route === '/api/context/inject') {
        response.end('');
      } else {
        response.end('{}');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    process.env.CLAUDE_MEM_DATA_DIR = directory;
    process.env.CLAUDE_MEM_WORKER_URL = `http://127.0.0.1:${address.port}`;
    process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
    process.env.CLAUDE_MEM_WORKER_PORT = String(address.port);
    extension({ on: (name, handler) => handlers.set(name, handler), registerTool: () => {} });
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  async function session() {
    let entries: Array<{ type: string; id: string; message: { role: string; content: string; timestamp: number } }> = [];
    const ctx = { cwd: directory, sessionManager: {
      getSessionId: () => 'pi-summary-session',
      getBranch: () => entries,
    } };
    const emit = async (name: string) => handlers.get(name)!({}, ctx);
    await emit('session_start');
    const turn = async (id: number) => {
      await emit('before_agent_start');
      const user = { role: 'user', content: `Request ${id}`, timestamp: 1000 + id };
      entries = [{ type: 'message', id: `entry-${id}`, message: user }];
      await handlers.get('context_with_system')!({ messages: [{ role: 'system', content: 'System' }, user] }, ctx);
      await handlers.get('message_end')!({ message: { role: 'assistant', content: `Answer ${id}` } }, ctx);
    };
    return { emit, turn };
  }

  it.each([401, 429, 503, 'disconnect'] as const)('does not replay a failed summary after %s', async reason => {
    const { emit, turn } = await session();
    await turn(1);
    failure = reason;
    await emit('agent_end');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].last_assistant_message).toBe('Answer 1');

    // A healthy worker and later lifecycle events are not replay permission.
    failure = undefined;
    await emit('session_before_compact');
    await emit('session_shutdown');
    await emit('agent_end');
    expect(summaries).toHaveLength(1);

    // A newly persisted user entry can still start fresh capture.
    await turn(2);
    await emit('agent_end');
    await emit('session_shutdown');
    expect(summaries.map(body => body.last_assistant_message)).toEqual(['Answer 1', 'Answer 2']);
  });

  it('does not resend when lifecycle callbacks queue behind a failed handoff', async () => {
    const { emit, turn } = await session();
    await turn(1);
    let release!: () => void;
    let started!: () => void;
    const reached = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    beforeSummary = () => { started(); return held; };
    failure = 503;
    const ending = emit('agent_end');
    await reached;
    const compacting = emit('session_before_compact');
    const shuttingDown = emit('session_shutdown');
    release();
    await Promise.all([ending, compacting, shuttingDown]);
    expect(summaries).toHaveLength(1);
  });

  it('keeps successful summaries at one handoff per turn', async () => {
    const { emit, turn } = await session();
    await turn(1);
    await emit('agent_end');
    await emit('session_before_compact');
    await emit('session_shutdown');
    expect(summaries).toHaveLength(1);
    await turn(2);
    await emit('session_before_compact');
    await emit('agent_end');
    expect(summaries.map(body => body.last_assistant_message)).toEqual(['Answer 1', 'Answer 2']);
  });
});
