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
import { CWD_HEADER, startMcpHttpServer, type McpHttpHandle } from '../../src/servers/mcp-http.js';
import { getRequestCwd, runWithCwd } from '../../src/servers/request-context.js';

const temp = mkdtempSync(join(tmpdir(), 'cm-http-'));
const projectA = join(temp, 'project-a');
const projectB = join(temp, 'project-b');
mkdirSync(projectA);
mkdirSync(projectB);

/** A stand-in for the claude-mem Server: one tool that reports the cwd the handler sees. */
function createFakeServer(getCwd: () => string): Server {
  const server = new Server({ name: 'fake', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'whoami', description: 'cwd of the call', inputSchema: { type: 'object' as const } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: 'text' as const, text: await runWithCwd(getCwd(), async () => getRequestCwd()) }],
  }));
  return server;
}

let open: McpHttpHandle;
let secured: McpHttpHandle;
const clients: Client[] = [];

beforeAll(async () => {
  open = await startMcpHttpServer({ host: '127.0.0.1', port: 0, createServer: createFakeServer });
  secured = await startMcpHttpServer({ host: '127.0.0.1', port: 0, token: 's3cret', createServer: createFakeServer });
});

afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  await open.close();
  await secured.close();
  rmSync(temp, { recursive: true, force: true });
});

async function connect(
  handle: McpHttpHandle,
  headers: Record<string, string>,
  roots?: string,
): Promise<Client> {
  const client = new Client({ name: 't', version: '0' }, { capabilities: roots ? { roots: {} } : {} });
  if (roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(roots).href }] }));
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
    await new Promise((r) => setTimeout(r, 100));
    value = await read();
  }
  return value;
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
    const client = await connect(open, {}, projectB);
    const seen = await eventually(() => whoami(client), (cwd) => cwd === resolve(projectB));
    expect(seen).toBe(resolve(projectB));
  });

  it('prefers the header over roots', async () => {
    const client = await connect(open, { [CWD_HEADER]: projectA }, projectB);
    await new Promise((r) => setTimeout(r, 300));
    expect(await whoami(client)).toBe(resolve(projectA));
  });

  it('answers /health and 404s other paths', async () => {
    const health = await fetch(`http://127.0.0.1:${open.port}/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).status).toBe('ok');
    expect((await fetch(`http://127.0.0.1:${open.port}/nope`)).status).toBe(404);
  });

  it('requires the bearer token when one is configured', async () => {
    const denied = await fetch(`http://127.0.0.1:${secured.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: '{}',
    });
    expect(denied.status).toBe(401);
    const client = await connect(secured, { Authorization: 'Bearer s3cret', [CWD_HEADER]: projectA });
    expect(await whoami(client)).toBe(resolve(projectA));
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const status = await new Promise<number>((resolveStatus, reject) => {
      const req = request(
        { host: '127.0.0.1', port: open.port, path: '/mcp', method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } },
        (res) => { res.resume(); resolveStatus(res.statusCode ?? 0); },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }));
    });
    expect(status).toBe(403);
  });

  it('rejects a session id it does not know', async () => {
    const res = await fetch(`http://127.0.0.1:${open.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': 'nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
  });
});
