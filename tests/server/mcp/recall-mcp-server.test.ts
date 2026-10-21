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
  timeline: Array<{ projectId: string; anchorId: string; depthBefore: number; depthAfter: number }>;
  selected: Array<{ projectId: string; ids: string[] }>;
}

function makeBackend(overrides: Partial<RecallBackend> = {}): { backend: RecallBackend; calls: Recorded } {
  const calls: Recorded = { search: [], context: [], recent: [], timeline: [], selected: [] };
  const observations = [
    { id: 'o1', metadata: { title: 'First decision' }, content: 'alpha context '.repeat(40) + 'ALPHA_FULL_DETAIL', teamId: 'private-team' },
    { id: 'o2', metadata: { title: 'Second decision' }, content: 'beta context '.repeat(40) + 'BETA_FULL_DETAIL' },
  ];
  const backend: RecallBackend = {
    search: async (args) => {
      calls.search.push(args);
      return observations;
    },
    timeline: async args => { calls.timeline.push(args); return observations; },
    getObservations: async args => { calls.selected.push(args); return observations.filter(row => args.ids.includes(row.id)); },
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
    expect(tools.map((t) => t.name).sort()).toEqual(['context', 'get_observations', 'recent', 'search', 'timeline']);
    expect(tools.every(tool => tool.annotations?.readOnlyHint)).toBe(true);
    expect(tools.every(tool => !Object.hasOwn(tool.inputSchema.properties ?? {}, 'mode'))).toBe(true);
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
    expect(textOf(res)).toContain('First decision');
    expect(textOf(res)).not.toContain('ALPHA_FULL_DETAIL');
    expect(textOf(res)).not.toContain('private-team');
    expect(textOf(res)).toContain('timeline({projectId, anchorId})');
    expect(textOf(res)).not.toContain('timeline(anchor=');
    await client.close();
  });

  it('context routes through backend.context and packs a joined string', async () => {
    const { backend, calls } = makeBackend();
    const client = await connectClient(backend);
    const res = await client.callTool({ name: 'context', arguments: { projectId: 'p1', query: 'hi' } });
    expect(calls.context).toHaveLength(1);
    expect(calls.search).toHaveLength(0);
    expect(textOf(res)).toContain('ALPHA_FULL_DETAIL\n\nbeta context');
    await client.close();
  });

  it('recent calls the recent backend with the default limit', async () => {
    const { backend, calls } = makeBackend();
    const client = await connectClient(backend);
    await client.callTool({ name: 'recent', arguments: { projectId: 'p2' } });
    expect(calls.recent[0]).toEqual({ projectId: 'p2', limit: 20 });
    await client.close();
  });

  it('Smart reads compact anchored context before selected details', async () => {
    const { backend, calls } = makeBackend();
    const client = await connectClient(backend);
    const context = await client.callTool({ name: 'timeline', arguments: { projectId: 'p1', anchorId: 'o1' } });
    expect(calls.timeline).toEqual([{ projectId: 'p1', anchorId: 'o1', depthBefore: 3, depthAfter: 3 }]);
    expect(calls.selected).toEqual([]);
    expect(textOf(context)).toContain('First decision');
    expect(textOf(context)).not.toContain('ALPHA_FULL_DETAIL');
    expect(textOf(context)).toContain('get_observations({projectId, ids})');
    const detail = await client.callTool({ name: 'get_observations', arguments: { projectId: 'p1', ids: ['o2', 'o2'] } });
    expect(calls.selected).toEqual([{ projectId: 'p1', ids: ['o2'] }]);
    expect(textOf(detail)).toContain('BETA_FULL_DETAIL');
    expect(textOf(detail)).not.toContain('ALPHA_FULL_DETAIL');
    expect(detail.structuredContent).toBeUndefined();
    await client.close();
  });

  it('rejects malformed stages and obsolete modes before calling storage', async () => {
    const { backend, calls } = makeBackend();
    const client = await connectClient(backend);
    for (const [name, args] of [
      ['timeline', { projectId: 'p1', anchorId: 'o1', depthBefore: -1 }],
      ['timeline', { projectId: 'p1' }],
      ['get_observations', { projectId: 'p1', ids: [] }],
      ['get_observations', { projectId: 'p1', ids: [42] }],
      ['search', { projectId: 'p1', query: 'memory', mode: 'auto' }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
    }
    expect(calls.timeline).toEqual([]);
    expect(calls.selected).toEqual([]);
    expect(calls.search).toEqual([]);
    await client.close();
  });

  it('does not expose storage errors as memory-tool text', async () => {
    const client = await connectClient(makeBackend({ timeline: async () => { throw new Error('PRIVATE_SQL_AND_CREDENTIAL'); } }).backend);
    const result = await client.callTool({ name: 'timeline', arguments: { projectId: 'p1', anchorId: 'o1' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('PRIVATE');
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
