import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';
import { MemoryRoutes } from '../../src/services/worker/http/routes/MemoryRoutes.js';
import { WorkStateRoutes } from '../../src/services/worker/http/routes/WorkStateRoutes.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';

function modelText(result: CallToolResult): string {
  expect(result.structuredContent).toBeUndefined();
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  expect(() => JSON.parse(text)).toThrow();
  return text;
}
function cursor(text: string): string {
  const value = /^Continue with: (ms_[A-Za-z0-9_-]{24})$/m.exec(text)?.[1];
  expect(value).toBeDefined();
  return value!;
}

describe('built local MCP progressive stdio integration', () => {
  it('advertises guided/automatic search and delivers curated text through the real stdio transport', async () => {
    const db = new Database(':memory:');
    const store = new SessionStore(db);
    const project = 'stdio-progressive-fixture';
    const memory = store.getOrCreateManualSession(project);
    const saved = store.storeObservation(memory, project, {
      type: 'decision', title: 'Authentication token expiry', subtitle: null, narrative: 'PRIVATE_STDIO_BODY',
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, Date.now());
    const literals = [
      { project: 'stdio-json-object', title: 'Configuration timeout example', body: '{"timeoutSeconds":30}' },
      { project: 'stdio-json-array', title: 'Staging environment example', body: '["use staging"]' },
    ].map(fixture => ({ ...fixture, id: store.storeObservation(store.getOrCreateManualSession(fixture.project), fixture.project, {
      type: 'decision', title: fixture.title, subtitle: null, narrative: fixture.body,
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, Date.now()).id }));
    const manager = new SearchManager(new SessionSearch(db), store, null, new FormattingService(), new TimelineService());
    const app = express();
    app.use(express.json());
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: '13.34.2' }));
    new SearchRoutes(manager).setupRoutes(app);
    const databaseManager = { getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null } as unknown as DatabaseManager;
    new MemoryRoutes(databaseManager, project).setupRoutes(app);
    new WorkStateRoutes(databaseManager).setupRoutes(app);
    app.post('/api/observations/batch', (req, res) => res.json(store.getObservationsByIds(req.body.ids)));
    app.post('/api/tool-uses/batch', (_req, res) => res.json([{ id: 7, tool_name: 'Read', tool_input: '{"file_path":"src/auth.ts"}', tool_response: '{"content":"Selected raw evidence"}', metadata: 'PRIVATE_TOOL_METADATA' }]));
    const corpus = { name: 'fixture', stats: { observation_count: 1, token_estimate: 42 }, session_id: null, system_prompt: 'PRIVATE_CORPUS_PROMPT', observations: [saved] };
    app.get('/api/corpus', (_req, res) => res.json({ content: [{ type: 'text', text: JSON.stringify([corpus]) }] }));
    app.post('/api/corpus', (_req, res) => res.json(corpus));
    app.post('/api/corpus/:name/prime', (_req, res) => res.json({ name: 'fixture', session_id: 'PRIVATE_CORPUS_SESSION' }));
    app.post('/api/corpus/:name/reprime', (_req, res) => res.json({ name: 'fixture', session_id: 'PRIVATE_CORPUS_SESSION' }));
    app.post('/api/corpus/:name/rebuild', (_req, res) => res.json(corpus));
    app.post('/api/corpus/:name/query', (_req, res) => res.json({ answer: 'A selected corpus answer.', session_id: 'PRIVATE_CORPUS_SESSION' }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const transport = new StdioClientTransport({
      command: 'node', args: [join(process.cwd(), 'plugin/scripts/mcp-server.cjs')], cwd: process.cwd(), stderr: 'pipe',
      env: { ...process.env, CLAUDE_MEM_WORKER_PORT: String(address.port), CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_AUTOSTART: 'false', CLAUDE_MEM_RUNTIME: 'worker' } as Record<string, string>,
    });
    const client = new Client({ name: 'progressive-stdio-fixture', version: '1' });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);
      const listing = await client.listTools();
      expect(listing.tools.find(tool => tool.name === 'mem_search')?.annotations?.readOnlyHint).toBe(true);
      expect(listing.tools.some(tool => tool.name === 'save_memory')).toBe(true);
      const first = modelText(await client.callTool({ name: 'mem_search', arguments: { query: 'authentication', project } }) as CallToolResult);
      expect(first).toStartWith('mem-search step 1 of 3');
      expect(first).toContain(`[${saved.id}]`);
      expect(first).not.toContain('PRIVATE_STDIO_BODY');
      const second = modelText(await client.callTool({ name: 'mem_search', arguments: { continuation: cursor(first), selectedIds: [saved.id] } }) as CallToolResult);
      expect(second).toStartWith('mem-search step 2 of 3');
      expect(second).not.toContain('PRIVATE_STDIO_BODY');
      const third = modelText(await client.callTool({ name: 'mem_search', arguments: { continuation: cursor(second), selectedIds: [String(saved.id)] } }) as CallToolResult);
      expect(third).toStartWith('mem-search step 3 of 3');
      expect(third).toContain('PRIVATE_STDIO_BODY');
      const auto = modelText(await client.callTool({ name: 'mem_search', arguments: { query: 'authentication', project, mode: 'auto' } }) as CallToolResult);
      expect(auto).toContain('Automatic search: index → context → selected details.');
      expect(auto).toContain('PRIVATE_STDIO_BODY');
      for (const fixture of literals) {
        const index = modelText(await client.callTool({ name: 'mem_search', arguments: { query: fixture.title, project: fixture.project } }) as CallToolResult);
        expect(index).not.toContain(fixture.body);
        const context = modelText(await client.callTool({ name: 'mem_search', arguments: { continuation: cursor(index), selectedIds: [fixture.id] } }) as CallToolResult);
        expect(context).not.toContain(fixture.body);
        const selected = modelText(await client.callTool({ name: 'mem_search', arguments: { continuation: cursor(context), selectedIds: [fixture.id] } }) as CallToolResult);
        expect(selected).toContain(fixture.body);
        const automatic = modelText(await client.callTool({ name: 'mem_search', arguments: { query: fixture.title, project: fixture.project, mode: 'auto' } }) as CallToolResult);
        expect(automatic).toContain(fixture.body);
        expect(automatic).not.toContain('No readable memory details');
      }
      const bad = await client.callTool({ name: 'mem_search', arguments: { query: 'authentication', limit: 1000 } }) as CallToolResult;
      expect(bad.isError).toBe(true);
      expect(modelText(bad)).toContain('limit must be an integer');
      const note = modelText(await client.callTool({ name: 'save_memory', arguments: { text: 'A durable SQLite fixture note.', title: 'Saved fixture note', project } }) as CallToolResult);
      expect(note).toStartWith('Saved memory #');
      expect(note).not.toContain('A durable SQLite fixture note.');
      expect(store.getObservationById(Number(/#(\d+):/.exec(note)?.[1]))?.narrative).toBe('A durable SQLite fixture note.');
      const details = modelText(await client.callTool({ name: 'get_observations', arguments: { ids: [saved.id] } }) as CallToolResult);
      expect(details).toContain('PRIVATE_STDIO_BODY');
      expect(details).not.toContain('sdk_session_id');
      const raw = modelText(await client.callTool({ name: 'get_tool_uses', arguments: { ids: [7] } }) as CallToolResult);
      expect(raw).toContain('file_path: src/auth.ts');
      expect(raw).not.toContain('PRIVATE_TOOL_METADATA');
      for (const name of ['list_corpora', 'build_corpus', 'prime_corpus', 'reprime_corpus', 'rebuild_corpus', 'query_corpus']) {
        const args = name === 'list_corpora' ? {} : name === 'query_corpus' ? { name: 'fixture', question: 'What happened?' } : { name: 'fixture' };
        const output = modelText(await client.callTool({ name, arguments: args }) as CallToolResult);
        expect(output).not.toContain('PRIVATE_CORPUS_');
        expect(output).not.toContain('system_prompt');
      }
      const work = modelText(await client.callTool({ name: 'work_state_write', arguments: { list: 'stdio-fixture', fields: { task: 'Verify readable output', status: 'doing' } } }) as CallToolResult);
      expect(work).toContain('Verify readable output');
      const read = modelText(await client.callTool({ name: 'work_state_read', arguments: { list: 'stdio-fixture' } }) as CallToolResult);
      expect(read).toContain('Verify readable output');
    } finally {
      await client.close();
      await transport.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    }
  }, 15_000);

  it('formats every server-runtime observation handler as readable selected information', async () => {
    const app = express(); app.use(express.json());
    let localWrites = 0;
    app.post('/api/memory/save', (_req, res) => { localWrites++; res.json({ success: true, id: 99, title: 'WRONG_DATABASE_WRITE' }); });
    const observation = { id: 'memory-fixture', projectId: 'project-fixture', content: 'PRIVATE_SERVER_NARRATIVE', metadata: { title: 'A server decision', secret: 'PRIVATE_SERVER_METADATA' }, teamId: 'PRIVATE_TEAM', tokenUsage: 12345 };
    app.post('/v1/memories', (_req, res) => res.json({ memory: observation }));
    app.post('/v1/events', (_req, res) => res.json({ event: { id: 'event-fixture', payload: 'PRIVATE_EVENT_PAYLOAD' }, generationJob: { id: 'job-fixture', status: 'queued' } }));
    app.post('/v1/search', (_req, res) => res.json({ observations: [observation,
      { id: 'plain-fixture', projectId: 'project-fixture', content: 'Use staging for deployment rehearsals.', metadata: { secret: 'PRIVATE_NOTE_METADATA' } },
      { id: 'summary-fixture', projectId: 'project-fixture', content: 'PRIVATE_SUMMARY_BODY', metadata: { request: 'How did we fix login redirects?', secret: 'PRIVATE_SUMMARY_METADATA' } },
    ] }));
    app.post('/v1/context', (_req, res) => res.json({ observations: [observation], context: 'Selected server context.' }));
    app.get('/v1/jobs/:id', (req, res) => req.params.id === 'bad-fixture'
      ? res.status(502).json({ error: 'PRIVATE_BACKEND_ERROR_BODY' })
      : res.json({ generationJob: { id: 'job-fixture', status: 'completed', payload: 'PRIVATE_JOB_PAYLOAD' } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const transport = new StdioClientTransport({
      command: 'node', args: [join(process.cwd(), 'plugin/scripts/mcp-server.cjs')], cwd: process.cwd(), stderr: 'pipe',
      env: { ...process.env, CLAUDE_MEM_RUNTIME: 'server', CLAUDE_MEM_SERVER_URL: `http://127.0.0.1:${address.port}`, CLAUDE_MEM_SERVER_API_KEY: 'owned-fixture-key', CLAUDE_MEM_SERVER_PROJECT_ID: 'project-fixture', CLAUDE_MEM_WORKER_PORT: String(address.port), CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_AUTOSTART: 'false' } as Record<string, string>,
    });
    const client = new Client({ name: 'server-model-text-fixture', version: '1' });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);
      const cases: Array<{ name: string; arguments: Record<string, unknown>; expected: string }> = [
        { name: 'observation_add', arguments: { content: 'A durable server note.' }, expected: 'Saved observation #memory-fixture.' },
        { name: 'observation_record_event', arguments: { eventType: 'UserPromptSubmit' }, expected: 'Recorded event #event-fixture.' },
        { name: 'observation_search', arguments: { query: 'decision' }, expected: '#memory-fixture — A server decision' },
        { name: 'observation_context', arguments: {}, expected: 'Selected server context.' },
        { name: 'observation_generation_status', arguments: { jobId: 'job-fixture' }, expected: 'Generation job job-fixture: completed.' },
        { name: 'search', arguments: { query: 'decision' }, expected: '#memory-fixture — A server decision' },
      ];
      for (const entry of cases) {
        const result = await client.callTool({ name: entry.name, arguments: entry.arguments }) as CallToolResult;
        expect(result.isError).not.toBe(true);
        const text = modelText(result);
        expect(text).toContain(entry.expected);
        expect(text).not.toContain('PRIVATE_');
        expect(text).not.toContain('12345');
        if (entry.name === 'search' || entry.name === 'observation_search') {
          expect(text).toContain('#plain-fixture — Excerpt: Use staging for deployment rehearsals.');
          expect(text).toContain('#summary-fixture — How did we fix login redirects?');
          expect(text).toContain('Use observation_context with a focused query and limit');
          expect(text).not.toContain('Use mem_search');
          const supported = await client.callTool({ name: 'observation_context', arguments: { query: 'staging', limit: 1 } }) as CallToolResult;
          expect(supported.isError).not.toBe(true);
          expect(modelText(supported)).toContain('Selected server context.');
        }
      }
      const unavailable = await client.callTool({ name: 'mem_search', arguments: { query: 'decision' } }) as CallToolResult;
      expect(unavailable.isError).toBe(true);
      expect(modelText(unavailable)).toContain('hosted claude-mem MCP');
      const note = await client.callTool({ name: 'save_memory', arguments: { text: 'A server-scoped note.' } }) as CallToolResult;
      expect(note.isError).toBe(true);
      expect(modelText(note)).toContain('observation_add');
      expect(localWrites).toBe(0);
      const failure = await client.callTool({ name: 'observation_generation_status', arguments: { jobId: 'bad-fixture' } }) as CallToolResult;
      expect(failure.isError).toBe(true);
      expect(modelText(failure)).toContain('HTTP 502');
      expect(modelText(failure)).not.toContain('PRIVATE_BACKEND_ERROR_BODY');
    } finally {
      await client.close(); await transport.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 15_000);
});
