import { afterAll, beforeAll, describe, it, expect } from 'bun:test';
import express from 'express';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { formatDeepSearch } from '../../src/shared/deep-search-format.js';
import type { DeepSearchResult } from '../../src/services/sqlite/tool-use-search.js';
import { expectSafeMcpToolNames } from './mcp-tool-name-assertions.js';
import { WORK_STATE_WRITE_ARGS_ERROR } from '../../src/shared/work-state-batch.js';

const mcpServerPath = fileURLToPath(new URL('../../src/servers/mcp-server.ts', import.meta.url));

type ListedTool = { name: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } };

/** tools/list and a work_state round trip from the real stdio server, against a stub worker. */
async function withServer(
  runtime: 'worker' | 'server',
  run: (client: Client, workerRequests: Array<{ path: string; body: any; query: any }>, cwd: string) => Promise<void>,
  autostart = false,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const workerRequests: Array<{ path: string; body: any; query: any }> = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { workerRequests.push({ path: req.path, body: req.body, query: req.query }); next(); });
  app.get('/api/search', (req, res) => {
    const result = {observations: [], sessions: [], prompts: [], totalResults: 0,
      deep: {status: 'ok', complete: true, count: 1, hasMore: false},
      toolUses: [{id: 41, tool_name: 'Bash', project: 'test', snippet: 'DB_CONN_1042'}]};
    res.json(req.query.format === 'json' ? result : {...result, content: [
      {type:'text', text:'#S1 ' + 'Matching summary 🧪 '.repeat(5000)},
      {type:'text', text:formatDeepSearch(result as DeepSearchResult)},
    ]});
  });
  app.post('/api/tool-uses/batch', (_req, res) => res.json([]));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.post('/api/work-state/entries', (req, res) => {
    if (req.body?.fields?.task === 'fail') { res.status(400).json({ error: 'Worker refused item: fail' }); return; }
    res.json({ entries: [] });
  });
  app.get('/api/work-state', (_req, res) => res.json({ entries: [] }));
  const deckUrl = 'http://localhost/?view=review-stack';
  app.get('/api/work-view/review-stack', (_req, res) => res.json({ itemCount: 1, deckUrl }));
  app.post('/api/work-view/review-stack/import', (req, res) => {
    if (!req.get('Idempotency-Key')) { res.status(400).end(); return; }
    res.json({ added: 1, existing: 0, firstId: 'weekly-test', deckUrl });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  // realpath: macOS reports the child's process.cwd() under /private/var.
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-mem-tool-schemas-')));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerPath],
    cwd: dataDir,
    stderr: 'pipe',
    env: {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_MEM_WORKER_PORT: String(port),
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_WORKER_AUTOSTART: String(autostart),
      CLAUDE_MEM_LOG_LEVEL: 'INFO',
      CLAUDE_MEM_WORK_STATE_ENABLED: 'true',
      CLAUDE_MEM_RUNTIME: runtime,
      CLAUDE_MEM_SERVER_URL: `http://127.0.0.1:${port}`,
      CLAUDE_MEM_SERVER_API_KEY: 'schema-fixture-key',
      ...extraEnv,
    } as Record<string, string>,
  });
  const client = new Client({ name: 'tool-schema-fixture', version: '1' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    await run(client, workerRequests, dataDir);
  } finally {
    await client.close();
    await transport.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('MCP tool inputSchema declarations', () => {
  let tools: Map<string, ListedTool>;

  beforeAll(async () => {
    await withServer('server', async client => {
      tools = new Map((await client.listTools()).tools.map(tool => [tool.name, tool as ListedTool]));
    });
  }, 30_000);

  it('advertises MCP-safe tool names within the qualified-name budget', () => {
    expectSafeMcpToolNames(tools.values());
  });

  const properties = (name: string) => Object.keys(tools.get(name)?.inputSchema.properties ?? {});
  const required = (name: string) => tools.get(name)?.inputSchema.required ?? [];

  it.each([
    ['search', ['query', 'limit', 'project', 'orderBy']],
    ['timeline', ['anchor', 'query', 'depth_before', 'depth_after', 'project']],
    ['get_observations', ['ids']],
    ['session_start_context', ['project', 'projects', 'platformSource', 'full', 'colors']],
    ['observation_add', ['content']],
    ['observation_record_event', ['eventType', 'platformSource']],
    ['observation_search', ['query', 'platformSource', 'limit']],
    ['observation_context', ['query', 'platformSource']],
    ['observation_generation_status', ['jobId']],
  ])('%s declares its parameters', (name, expected) => {
    expect(properties(name)).toEqual(expect.arrayContaining(expected));
  });

  it.each([
    ['get_observations', ['ids']],
    ['work_state_write', ['list', 'fields']],
    ['observation_add', ['content']],
    ['observation_record_event', ['eventType']],
    ['observation_search', ['query']],
    ['observation_generation_status', ['jobId']],
  ])('%s requires %p', (name, expected) => {
    expect(required(name)).toEqual(expected);
  });

  it('observation_context requires nothing, so an omitted query asks for recent context (#2991)', () => {
    expect(tools.has('observation_context')).toBe(true);
    expect(required('observation_context')).toEqual([]);
  });
});

describe('work_state tools', () => {
  it('send the session cwd to the work-state routes', async () => {
    await withServer('worker', async (client, workerRequests, cwd) => {
      await client.callTool({ name: 'work_state_write', arguments: { list: 'schema-fixture', fields: { task: 'Check cwd' } } });
      await client.callTool({ name: 'work_state_read', arguments: { list: 'schema-fixture' } });
      const write = workerRequests.find(request => request.path === '/api/work-state/entries');
      const read = workerRequests.find(request => request.path === '/api/work-state');
      expect(write?.body.cwd).toBe(cwd);
      expect(read?.query.cwd).toBe(cwd);
    });
  }, 30_000);
});

describe('work_state_write grouped writes (opt-in)', () => {
  // The server runs as a child process: the flag must travel in the transport env.
  const enabled = { CLAUDE_MEM_WORK_STATE_BATCH_ENABLED: 'true' };
  const textOf = (result: unknown) => (result as { content: Array<{ text: string }> }).content.map(block => block.text).join('\n');
  const writes = (requests: Array<{ path: string }>) => requests.filter(request => request.path === '/api/work-state/entries');

  it('advertises items and requires only list when the flag is on', async () => {
    await withServer('server', async client => {
      const tool = (await client.listTools()).tools.find(candidate => candidate.name === 'work_state_write') as ListedTool;
      expect(tool.inputSchema.required).toEqual(['list']);
      const properties = tool.inputSchema.properties as Record<string, any>;
      expect(properties.items.type).toBe('array');
      expect(properties.items.minItems).toBe(1);
      expect(properties.items.maxItems).toBe(25);
      expect(properties.items.items.type).toBe('object');
      expect(properties.items.items.additionalProperties.type).toEqual(['string', 'number', 'boolean', 'null']);
      expect(tool.description).toContain('Call once per entry, or pass `items` to append several entries in one call.');
      expect(tool.description).toContain('`fields` is an object of scalar keys, not an array. Supply exactly one of `fields` or `items`.');
    }, false, enabled);
  }, 30_000);

  it('writes both entries through the real stdio handler', async () => {
    await withServer('worker', async (client, requests) => {
      const result = await client.callTool({
        name: 'work_state_write',
        arguments: { list: 'schema-fixture', items: [{ task: 'a', status: 'todo' }, { task: 'b', status: 'todo' }] },
      });
      expect(result.isError).toBeFalsy();
      const posted = writes(requests);
      expect(posted).toHaveLength(2);
      expect(posted.map(request => request.body.fields.task)).toEqual(['a', 'b']);
      expect(posted.every(request => request.body.list === 'schema-fixture')).toBe(true);
    }, false, enabled);
  }, 30_000);

  it('returns the handler error in the same turn for {list} alone, with no POST', async () => {
    await withServer('worker', async (client, requests) => {
      const result = await client.callTool({ name: 'work_state_write', arguments: { list: 'schema-fixture' } });
      expect(result.isError).toBe(true);
      expect(textOf(result).trim()).toBe(WORK_STATE_WRITE_ARGS_ERROR);
      expect(writes(requests)).toEqual([]);
    }, false, enabled);
  }, 30_000);

  it('refuses an unsafe integer and a reserved list before any POST', async () => {
    await withServer('worker', async (client, requests) => {
      const unsafe = await client.callTool({
        name: 'work_state_write',
        arguments: { list: 'schema-fixture', items: [{ task: 'ok' }, { status: 9007199254740993 }] },
      });
      const reserved = await client.callTool({
        name: 'work_state_write',
        arguments: { list: '__my_work_v1:entry', items: [{ task: 'ok' }] },
      });
      expect(unsafe.isError).toBe(true);
      expect(reserved.isError).toBe(true);
      expect(textOf(unsafe).trim()).toBe(WORK_STATE_WRITE_ARGS_ERROR);
      expect(textOf(reserved).trim()).toBe(WORK_STATE_WRITE_ARGS_ERROR);
      expect(writes(requests)).toEqual([]);
    }, false, enabled);
  }, 30_000);

  it('names the failing index and relays the raw worker error without rollback', async () => {
    await withServer('worker', async (client, requests) => {
      const result = await client.callTool({
        name: 'work_state_write',
        arguments: { list: 'schema-fixture', items: [{ task: 'a' }, { task: 'fail' }, { task: 'never' }] },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('failed at item 2/3');
      expect(textOf(result)).toContain('Earlier entries (1) are already saved');
      expect(textOf(result)).toContain('Worker refused item: fail');
      const posted = writes(requests);
      expect(posted.map(request => request.body.fields.task)).toEqual(['a', 'fail']);
    }, false, enabled);
  }, 30_000);
});

describe('Review Stack tools', () => {
  it('lists and calls the two worker tools through stdio, returning the current deck link and import receipt', async () => {
    await withServer('worker', async (client, requests) => {
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toContain('get_review_stack');
      expect(names).toContain('import_review_cards');
      const cards = [{ key: 'test-art', title: 'Review The Artwork', focus: 'Design', what: 'A drawing', context: 'Homepage artwork', excerpt: 'Draft' }];
      const result = await client.callTool({ name: 'import_review_cards', arguments: { cards } });
      expect(result.isError).toBeFalsy();
      const deckUrl = 'http://localhost/?view=review-stack';
      expect(result.structuredContent).toEqual({ added: 1, existing: 0, firstId: 'weekly-test', deckUrl });
      expect(result.content).toEqual([{ type: 'text', text: 'Review Stack added 1 card. 0 already existed. The first card ID is weekly-test. Open My Work at ' + deckUrl }]);
      expect(requests.find(call => call.path === '/api/work-view/review-stack/import')?.body).toEqual({ cards });
      const opened = await client.callTool({ name: 'get_review_stack', arguments: {} });
      expect(opened.structuredContent).toEqual({ deckUrl, itemCount: 1 });
      expect(JSON.stringify(opened.content)).toContain(deckUrl);
      expect(requests.find(call => call.path === '/api/work-view/review-stack')?.query.summary).toBe('1');
    });
  }, 30_000);
});

describe('mcp-server auto-start', () => {
  it('server runtime does not probe the worker with auto-start enabled', async () => {
    await withServer('server', async (client, requests, dataDir) => {
      await client.listTools();
      const deadline = Date.now() + 5_000;
      while (true) {
        const logs = readdirSync(join(dataDir, 'logs'))
          .map(file => readFileSync(join(dataDir, 'logs', file), 'utf8')).join('\n');
        if (/skipping worker auto-start|Worker available|Worker not available/.test(logs)) break;
        if (Date.now() >= deadline) throw new Error('MCP auto-start did not settle');
        await Bun.sleep(10);
      }
      expect(requests.filter(request => request.path === '/api/health')).toEqual([]);
    }, true);
  }, 15_000);
});

describe('raw-tool deep search MCP contract', () => {
  it('passes deep to the worker and formats raw IDs in a JSON-shaped worker reply', async () => {
    await withServer('worker', async (client, requests) => {
      const result = await client.callTool({ name: 'search', arguments: { query: 'DB_CONN_1042', deep: true, format: 'json' } });
      const request = requests.find(r => r.path === '/api/search');
      expect(request?.query.deep).toBe('true');
      expect(JSON.stringify(result)).toContain('#T41');
      expect(JSON.stringify(result)).toContain('get_tool_uses');
    });
  }, 30_000);

  it('preserves raw hits over stdio when the default text reply has oversized summaries', async () => {
    await withServer('worker', async (client, requests) => {
      const result = await client.callTool({name:'search', arguments:{query:'DB_CONN_1042', deep:true}});
      const request = requests.find(r => r.path === '/api/search');
      expect(request?.query.format).toBeUndefined();
      const text = (result.content as Array<{text:string}>).map(block => block.text).join('\n');
      expect(text).toContain('#S1');
      expect(text).toContain('#T41');
      expect(text).toContain('DB_CONN_1042');
      expect(text).toContain('get_tool_uses');
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32 * 1024);
    });
  }, 30_000);

  it('rejects server deep search before any local or server search request', async () => {
    await withServer('server', async (client, requests) => {
      const result = await client.callTool({ name: 'search', arguments: { query: 'DB_CONN_1042', deep: true } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('local-only');
      expect(requests.filter(r => /search|tool-uses/.test(r.path))).toEqual([]);
    });
  }, 30_000);
});
