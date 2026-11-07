// End to end: a real MCP client talks Streamable HTTP to startMcpHttpServer and every
// session must see its own project directory (header first, then roots/list).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListRootsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CWD_HEADER, startMcpHttpServer, type CwdResolver, type McpHttpHandle } from '../../src/servers/mcp-http.js';
import { getRequestCwd, runWithCwd } from '../../src/servers/request-context.js';
import type { WorkerOriginPolicy } from '../../src/services/worker/http/origin-policy.js';

const temp = mkdtempSync(join(tmpdir(), 'cm-http-'));
const projectA = join(temp, 'project-a');
const projectB = join(temp, 'project-b');
mkdirSync(projectA);
mkdirSync(projectB);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for the claude-mem Server: one tool that reports the cwd the handler sees.
 * It waits before answering, so overlapping requests of one session really overlap.
 */
function createFakeServer(resolveCwd: CwdResolver): Server {
  const server = new Server({ name: 'fake', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'whoami', description: 'cwd of the call', inputSchema: { type: 'object' as const } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
    const cwd = resolveCwd(extra);
    await sleep(60);
    return { content: [{ type: 'text' as const, text: await runWithCwd(cwd, async () => getRequestCwd()) }] };
  });
  return server;
}

const ALLOWED_ORIGIN = 'http://allowed.test:8080';
const originPolicy: WorkerOriginPolicy = { allowedOrigins: [ALLOWED_ORIGIN], workerHost: '' };

let open: McpHttpHandle;
let capped: McpHttpHandle;
const clients: Client[] = [];

beforeAll(async () => {
  open = await startMcpHttpServer({ host: '127.0.0.1', port: 0, originPolicy, createServer: createFakeServer });
  capped = await startMcpHttpServer({ host: '127.0.0.1', port: 0, originPolicy, maxSessions: 2, createServer: createFakeServer });
});

afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  await open.close();
  await capped.close();
  rmSync(temp, { recursive: true, force: true });
});

