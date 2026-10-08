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
import { join } from 'node:path';

describe('built local MCP progressive stdio integration', () => {
  it('advertises guided/automatic search and note taking, forwarding the canonical envelope', async () => {
    const db = new Database(':memory:');
    const store = new SessionStore(db);
    const project = 'stdio-progressive-fixture';
    const memory = store.getOrCreateManualSession(project);
    const saved = store.storeObservation(memory, project, {
      type: 'decision', title: 'Authentication token expiry', subtitle: null, narrative: 'PRIVATE_STDIO_BODY',
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, Date.now());
    const manager = new SearchManager(new SessionSearch(db), store, null, new FormattingService(), new TimelineService());
    const app = express();
    app.use(express.json());
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: '13.34.2' }));
    new SearchRoutes(manager).setupRoutes(app);
    new MemoryRoutes({ getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null } as any, project).setupRoutes(app);
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
      const first: any = await client.callTool({ name: 'mem_search', arguments: { query: 'authentication', project } });
      expect(first.structuredContent.step).toBe(1);
      expect(JSON.parse(first.content[0].text)).toEqual(first.structuredContent);
      expect(JSON.stringify(first)).not.toContain('PRIVATE_STDIO_BODY');
      const second: any = await client.callTool({ name: 'mem_search', arguments: { continuation: first.structuredContent.continuation, selectedIds: [saved.id] } });
      expect(second.structuredContent.step).toBe(2);
      expect(JSON.stringify(second)).not.toContain('PRIVATE_STDIO_BODY');
      const third: any = await client.callTool({ name: 'mem_search', arguments: { continuation: second.structuredContent.continuation, selectedIds: [String(saved.id)] } });
      expect(third.structuredContent.step).toBe(3);
      expect(third.structuredContent.observations[0].content).toContain('PRIVATE_STDIO_BODY');
      const auto: any = await client.callTool({ name: 'mem_search', arguments: { query: 'authentication', project, mode: 'auto' } });
      expect(auto.structuredContent.trace.map((row: any) => row.operation)).toEqual(['search', 'timeline', 'fetch']);
      const bad: any = await client.callTool({ name: 'mem_search', arguments: { query: 'authentication', limit: 1000 } });
      expect(bad.isError).toBe(true);
      expect(JSON.parse(bad.content[0].text).error.code).toBe('invalid_input');
      const note: any = await client.callTool({ name: 'save_memory', arguments: { text: 'A durable SQLite fixture note.', title: 'Saved fixture note', project } });
      const noteResult = JSON.parse(note.content[0].text);
      expect(noteResult.success).toBe(true);
      expect(store.getObservationById(noteResult.id)?.narrative).toBe('A durable SQLite fixture note.');
    } finally {
      await client.close();
      await transport.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    }
  }, 15_000);
});
