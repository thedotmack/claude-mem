// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for the remote-recall MCP server factory. The factory is pure
// (storage is injected as a RecallBackend), so these run with no Postgres —
// they drive a real MCP Client over an in-memory transport, exactly how a
// hosted client would, and assert tool listing, arg forwarding/clamping,
// context packing, and that backend failures surface as tool errors (not
// transport throws).

import { describe, it, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRecallMcpServer, type RecallBackend } from '../../../src/server/mcp/recall-mcp-server.js';

interface Recorded {
  search: Array<{ projectId: string; query: string; limit: number }>;
  context: Array<{ projectId: string; query: string; limit: number }>;
  recent: Array<{ projectId: string; limit: number }>;
}

function makeBackend(overrides: Partial<RecallBackend> = {}): { backend: RecallBackend; calls: Recorded } {
  const calls: Recorded = { search: [], context: [], recent: [] };
  const observations = [
    { id: 'o1', content: 'alpha' },
    { id: 'o2', content: 'beta' },
  ];
  const backend: RecallBackend = {
    search: async (args) => {
      calls.search.push(args);
      return observations;
    },
    context: async (args) => {
      calls.context.push(args);
      return observations;
    },
    recent: async (args) => {
      calls.recent.push(args);
      return [{ id: 'r1', content: 'recent-one' }];
    },
    ...overrides,
  };
  return { backend, calls };
}

async function connectClient(backend: RecallBackend): Promise<Client> {
  const server = createRecallMcpServer(backend, '9.9.9');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: { content: unknown }): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return first?.text ?? '';
}

describe('createRecallMcpServer', () => {
  it('lists exactly the read-only recall tools', async () => {
    const client = await connectClient(makeBackend().backend);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['context', 'recent', 'search']);
    await client.close();
  });

  it('search forwards args, clamps the limit, and returns observations', async () => {
    const { backend, calls } = makeBackend();
    const client = await connectClient(backend);
    const res = await client.callTool({
      name: 'search',
      arguments: { projectId: 'p1', query: 'hello', limit: 9999 },
    });
    expect(calls.search[0]).toEqual({ projectId: 'p1', query: 'hello', limit: 100 });
    expect(JSON.parse(textOf(res)).observations).toHaveLength(2);
    await client.close();
  });

  it('context routes through backend.context and packs a joined string', async () => {
    const { backend, calls } = makeBackend();
    const client = await connectClient(backend);
    const res = await client.callTool({ name: 'context', arguments: { projectId: 'p1', query: 'hi' } });
    expect(calls.context).toHaveLength(1);
    expect(calls.search).toHaveLength(0);
    expect(JSON.parse(textOf(res)).context).toBe('alpha\n\nbeta');
    await client.close();
  });

  it('recent calls the recent backend with the default limit', async () => {
    const { backend, calls } = makeBackend();
    const client = await connectClient(backend);
    await client.callTool({ name: 'recent', arguments: { projectId: 'p2' } });
    expect(calls.recent[0]).toEqual({ projectId: 'p2', limit: 20 });
    await client.close();
  });

  it('a missing required arg is a tool error, not a transport throw', async () => {
    const client = await connectClient(makeBackend().backend);
    const res = await client.callTool({ name: 'search', arguments: { projectId: 'p1' } });
    expect(res.isError).toBe(true);
    await client.close();
  });

  it('a backend project-scope rejection surfaces as a tool error', async () => {
    const { backend } = makeBackend({
      search: async () => {
        throw new Error('API key is scoped to a different project');
      },
    });
    const client = await connectClient(backend);
    const res = await client.callTool({ name: 'search', arguments: { projectId: 'other', query: 'x' } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('different project');
    await client.close();
  });

  it('an unknown tool is a tool error', async () => {
    const client = await connectClient(makeBackend().backend);
    const res = await client.callTool({ name: 'nope', arguments: {} });
    expect(res.isError).toBe(true);
    await client.close();
  });
});
