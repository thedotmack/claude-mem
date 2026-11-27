import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import express from 'express';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import type { ChromaSync } from '../../src/services/sync/ChromaSync.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { DataRoutes } from '../../src/services/worker/http/routes/DataRoutes.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';

describe('keyword memory exports', () => {
  let directory: string;
  let output: string;
  let previous: Buffer;
  let store: SessionStore;
  let reader: SessionSearch;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'export-search-failure-'));
    output = join(directory, 'export.json');
    store = new SessionStore(':memory:');
    reader = new SessionSearch(store.db);
    const session = store.createSDKSession('content-id', 'project', 'start');
    store.ensureMemorySessionIdRegistered(session, 'memory-id');
    store.storeObservation('memory-id', 'project', {
      type: 'discovery', title: 'needle', subtitle: null, narrative: 'needle',
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1);
    store.saveUserPrompt('content-id', 1, 'needle prompt', session);
    const initial = await runExport(worker(null), '');
    expect(initial.code, initial.stderr).toBe(0);
    previous = readFileSync(output);
    expect(JSON.parse(previous.toString())).toMatchObject({ totalObservations: 1, totalPrompts: 1 });
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function worker(chroma: ChromaSync | null) {
    const app = express();
    app.use(express.json());
    const manager = new SearchManager(reader, store, chroma, new FormattingService(), new TimelineService());
    new SearchRoutes(manager).setupRoutes(app);
    new DataRoutes({} as any, { getSessionStore: () => store, getChromaSync: () => null } as any,
      {} as any, {} as any, {} as any, Date.now()).setupRoutes(app);
    return app;
  }

  async function runExport(app: express.Express, query: string) {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../scripts/export-memories.ts'), query, output], {
        env: {
          ...process.env,
          CLAUDE_MEM_DATA_DIR: directory,
          CLAUDE_CONFIG_DIR: join(directory, 'config'),
          CLAUDE_MEM_WORKER_URL: '',
          CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
          CLAUDE_MEM_WORKER_PORT: String((server.address() as AddressInfo).port),
          CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN: '0',
        },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [code, stderr, stdout] = await Promise.all([
        child.exited, new Response(child.stderr).text(), new Response(child.stdout).text(),
      ]);
      return { code, stderr, stdout };
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  const unavailable = { queryChroma: async () => { throw new Error('semantic search unavailable'); } } as ChromaSync;
  for (const chroma of [null, unavailable]) {
    describe(chroma ? 'after a semantic search error' : 'without Chroma', () => {
      for (const method of ['searchObservations', 'searchSessions'] as const) {
        it(`preserves the previous export when ${method} fails`, async () => {
          const read = spyOn(reader, method).mockImplementation(() => { throw new Error('fixture read failure'); });
          const result = await runExport(worker(chroma), 'needle');
          expect(read).toHaveBeenCalled();
          expect(result.code).toBe(1);
          expect(result.stderr).toContain('Failed to search: 500');
          expect(readFileSync(output).equals(previous)).toBe(true);
          expect(result.stdout).not.toContain('Export complete!');
        });
      }

      it('publishes a genuine zero-match search', async () => {
        const result = await runExport(worker(chroma), 'unmatched');
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
          query: 'unmatched', observations: [], sessions: [], summaries: [], prompts: [],
        });
      });
    });
  }

  it('exports recovered keyword matches after a semantic search error', async () => {
    const result = await runExport(worker(unavailable), 'needle');
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ totalObservations: 1, totalSessions: 1, totalPrompts: 1 });
  });

  it('preserves the previous export when the worker only supports the older search formats', async () => {
    const app = express();
    app.get('/api/search', (req, res) => res.json(req.query.format === 'json'
      ? { observations: [], sessions: [], prompts: [], totalResults: 0 }
      : { content: [{ type: 'text', text: 'No results found' }] }));
    const result = await runExport(app, 'needle');
    expect(result.code).toBe(1);
    expect(readFileSync(output).equals(previous)).toBe(true);
    expect(result.stderr).toContain('Update the worker');
    const fullHistory = await runExport(app, '');
    expect(fullHistory.code, fullHistory.stderr).toBe(0);
  });
});
