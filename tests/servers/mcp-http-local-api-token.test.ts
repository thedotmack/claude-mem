// Local API token mode (#5141) on the MCP HTTP transport.
//
// With an local API token set, every /mcp request must carry it, so the working-directory
// header, a session id and the body are never read from a request that does not.
// `/health` stays open. With no token nothing changes.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CWD_HEADER, startMcpHttpServer, type CwdResolver, type McpHttpHandle } from '../../src/servers/mcp-http.js';
import { getRequestCwd, runWithCwd } from '../../src/servers/request-context.js';
import { LOCAL_API_TOKEN_HEADER } from '../../src/shared/local-api-token.js';
import type { WorkerOriginPolicy } from '../../src/services/worker/http/origin-policy.js';

const TOKEN = 'mcp-owner-test-secret';
const WRONG = 'mcp-owner-wrong-secret';

const temp = mkdtempSync(join(tmpdir(), 'cm-http-owner-'));
const project = join(temp, 'project-a');
mkdirSync(project);

function createFakeServer(resolveCwd: CwdResolver): Server {
  const server = new Server({ name: 'fake', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'whoami', description: 'cwd of the call', inputSchema: { type: 'object' as const } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
    const cwd = resolveCwd(extra);
    return { content: [{ type: 'text' as const, text: await runWithCwd(cwd, async () => getRequestCwd()) }] };
  });
  return server;
}

const originPolicy: WorkerOriginPolicy = { allowedOrigins: [], workerHost: '' };

let guarded: McpHttpHandle;
let open: McpHttpHandle;
const clients: Client[] = [];

beforeAll(async () => {
  guarded = await startMcpHttpServer({ host: '127.0.0.1', port: 0, originPolicy, localApiToken: TOKEN, createServer: createFakeServer });
  open = await startMcpHttpServer({ host: '127.0.0.1', port: 0, originPolicy, createServer: createFakeServer });
});

afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  await guarded.close();
  await open.close();
  rmSync(temp, { recursive: true, force: true });
});

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const INITIALIZE = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
};

function post(handle: McpHttpHandle, headers: Record<string, string> = {}, body: unknown = INITIALIZE): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle.port}/mcp`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
}

async function connect(headers: Record<string, string>): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${guarded.port}/mcp`), { requestInit: { headers } });
  clients.push(client);
  await client.connect(transport);
  return { client, transport };
}

describe('MCP HTTP local API token: no token set', () => {
  it('changes nothing: initialize with no token succeeds', async () => {
    const res = await post(open);
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });
});

describe('MCP HTTP local API token: token set', () => {
  it('refuses initialize with no token, and creates no session', async () => {
    const before = guarded.sessionCount();
    const res = await post(guarded);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('local API token');
    expect(guarded.sessionCount()).toBe(before);
  });

  it('refuses a wrong token', async () => {
    expect((await post(guarded, { [LOCAL_API_TOKEN_HEADER]: WRONG })).status).toBe(401);
    expect((await post(guarded, { authorization: `Bearer ${WRONG}` })).status).toBe(401);
  });

  it('admits X-Claude-Mem-Token and Authorization: Bearer', async () => {
    const viaHeader = await post(guarded, { [LOCAL_API_TOKEN_HEADER]: TOKEN });
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.headers.get('mcp-session-id')).toBeTruthy();
    const viaBearer = await post(guarded, { authorization: `Bearer ${TOKEN}` });
    expect(viaBearer.status).toBe(200);
  });

  it('does not honor the working-directory header on a request without the token', async () => {
    const before = guarded.sessionCount();
    const valid = await post(guarded, { [CWD_HEADER]: project });
    expect(valid.status).toBe(401);
    // Refused for the token, not for the header: an unusable path gets the same answer.
    const unusable = await post(guarded, { [CWD_HEADER]: 'relative/path' });
    expect(unusable.status).toBe(401);
    expect(guarded.sessionCount()).toBe(before);
  });

  it('still validates the working-directory header once the token is present', async () => {
    const res = await post(guarded, { [LOCAL_API_TOKEN_HEADER]: TOKEN, [CWD_HEADER]: 'relative/path' });
    expect(res.status).toBe(400);
  });

  it('honors the working-directory header on a request that carries the token', async () => {
    const { client } = await connect({ [LOCAL_API_TOKEN_HEADER]: TOKEN, [CWD_HEADER]: project });
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect((result.content as Array<{ text: string }>)[0].text.endsWith('project-a')).toBe(true);
  });

  it('a session id alone is not a credential', async () => {
    const { transport } = await connect({ [LOCAL_API_TOKEN_HEADER]: TOKEN });
    const sessionId = transport.sessionId;
    expect(sessionId).toBeTruthy();
    const tools = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
    const without = await post(guarded, { 'mcp-session-id': sessionId! }, tools);
    expect(without.status).toBe(401);
    const del = await fetch(`http://127.0.0.1:${guarded.port}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sessionId! } });
    expect(del.status).toBe(401);
  });

  it('a client with no token cannot connect', async () => {
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${guarded.port}/mcp`));
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('leaves /health open', async () => {
    const res = await fetch(`http://127.0.0.1:${guarded.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
