import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'path';
import type { Subprocess } from 'bun';

// The gateway's /mcp reaches the worker the gateway's way (plan Phase 12
// task 3): over a plain socket, so a proxy in the gateway's environment
// (Bun's fetch sends even loopback through HTTP_PROXY) never stands in
// between; and with no workspace folder of its own, it never scopes or
// saves memory under the daemon's folder. The gateway runs in a child
// process because Bun reads HTTP_PROXY at launch.

interface SeenWorkerRequest {
  path: string;
  search: string;
  body: unknown;
}

const seen: SeenWorkerRequest[] = [];
let worker: ReturnType<typeof Bun.serve>;
let child: Subprocess<'ignore', 'pipe', 'inherit'>;
let gatewayOrigin = '';

beforeAll(async () => {
  worker = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({ path: url.pathname, search: url.search, body: request.method === 'POST' ? await request.json() : null });
      return Response.json({ content: [{ type: 'text', text: 'remembered: the auth fix' }] });
    },
  });
  child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, 'helpers', 'mcp-gateway-child.ts')],
    env: {
      ...process.env,
      // A proxy that is not there: any fetch through it fails.
      HTTP_PROXY: 'http://127.0.0.1:9',
      http_proxy: 'http://127.0.0.1:9',
      NO_PROXY: '',
      no_proxy: '',
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_WORKER_PORT: String(worker.port),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = child.stdout.getReader();
  let printed = '';
  while (!/READY \d+/.test(printed)) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`the gateway child exited before it was ready: ${printed}`);
    printed += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  gatewayOrigin = `http://127.0.0.1:${/READY (\d+)/.exec(printed)![1]}`;
}, 20_000);

afterAll(async () => {
  child?.kill();
  await child?.exited;
  worker?.stop(true);
});

async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const response = await fetch(`${gatewayOrigin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  const answer = await response.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { text: answer.result.content[0].text, isError: answer.result.isError === true };
}

describe('/mcp tool calls reach the worker directly', () => {
  it('a search reaches the worker with HTTP_PROXY set to a dead proxy, unscoped (no checkout to widen it to)', async () => {
    seen.length = 0;
    const result = await callTool('search', { query: 'auth' });
    expect(result).toEqual({ text: 'remembered: the auth fix', isError: false });
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe('/api/search');
    const params = new URLSearchParams(seen[0].search);
    expect(params.get('query')).toBe('auth');
    expect(params.has('projects')).toBe(false);
    expect(params.has('project')).toBe(false);
  });

  it('save_memory names its project, or is refused: never the daemon\'s folder', async () => {
    seen.length = 0;
    const refused = await callTool('save_memory', { text: 'note' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('"project" is required');
    expect(seen).toHaveLength(0);
    const saved = await callTool('save_memory', { text: 'note', project: 'my-app' });
    expect(saved.isError).toBe(false);
    expect(seen).toEqual([{ path: '/api/memory/save', search: '', body: { text: 'note', project: 'my-app' } }]);
  });

  it('folder-bound tools refuse rather than work in the daemon\'s folder', async () => {
    seen.length = 0;
    const workState = await callTool('work_state_read', {});
    expect(workState.isError).toBe(true);
    expect(workState.text).toContain('this MCP server has none');
    const outline = await callTool('smart_outline', { file_path: 'package.json' });
    expect(outline.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });
});
