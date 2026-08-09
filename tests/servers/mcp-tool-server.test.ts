import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpToolServer } from '../../src/servers/mcp-tool-server.js';

describe('createMcpToolServer', () => {
  it('returns readOnlyHint annotations from the registered ListTools handler', async () => {
    const server = createMcpToolServer([
      {
        name: 'read_memory',
        description: 'Read memory without changing it.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      },
    ], '0.0.0-test');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0' }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();

    expect(tools).toContainEqual(expect.objectContaining({
      name: 'read_memory',
      annotations: { readOnlyHint: true },
    }));

    await client.close();
  });
});
