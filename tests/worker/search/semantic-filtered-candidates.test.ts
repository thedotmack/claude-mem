import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep transport substitution isolated from other suites. SQLite, ChromaSync's
// fragment deduplication, request normalization and HTTP handlers are real.
const fixture = String.raw`
  import express from 'express';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
  import { SearchManager } from './src/services/worker/SearchManager.ts';
  import { SearchRoutes } from './src/services/worker/http/routes/SearchRoutes.ts';
  import { FormattingService } from './src/services/worker/FormattingService.ts';
  import { TimelineService } from './src/services/worker/TimelineService.ts';
  import { ChromaSync } from './src/services/sync/ChromaSync.ts';
  import { ChromaMcpManager } from './src/services/sync/ChromaMcpManager.ts';
  const store = new SessionStore(':memory:');
  const sid = store.createSDKSession('content', 'filtered', 'ask');
  store.ensureMemorySessionIdRegistered(sid, 'memory');
  const now = Date.now();
  const field = process.env.FILTER_FIELD;
  const cap = process.env.BUDGET_SCENARIO === '1';
  const docs = [];
  const make = (name, wanted, keyword = false, archived = false) => {
    const epoch = archived || (!wanted && (field === 'recency' || field === 'dateRange')) ? now - 120 * 86400000 : now;
    const id = store.storeObservation('memory', 'filtered', {
      type: wanted ? 'decision' : 'discovery', title: name, subtitle: null,
      narrative: keyword ? 'retrievalneedle' : 'A semantic paraphrase without the literal query',
      facts: [], concepts: wanted ? ['target'] : ['other'],
      files_read: wanted ? ['src/target.ts'] : ['src/other.ts'], files_modified: []
    }, 1, 0, epoch).id;
    for (let n = 0; n < Number(process.env.FRAGMENTS || 1); n++) docs.push({
      id: 'obs_' + id + '_fact_' + n,
      metadata: { sqlite_id: id, doc_type: 'observation', project: 'filtered', created_at_epoch: epoch }
    });
    return id;
  };
  // The partial-page fallback must not reintroduce an expired keyword match.
  if (cap) make('Expired keyword match', true, true, true);
  const first = make('First semantic match', true, process.env.DUPLICATE_KEYWORD === '1');
  for (let i = 0; i < (cap ? 8192 : 140); i++) make('Excluded ' + i, false);
  const second = make('Second matching memory', true, cap);
  const third = make('Third matching memory', true, cap);
  const matches = (where, meta) => !where || (where.$and ? where.$and.every(w => matches(w, meta))
    : where.$or ? where.$or.some(w => matches(w, meta))
    : Object.entries(where).every(([key, value]) => typeof value === 'object' && value.$in ? value.$in.includes(meta[key]) : meta[key] === value));
  const calls = [];
  const hydrated = [];
  const nativeHydrate = store.getObservationsByIds.bind(store);
  store.getObservationsByIds = (ids, options) => { hydrated.push(...ids); return nativeHydrate(ids, options); };
  ChromaMcpManager.getInstance().callTool = async (name, args) => {
    if (name === 'chroma_create_collection') return {};
    if (name !== 'chroma_query_documents') throw new Error('Unexpected tool ' + name);
    calls.push(args);
    const hits = docs.filter(d => matches(args.where, d.metadata)).slice(0, args.n_results);
    return { ids: [hits.map(d => d.id)], metadatas: [hits.map(d => d.metadata)], distances: [hits.map(() => 0.1)] };
  };
  const manager = new SearchManager(new SessionSearch(store.db), store, new ChromaSync('filtered'), new FormattingService(), new TimelineService());
  const filter = field === 'dateRange' ? { dateStart: new Date(now - 86400000).toISOString() }
    : field === 'obs_type' || cap ? { obs_type: 'decision' }
    : field === 'concepts' ? { concepts: 'target' }
    : field === 'files' ? { files: 'src/target.ts' } : {};
  const args = { query: 'retrievalneedle', project: 'filtered', type: 'observations', orderBy: 'relevance', limit: '2', offset: process.env.OFFSET || '0', ...filter };
  const app = express(); new SearchRoutes(manager).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    const results = [];
    for (const pipeline of ['http', 'orchestrator']) {
      calls.length = 0; hydrated.length = 0;
      const body = pipeline === 'http'
        ? await (await fetch('http://127.0.0.1:' + server.address().port + '/api/search?' + new URLSearchParams({ ...args, format: 'json' }))).json()
        : (await manager.getOrchestrator().search(args)).results;
      results.push({ pipeline, ids: body.observations.map(row => row.id), calls: [...calls], hydrated: [...hydrated] });
    }
    console.log(JSON.stringify({ first, second, third, results }));
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
  }
`;

function runFixture(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'filtered-semantic-candidates-'));
  try {
    const run = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ...extraEnv, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') },
    });
    if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
    return JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('unified semantic candidates after row filtering', () => {
  for (const field of ['recency', 'dateRange', 'obs_type', 'concepts', 'files']) {
    it(`fills a partial semantic page beyond the first 100 candidates for ${field}`, () => {
      const result = runFixture({ FILTER_FIELD: field });
      for (const row of result.results) {
        expect(row.ids, row.pipeline).toEqual([result.first, result.second]);
        expect(row.calls.length).toBeLessThanOrEqual(10);
        expect(new Set(row.hydrated).size).toBe(row.hydrated.length);
      }
    });
  }

  it('finds later filtered pages without repeating earlier semantic rows', () => {
    const result = runFixture({ FILTER_FIELD: 'concepts', OFFSET: '1' });
    for (const row of result.results) expect(row.ids).toEqual([result.second, result.third]);
  });

  it('does not mistake a short deduplicated fragment prefix for exhaustion', () => {
    const result = runFixture({ FILTER_FIELD: 'concepts', FRAGMENTS: '5' });
    for (const row of result.results) expect(row.ids).toEqual([result.first, result.second]);
  });

  it('retains semantic matches and fills remaining slots with filtered keywords at the work cap', () => {
    for (const duplicate of ['0', '1']) {
      const result = runFixture({ BUDGET_SCENARIO: '1', DUPLICATE_KEYWORD: duplicate });
      for (const row of result.results) {
        expect(row.ids[0]).toBe(result.first);
        expect(row.ids).toHaveLength(2);
        expect([result.second, result.third]).toContain(row.ids[1]);
        expect(new Set(row.ids).size).toBe(row.ids.length);
        expect(row.calls.length).toBeLessThanOrEqual(10);
        expect(row.calls.reduce((total: number, call: { n_results: number }) => total + call.n_results, 0)).toBeLessThanOrEqual(13100);
        expect(row.hydrated.length).toBeLessThanOrEqual(1600);
        expect(new Set(row.hydrated).size).toBe(row.hydrated.length);
      }
    }
  });
});
