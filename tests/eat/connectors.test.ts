import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';

// Snapshot the real module BEFORE mock.module mutates the live namespace, then
// re-register it in afterAll. bun's mock.module is process-global and
// mock.restore() does NOT undo it, so this client stub would otherwise leak
// into other test files in the same `bun test` run.
import * as realMcp from '@ai-sdk/mcp';
const realMcpSnapshot = { ...realMcp };

const createCalls: Array<Record<string, unknown>> = [];
let listResourcesCalls = 0;
const readResourceCalls: string[] = [];
let closeCalls = 0;
let listedResources: Array<{ uri: string; name: string }> = [];
let contentsByUri: Record<string, Array<Record<string, unknown>>> = {};
let listResourcesError: Error | null = null;
let readResourceErrorsByUri: Record<string, Error> = {};

mock.module('@ai-sdk/mcp', () => ({
  createMCPClient: async (config: Record<string, unknown>) => {
    createCalls.push(config);
    return {
      listResources: async () => {
        listResourcesCalls++;
        if (listResourcesError !== null) throw listResourcesError;
        return { resources: listedResources };
      },
      readResource: async ({ uri }: { uri: string }) => {
        readResourceCalls.push(uri);
        const readError = readResourceErrorsByUri[uri];
        if (readError !== undefined) throw readError;
        return { contents: contentsByUri[uri] ?? [] };
      },
      close: async () => {
        closeCalls++;
      },
    };
  },
}));

afterAll(() => {
  mock.module('@ai-sdk/mcp', () => realMcpSnapshot);
});

import { extractFromMcp } from '../../src/services/worker/eat/connectors.js';
import type { EatError } from '../../src/services/worker/eat/errors.js';

const SERVER_URL = 'https://mcp.example.com/mcp';

describe('extractFromMcp', () => {
  beforeEach(() => {
    createCalls.length = 0;
    listResourcesCalls = 0;
    readResourceCalls.length = 0;
    closeCalls = 0;
    listedResources = [];
    contentsByUri = {};
    listResourcesError = null;
    readResourceErrorsByUri = {};
  });

  it('reads a single declared resource without listing', async () => {
    contentsByUri['doc://readme'] = [
      { uri: 'doc://readme', mimeType: 'text/markdown', text: '# Readme' },
    ];

    const extraction = await extractFromMcp(SERVER_URL, { resource: 'doc://readme' });

    expect(listResourcesCalls).toBe(0);
    expect(readResourceCalls).toEqual(['doc://readme']);
    expect(extraction.items).toEqual([
      {
        text: '# Readme',
        source: { kind: 'mcp', locator: `${SERVER_URL}#doc://readme`, contentType: 'text/markdown' },
      },
    ]);
    expect(extraction.rejects).toEqual([]);
    expect(closeCalls).toBe(1);
  });

  it('lists then reads every resource when none is declared', async () => {
    listedResources = [
      { uri: 'doc://one', name: 'one' },
      { uri: 'doc://two', name: 'two' },
    ];
    contentsByUri['doc://one'] = [{ uri: 'doc://one', text: 'first' }];
    contentsByUri['doc://two'] = [{ uri: 'doc://two', text: 'second' }];

    const extraction = await extractFromMcp(SERVER_URL);

    expect(listResourcesCalls).toBe(1);
    expect(readResourceCalls).toEqual(['doc://one', 'doc://two']);
    expect(extraction.items.map(item => item.text)).toEqual(['first', 'second']);
    expect(extraction.items[0].source).toEqual({ kind: 'mcp', locator: `${SERVER_URL}#doc://one` });
    expect(extraction.rejects).toEqual([]);
    expect(closeCalls).toBe(1);
  });

  it('rejects blob contents with a reason and keeps going', async () => {
    listedResources = [{ uri: 'doc://mixed', name: 'mixed' }];
    contentsByUri['doc://mixed'] = [
      { uri: 'doc://mixed', mimeType: 'image/png', blob: 'aGVsbG8=' },
      { uri: 'doc://mixed', text: 'kept' },
    ];

    const extraction = await extractFromMcp(SERVER_URL);

    expect(extraction.items.map(item => item.text)).toEqual(['kept']);
    expect(extraction.rejects).toEqual([
      { source: { kind: 'mcp', locator: `${SERVER_URL}#doc://mixed` }, reason: 'Non-text resource content (image/png)' },
    ]);
    expect(closeCalls).toBe(1);
  });

  it('rejects a resource whose read throws and continues with the rest', async () => {
    listedResources = [
      { uri: 'doc://broken', name: 'broken' },
      { uri: 'doc://good', name: 'good' },
    ];
    readResourceErrorsByUri['doc://broken'] = new Error('resource gone');
    contentsByUri['doc://good'] = [{ uri: 'doc://good', text: 'still here' }];

    const extraction = await extractFromMcp(SERVER_URL);

    expect(extraction.items.map(item => item.text)).toEqual(['still here']);
    expect(extraction.rejects).toEqual([
      { source: { kind: 'mcp', locator: `${SERVER_URL}#doc://broken` }, reason: 'MCP readResource failed: resource gone' },
    ]);
    expect(closeCalls).toBe(1);
  });

  it('still closes the client when listResources throws, and maps to upstream_fetch_failed', async () => {
    listResourcesError = new Error('server exploded');

    expect.assertions(3);
    try {
      await extractFromMcp(SERVER_URL);
    } catch (error) {
      expect((error as EatError).name).toBe('EatError');
      expect((error as EatError).code).toBe('upstream_fetch_failed');
    }
    expect(closeCalls).toBe(1);
  });

  it('passes the url and headers into the http transport', async () => {
    const headers = { Authorization: 'Bearer token' };
    await extractFromMcp(SERVER_URL, { resource: 'doc://readme', headers });

    expect(createCalls).toEqual([
      { transport: { type: 'http', url: SERVER_URL, headers } },
    ]);
  });
});
