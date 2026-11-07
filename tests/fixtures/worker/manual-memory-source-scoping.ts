import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mock } from 'bun:test';
import express from 'express';

const source = (file: string) => resolve(import.meta.dir, '../../../src', file);
const dataDir = process.env.CLAUDE_MEM_DATA_DIR!;
const project = 'manual-source-scoping';
const documents = new Map<string, { text: string; metadata: Record<string, any> }>();

// Substitute the MCP transport, keeping real ChromaSync formatting/filtering
// and SearchManager SQLite hydration. Embeddings are not measured.
function matches(where: Record<string, any> | undefined, metadata: Record<string, any>): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (key === '$and') return value.every((clause: Record<string, any>) => matches(clause, metadata));
    if (key === '$or') return value.some((clause: Record<string, any>) => matches(clause, metadata));
    if (value && typeof value === 'object') return '$in' in value
      ? value.$in.includes(metadata[key]) : metadata[key] === value.$eq;
    return metadata[key] === value;
  });
}
mock.module(source('services/sync/ChromaMcpManager.ts'), () => ({
  ChromaMcpManager: { getInstance: () => ({
    callTool: async (name: string, args: Record<string, any>) => {
      if (name === 'chroma_create_collection') return {};
      if (name === 'chroma_add_documents') {
        for (let i = 0; i < args.ids.length; i++) {
          documents.set(args.ids[i], { text: args.documents[i], metadata: args.metadatas[i] });
        }
        return {};
      }
      if (name === 'chroma_query_documents') {
        const rows = [...documents].filter(([, doc]) => matches(args.where, doc.metadata)).slice(0, args.n_results);
        return {
          ids: [rows.map(([id]) => id)], documents: [rows.map(([, doc]) => doc.text)],
          metadatas: [rows.map(([, doc]) => doc.metadata)], distances: [rows.map(() => 0.1)],
        };
      }
      throw new Error(`Unexpected MCP call: ${name}`);
    },
  }) },
}));
mock.module(source('services/integrations/GrokBotIndexWriter.ts'), () => ({ notifyGrokBotIndex() {} }));

const { SessionStore } = await import(source('services/sqlite/SessionStore.ts'));
const { SessionSearch } = await import(source('services/sqlite/SessionSearch.ts'));
const { ChromaSync } = await import(source('services/sync/ChromaSync.ts'));
const { MemoryRoutes } = await import(source('services/worker/http/routes/MemoryRoutes.ts'));
const { SearchRoutes } = await import(source('services/worker/http/routes/SearchRoutes.ts'));
const { SearchManager } = await import(source('services/worker/SearchManager.ts'));
const { FormattingService } = await import(source('services/worker/FormattingService.ts'));
const { TimelineService } = await import(source('services/worker/TimelineService.ts'));
const { MemoryFileWatcher } = await import(source('services/memory/file-watcher.ts'));
const { parseMemoryWatchRoots } = await import(source('services/memory/config.ts'));
const { saveMemory } = await import(source('services/memory/save-memory.ts'));

const dbPath = join(dataDir, 'memory.db');
const store = new SessionStore(dbPath);
const search = new SessionSearch(store.db);
const sync = new ChromaSync('claude-mem');
const writes: Promise<void>[] = [];
const realSync = sync.syncObservation.bind(sync);
sync.syncObservation = (...args: Parameters<typeof realSync>) => {
  const write = realSync(...args);
  writes.push(write);
  return write;
};
const dbManager = {
  getConnection: () => store.db, getSessionStore: () => store,
  getCloudSync: () => null, getChromaSync: () => sync,
};
const app = express();
app.use(express.json());
new MemoryRoutes(dbManager as any, project).setupRoutes(app);
new SearchRoutes(new SearchManager(search, store, sync, new FormattingService(), new TimelineService())).setupRoutes(app);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let watcher: InstanceType<typeof MemoryFileWatcher> | undefined;

try {
  if (process.argv[2] === 'watcher') {
    const root = join(dataDir, 'notes');
    mkdirSync(root);
    writeFileSync(join(root, 'release.md'), 'Use blue-green releases.');
    watcher = new MemoryFileWatcher(parseMemoryWatchRoots(JSON.stringify([
      { path: root, project, platformSource: ' Codex ' },
    ])), input => saveMemory(dbManager as any, project, input), 10);
    watcher.scan(0);
    watcher.scan(11);
    watcher.stop();
  } else {
    // Exercise source normalization and the existing omitted-source default.
    for (const platformSource of [' Codex ', 'cursor', undefined]) {
      const response = await fetch(`${baseUrl}/api/memory/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Use blue-green releases.', title: 'Release discipline', project,
          ...(platformSource ? { metadata: { platformSource } } : {}),
        }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { success: boolean }).success, true);
    }
  }
  await Promise.all(writes);
  const beforeReplay = writes.length;
  if (watcher) {
    const root = join(dataDir, 'notes');
    const restarted = new MemoryFileWatcher([{ path: root, project, platformSource: 'codex' }],
      input => saveMemory(dbManager as any, project, input), 10);
    restarted.scan(20); restarted.scan(31); restarted.stop();
    assert.equal(writes.length, beforeReplay, 'Exact watcher replay must not re-index the note');
  }

  const rows = store.db.query(`SELECT o.id, o.narrative, s.platform_source FROM observations o
    JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id ORDER BY o.id`).all() as
    Array<{ id: number; narrative: string; platform_source: string }>;
  assert.equal(rows.length, watcher ? 1 : 3);
  // No keyword match can hide a missing semantic candidate through FTS fallback.
  assert.equal(search.searchObservations('deployment strategy', { project, platformSource: 'codex' }).length, 0);
  const indexedSources = rows.map(row => ({ id: row.id, sqlite: row.platform_source,
    chroma: [...documents.values()].filter(doc => doc.metadata.sqlite_id === row.id).map(doc => doc.metadata.platform_source),
  }));
  console.log(JSON.stringify({ mode: process.argv[2], indexedSources }));
  for (const row of rows) {
    const response = await fetch(`${baseUrl}/api/search?` + new URLSearchParams({
      query: 'deployment strategy', project, platformSource: row.platform_source, type: 'observations', format: 'json',
    }));
    assert.equal(response.status, 200);
    const result = await response.json() as { observations: Array<{ id: number; narrative: string }> };
    assert.deepEqual(result.observations.map(item => item.id), [row.id],
      `Source-scoped semantic search must retrieve only the saved ${row.platform_source} note`);
    assert.equal(result.observations[0].narrative, 'Use blue-green releases.');
  }
  for (const row of indexedSources) assert.ok(row.chroma.length > 0 && row.chroma.every(source => source === row.sqlite),
    'Every indexed fragment must retain the persisted platform');
} finally {
  watcher?.stop();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close();
}
// Reopen the actual SQLite file, rather than asserting only in-memory state.
const reopened = new SessionStore(dbPath);
const persisted = reopened.db.query(`SELECT count(*) AS n FROM observations o JOIN sdk_sessions s
  ON s.memory_session_id = o.memory_session_id WHERE s.platform_source = 'codex'`).get() as { n: number };
assert.equal(persisted.n, 1);
reopened.close();