async function connect(
  handle: McpHttpHandle,
  headers: Record<string, string>,
  roots?: { current: string },
): Promise<Client> {
  const client = new Client(
    { name: 't', version: '0' },
    { capabilities: roots ? { roots: { listChanged: true } } : {} },
  );
  if (roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(roots.current).href }],
    }));
  }
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${handle.port}/mcp`),
    { requestInit: { headers } },
  ));
  clients.push(client);
  return client;
}

async function whoami(client: Client): Promise<string> {
  const result = await client.callTool({ name: 'whoami', arguments: {} });
  return (result.content as Array<{ text: string }>)[0].text;
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 30 && !done(value); i++) {
    await sleep(100);
    value = await read();
  }
  return value;
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const INITIALIZE = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
};

/** The JSON-RPC result of an SSE or JSON response body. */
function parseRpc(text: string): any {
  const data = text.split('\n').find((line) => line.startsWith('data:'));
  return JSON.parse(data ? data.slice(5) : text);
}

/** A raw request, so the test controls Host and Origin (fetch does not let it set Host). */
function raw(
  handle: McpHttpHandle,
  options: { path?: string; method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: string }> {
  return new Promise((resolveResponse, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: handle.port,
        path: options.path ?? '/mcp',
        method: options.method ?? 'POST',
        headers: { ...JSON_HEADERS, ...options.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolveResponse({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

describe('mcp http server', () => {
  it('gives every session the cwd of its X-Claude-Mem-Cwd header', async () => {
    const a = await connect(open, { [CWD_HEADER]: projectA });
    const b = await connect(open, { [CWD_HEADER]: projectB });
    expect(await whoami(a)).toBe(resolve(projectA));
    expect(await whoami(b)).toBe(resolve(projectB));
    expect(open.sessionCount()).toBeGreaterThanOrEqual(2);
  });

  it('falls back to the client roots/list answer when there is no header', async () => {
    const client = await connect(open, {}, { current: projectB });
    const seen = await eventually(() => whoami(client), (cwd) => cwd === resolve(projectB));
    expect(seen).toBe(resolve(projectB));
  });

  it('prefers the header over roots', async () => {
    const client = await connect(open, { [CWD_HEADER]: projectA }, { current: projectB });
    await sleep(300);
    expect(await whoami(client)).toBe(resolve(projectA));
  });

  it('follows the client when its roots change (roots/list_changed)', async () => {
    const roots = { current: projectA };
    const client = await connect(open, {}, roots);
    expect(await eventually(() => whoami(client), (cwd) => cwd === resolve(projectA))).toBe(resolve(projectA));

    roots.current = projectB;
    await client.sendRootsListChanged();
    const seen = await eventually(() => whoami(client), (cwd) => cwd === resolve(projectB));
    expect(seen).toBe(resolve(projectB));
  });

  it('keeps overlapping requests of one session in their own directories', async () => {
    const init = await fetch(`http://127.0.0.1:${open.port}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, [CWD_HEADER]: projectA },
      body: JSON.stringify(INITIALIZE),
    });
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await init.text();
    const post = (cwd: string, id: number) => fetch(`http://127.0.0.1:${open.port}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'Mcp-Session-Id': sessionId!, [CWD_HEADER]: cwd },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
    }).then(async (res) => parseRpc(await res.text()).result.content[0].text as string);

    // The second request arrives while the first is still being handled.
    const [first, second] = await Promise.all([post(projectA, 2), sleep(10).then(() => post(projectB, 3))]);
    expect(first).toBe(resolve(projectA));
    expect(second).toBe(resolve(projectB));
  });

  it('rejects an X-Claude-Mem-Cwd that is relative or does not exist, instead of falling back', async () => {
    for (const cwd of ['relative/dir', join(temp, 'nonexistent'), '']) {
      const res = await raw(open, { headers: { [CWD_HEADER]: cwd }, body: INITIALIZE });
      expect(res.status).toBe(400);
      expect(res.body).toContain(CWD_HEADER);
    }

    const init = await fetch(`http://127.0.0.1:${open.port}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, [CWD_HEADER]: projectA },
      body: JSON.stringify(INITIALIZE),
    });
    const sessionId = init.headers.get('mcp-session-id')!;
    await init.text();
    const inSession = await raw(open, {
      headers: { 'Mcp-Session-Id': sessionId, [CWD_HEADER]: 'relative/dir' },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
    });
    expect(inSession.status).toBe(400);
  });

  it('answers /health without revealing the session count, and 404s other paths', async () => {
    const health = await fetch(`http://127.0.0.1:${open.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
    expect((await fetch(`http://127.0.0.1:${open.port}/nope`)).status).toBe(404);
  });

  it('rejects a foreign Host header (DNS rebinding) on /mcp and /health', async () => {
    expect((await raw(open, { headers: { Host: 'evil.example' }, body: INITIALIZE })).status).toBe(403);
    expect((await raw(open, { headers: { Host: `evil.example:${open.port}` }, body: INITIALIZE })).status).toBe(403);
    expect((await raw(open, { path: '/health', method: 'GET', headers: { Host: 'evil.example' } })).status).toBe(403);
    expect((await raw(open, { headers: { Host: `localhost:${open.port}` }, body: INITIALIZE })).status).toBe(200);
  });

  it('rejects a browser Origin other than an allowlisted one, on /mcp and /health', async () => {
    for (const origin of ['http://evil.example', 'http://localhost:3000', 'null']) {
      const res = await raw(open, { headers: { Origin: origin }, body: INITIALIZE });
      expect(res.status).toBe(403);
      expect(res.body).toContain('Origin');
      expect((await raw(open, { path: '/health', method: 'GET', headers: { Origin: origin } })).status).toBe(403);
    }
    expect((await raw(open, { headers: { Origin: ALLOWED_ORIGIN }, body: INITIALIZE })).status).toBe(200);
    // Local clients (Claude Code, opencode, curl) send no Origin at all.
    expect((await raw(open, { body: INITIALIZE })).status).toBe(200);
  });

  it('rejects a session id it does not know', async () => {
    const res = await fetch(`http://127.0.0.1:${open.port}/mcp`, {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'Mcp-Session-Id': 'nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
  });

  it('answers an oversized body with 413 instead of dropping the connection', async () => {
    const res = await raw(open, { body: 'x'.repeat(5 * 1024 * 1024 + 1) });
    expect(res.status).toBe(413);
    expect(parseRpc(res.body).error.message).toContain('too large');
  });

  it('answers malformed JSON with 400 and a JSON-RPC parse error', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
      const req = request(
        { host: '127.0.0.1', port: open.port, path: '/mcp', method: 'POST', headers: JSON_HEADERS },
        (r) => {
          let body = '';
          r.setEncoding('utf8');
          r.on('data', (chunk) => { body += chunk; });
          r.on('end', () => resolveResponse({ status: r.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end('{not json');
    });
    expect(res.status).toBe(400);
    expect(parseRpc(res.body).error.code).toBe(-32700);
  });

  it('refuses a new session with a clear 503 once the session cap is reached', async () => {
    expect((await raw(capped, { body: INITIALIZE })).status).toBe(200);
    expect((await raw(capped, { body: INITIALIZE })).status).toBe(200);
    expect(capped.sessionCount()).toBe(2);
    const refused = await raw(capped, { body: INITIALIZE });
    expect(refused.status).toBe(503);
    expect(refused.body).toContain('session limit');
    expect(capped.sessionCount()).toBe(2);
  });

  it('refuses to listen on anything but loopback', async () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.20']) {
      await expect(startMcpHttpServer({ host, port: 0, originPolicy, createServer: createFakeServer }))
        .rejects.toThrow('loopback only');
    }
  });
});
