import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

// claude-mem's MCP tools over Streamable HTTP at the gateway's /mcp (plan
// Phase 12 task 3): stateless, JSON answers, the same table as the stdio
// server. Driven with plain fetch, as an HTTP MCP client would.

let gateway: StartedWireGateway;

beforeAll(async () => {
  gateway = await startWireGatewayForTest();
});

afterAll(async () => {
  await gateway.stop();
});

const MCP_ACCEPT = 'application/json, text/event-stream';
const PROTOCOL_VERSION = '2025-06-18';

async function rpc(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${gateway.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: MCP_ACCEPT, 'mcp-protocol-version': PROTOCOL_VERSION, ...headers },
    body: JSON.stringify(body),
  });
}

describe('MCP over HTTP at /mcp', () => {
  it('initialize answers with claude-mem and its tools capability, as JSON, with no session', async () => {
    const response = await rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'wire-test', version: '0' } },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const answer = await response.json() as any;
    expect(answer.id).toBe(1);
    expect(answer.result.serverInfo.name).toBe('claude-mem');
    expect(answer.result.capabilities.tools).toBeDefined();
  });

  it('tools/list answers the same table the stdio server advertises', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(response.status).toBe(200);
    const answer = await response.json() as any;
    const names: string[] = answer.result.tools.map((tool: any) => tool.name);
    for (const expected of ['search', 'timeline', 'get_observations', 'important_workflow', 'dumb_search']) expect(names).toContain(expected);
    const search = answer.result.tools.find((tool: any) => tool.name === 'search');
    expect(search.inputSchema.type).toBe('object');
    expect(search.annotations.readOnlyHint).toBe(true);
  });

  it('tools/call runs a tool and returns its content', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'important_workflow', arguments: {} } });
    expect(response.status).toBe(200);
    const answer = await response.json() as any;
    expect(answer.id).toBe(3);
    expect(answer.result.content[0].type).toBe('text');
    expect(answer.result.content[0].text).toContain('Smart Search');
  });

  it('an unknown tool is a JSON-RPC error, not a crash', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
    const answer = await response.json() as any;
    expect(answer.id).toBe(4);
    expect(JSON.stringify(answer)).toContain('Unknown tool');
  });

  it('a POST whose Accept lacks text/event-stream gets 406', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, { accept: 'application/json' });
    expect(response.status).toBe(406);
  });

  it('a body that is not JSON gets 415 by its content type', async () => {
    const response = await fetch(`${gateway.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', accept: MCP_ACCEPT },
      body: 'hello',
    });
    expect(response.status).toBe(415);
  });

  it('GET has no stream to open on a stateless server: 405', async () => {
    const response = await fetch(`${gateway.baseUrl}/mcp`, { headers: { accept: 'text/event-stream' } });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });
});
