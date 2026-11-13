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
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';
import { MemoryRoutes } from '../../src/services/worker/http/routes/MemoryRoutes.js';
import { WorkStateRoutes } from '../../src/services/worker/http/routes/WorkStateRoutes.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function modelText(result: CallToolResult): string {
  expect(result.structuredContent).toBeUndefined();
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  expect(() => JSON.parse(text)).toThrow();
  return text;
}

// The Zed contract against the bundled MCP server: the installer registers
// `node plugin/scripts/mcp-server.cjs` as Zed's `claude-mem` context server,
// so this suite drives that exact shipped bundle over stdio the way Zed's
// MCP client would — no Zed GUI involved — and pins the tool surface Zed
// needs: recall (search/timeline/get_observations, plus smart_search,
// dumb_search, session_start_context) and explicit save (save_memory). It
// also proves a seeded known observation is retrievable and that a
// save_memory call persists. `context` and `recent` are tools of the
// recall-only server (src/server/mcp/recall-mcp-server.ts), NOT of this
// bundled full server — verified live 2026-11-13 — so they are not claimed
// here. Server-beta tools (observation_add et al.) are hidden in the worker
// runtime, so they must stay absent; the doc tells Zed users to save via
// save_memory only.
describe('Zed MCP server over stdio (bundled mcp-server.cjs)', () => {
  it('advertises recall + save_memory, retrieves a seeded observation, and persists an explicit save', async () => {
    ModeManager.getInstance().loadMode('code');
    const db = new Database(':memory:');
    const store = new SessionStore(db);
    const project = 'zed-mcp-verification';
    const seeded = store.storeObservation(store.getOrCreateManualSession(project), project, {
      type: 'decision', title: 'Local persistence choice', subtitle: null,
      narrative: 'The project uses SQLite for local persistence',
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, Date.now());
    const manager = new SearchManager(new SessionSearch(db), store, null, new FormattingService(), new TimelineService());
    const app = express();
    app.use(express.json());
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: '13.34.2' }));
    new SearchRoutes(manager).setupRoutes(app);
    const databaseManager = { getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null } as unknown as DatabaseManager;
    new MemoryRoutes(databaseManager, project).setupRoutes(app);
    new WorkStateRoutes(databaseManager).setupRoutes(app);
    app.post('/api/observations/batch', (req, res) => res.json(store.getObservationsByIds(req.body.ids)));
    app.post('/api/tool-uses/batch', (_req, res) => res.json([]));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const dataDir = mkdtempSync(join(tmpdir(), 'zed-mcp-stdio-'));
    const transport = new StdioClientTransport({
      command: 'node', args: [join(process.cwd(), 'plugin/scripts/mcp-server.cjs')], cwd: process.cwd(), stderr: 'pipe',
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_MEM_WORKER_PORT: String(address.port), CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_AUTOSTART: 'false', CLAUDE_MEM_RUNTIME: 'worker' } as Record<string, string>,
    });
    const client = new Client({ name: 'zed-mcp-verification', version: '1' });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);
      const listing = await client.listTools();
      const names = new Set(listing.tools.map(tool => tool.name));
      for (const tool of ['search', 'timeline', 'get_observations', 'smart_search', 'dumb_search', 'session_start_context', 'save_memory']) {
        expect(names.has(tool)).toBe(true);
      }
      // `context` and `recent` live on the recall-only server, not this one.
      expect(names.has('context')).toBe(false);
      expect(names.has('recent')).toBe(false);
      // Worker runtime hides the server-beta write tools; Zed must not be
      // told to call them.
      expect(names.has('observation_add')).toBe(false);

      // Retrieval of the seeded known observation.
      const found = modelText(await client.callTool({ name: 'search', arguments: {
        query: 'SQLite local persistence', project,
      } }) as CallToolResult);
      expect(found).toContain(`#${seeded.id}`);

      // Explicit save through the same server, then persistence in the store.
      const note = modelText(await client.callTool({ name: 'save_memory', arguments: {
        text: 'The project uses SQLite for local persistence',
        title: 'Persistence decision (Zed verification)', project,
      } }) as CallToolResult);
      expect(note).toStartWith('Saved memory #');
      const savedId = Number(/#(\d+):/.exec(note)?.[1]);
      expect(store.getObservationById(savedId)?.narrative).toBe('The project uses SQLite for local persistence');

      // The saved note is retrievable too.
      const retrieved = modelText(await client.callTool({ name: 'get_observations', arguments: {
        ids: [savedId],
      } }) as CallToolResult);
      expect(retrieved).toContain('The project uses SQLite for local persistence');
    } finally {
      await client.close();
      await transport.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 15_000);
});
