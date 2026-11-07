import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import express from 'express';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
  import { SearchOrchestrator } from './src/services/worker/search/SearchOrchestrator.ts';
  import { CorpusBuilder } from './src/services/worker/knowledge/CorpusBuilder.ts';
  import { CorpusStore } from './src/services/worker/knowledge/CorpusStore.ts';
  import { CorpusRoutes } from './src/services/worker/http/routes/CorpusRoutes.ts';
  import { ChromaSync } from './src/services/sync/ChromaSync.ts';
  import { ChromaMcpManager } from './src/services/sync/ChromaMcpManager.ts';
  const store = new SessionStore(':memory:');
  const sid = store.createSDKSession('corpus-budget-content', 'budget-project', 'ask');
  store.ensureMemorySessionIdRegistered(sid, 'corpus-budget-memory');
  const epoch = Date.now();
  const docs = [];
  for (let n = 0; n < 520; n++) {
    const id = store.storeObservation('corpus-budget-memory', 'budget-project', {
      type: 'discovery', title: 'Captured finding ' + n, subtitle: null,
      narrative: 'Recorded fact for module ' + n, facts: ['module-' + n],
      concepts: [], files_read: [], files_modified: []
    }, n + 1, 0, epoch - n * 1000).id;
    docs.push({ id: 'obs_' + id + '_narrative', metadata: {
      doc_type: 'observation', sqlite_id: id, project: 'budget-project', created_at_epoch: epoch - n * 1000
    } });
  }
  const calls = [];
  // Only ranked transport results are controlled. The real ChromaSync handles
  // transport counts, metadata filters and fragment deduplication.
  ChromaMcpManager.getInstance().callTool = async (tool, args) => {
    if (tool === 'chroma_create_collection') return {};
    if (tool !== 'chroma_query_documents') throw new Error('Unexpected vector tool: ' + tool);
    calls.push(args);
    const hits = docs.slice(0, args.n_results);
    return { ids: [hits.map(d => d.id)], metadatas: [hits.map(d => d.metadata)], distances: [hits.map((_, n) => n / 1000)] };
  };
  const corpusStore = new CorpusStore();
  const vector = process.env.CORPUS_VECTOR === '1' ? new ChromaSync('budget-project') : null;
  const builder = new CorpusBuilder(store, new SearchOrchestrator(new SessionSearch(store.db), store, vector), corpusStore);
  const app = express(); app.use(express.json());
  new CorpusRoutes(corpusStore, builder, {}).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/corpus';
  const requests = [];
  try {
    for (const input of JSON.parse(process.env.CORPUS_REQUESTS)) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      const body = await response.json();
      const saved = corpusStore.read(input.name);
      const metadata = await (await fetch(url + '/' + input.name)).json();
      requests.push({ status: response.status, count: body.stats?.observation_count,
        persisted: saved?.observations.length, reread: metadata.stats?.observation_count,
        filter: saved?.filter, ids: saved?.observations.map(o => o.id) });
    }
    console.log(JSON.stringify({ requests, calls, available: store.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n }));
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
  }
`;

function run(vector: boolean, requests: Record<string, unknown>[]) {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-budget-'));
  try {
    const result = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config'),
        CORPUS_VECTOR: vector ? '1' : '0', CORPUS_REQUESTS: JSON.stringify(requests), DO_NOT_TRACK: '1' },
    });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('corpus observation budget through registered HTTP routes', () => {
  it('uses the documented 500-observation default and preserves an explicit smaller limit', () => {
    const result = run(false, [
      { name: 'default-budget', project: 'budget-project' },
      { name: 'small-budget', project: 'budget-project', limit: 4 },
    ]);
    expect(result.available).toBe(520);
    expect(result.requests.map((r: { status: number }) => r.status)).toEqual([200, 200]);
    expect(result.requests.map((r: { count: number }) => r.count)).toEqual([500, 4]);
    expect(result.requests.map((r: { persisted: number }) => r.persisted)).toEqual([500, 4]);
    expect(result.requests.map((r: { reread: number }) => r.reread)).toEqual([500, 4]);
    expect(result.requests[0].filter.limit).toBeUndefined();
    expect(result.requests[1].filter.limit).toBe(4);
  });

  it('honors an explicit semantic corpus budget above the interactive 100-candidate window', () => {
    const result = run(true, [
      { name: 'semantic-budget', project: 'budget-project', query: 'unindexed meaning request', limit: 150 },
      { name: 'semantic-default', project: 'budget-project', query: 'unindexed meaning request' },
      { name: 'semantic-small', project: 'budget-project', query: 'unindexed meaning request', limit: 4 },
    ]);
    expect(result.available).toBe(520);
    expect(result.requests[0].status).toBe(200);
    expect(result.requests[0].count).toBe(150);
    expect(result.requests[0].persisted).toBe(150);
    expect(result.requests[0].reread).toBe(150);
    expect(new Set(result.requests[0].ids).size).toBe(150);
    expect(result.requests[0].filter.limit).toBe(150);
    expect(result.requests.map((r: { count: number }) => r.count)).toEqual([150, 500, 4]);
    expect(result.requests.map((r: { persisted: number }) => r.persisted)).toEqual([150, 500, 4]);
    expect(result.requests.map((r: { reread: number }) => r.reread)).toEqual([150, 500, 4]);
  });
});
