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
  import { ChromaSearchStrategy } from './src/services/worker/search/strategies/ChromaSearchStrategy.ts';
  const store = new SessionStore(':memory:');
  const sid = store.createSDKSession('content', 'filtered', 'ask');
  store.ensureMemorySessionIdRegistered(sid, 'memory');
  const now = Date.now();
  const field = process.env.FILTER_FIELD;
  const cap = process.env.BUDGET_SCENARIO === '1';
  const sparseCategory = process.env.SPARSE_CATEGORY;
  const categories = ['observations', 'sessions', 'prompts'];
  const wanted = { observations: [], sessions: [], prompts: [] };
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
  const makeCategory = (category, keyword = false) => {
    const n = wanted[category].length + 1;
    let id;
    if (category === 'observations') id = make('Eligible observation ' + n, true, keyword);
    else {
      id = category === 'sessions'
        ? store.storeSummary('memory', 'filtered', { request: 'Eligible summary ' + n,
          investigated: null, learned: null, completed: keyword ? 'retrievalneedle' : 'A semantic paraphrase',
          next_steps: null, notes: null }, n, 0, now).id
        : Number(store.db.prepare('INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?)')
          .run(sid, 'content', n, keyword ? 'retrievalneedle' : 'Eligible question ' + n, new Date(now).toISOString(), now).lastInsertRowid);
      docs.push({ id: category === 'sessions' ? 'summary_' + id + '_request' : 'prompt_' + id, metadata: { sqlite_id: id,
        doc_type: category === 'sessions' ? 'session_summary' : 'user_prompt',
        project: 'filtered', created_at_epoch: now } });
    }
    wanted[category].push(id);
    return id;
  };
  // Just past the 1600-candidate semantic work cap: enough to reach the cap, small
  // enough that three cap-scenario fixtures stay well inside the default test timeout.
  const excludedCount = cap ? 2048 : 140;
  let first, second, third;
  if (sparseCategory) {
    // Each table starts at ID 1. Full categories must not hide the sparse
    // category, and hydration caches must keep their identities distinct.
    for (const category of categories) makeCategory(category);
    for (let n = 1; n < Number(process.env.FULL_CATEGORY_COUNT || 25); n++) {
      for (const category of categories) if (category !== sparseCategory) makeCategory(category);
    }
    for (let n = 0; n < excludedCount; n++) make('Excluded ' + n, false, false, true);
    for (let n = 1; n < 25; n++) makeCategory(sparseCategory, cap);
  } else {
    // The partial-page fallback must not reintroduce an expired keyword match.
    if (cap) make('Expired keyword match', true, true, true);
    first = make('First semantic match', true, process.env.DUPLICATE_KEYWORD === '1');
    for (let i = 0; i < excludedCount; i++) make('Excluded ' + i, false);
    second = make('Second matching memory', true, cap);
    third = make('Third matching memory', true, cap);
  }
  const matches = (where, meta) => !where || (where.$and ? where.$and.every(w => matches(w, meta))
    : where.$or ? where.$or.some(w => matches(w, meta))
    : Object.entries(where).every(([key, value]) => typeof value === 'object' && value.$in ? value.$in.includes(meta[key]) : meta[key] === value));
  const calls = [];
  const hydrated = [];
  const hydratedByCategory = { observations: hydrated, sessions: [], prompts: [] };
  for (const [category, method] of [['observations', 'getObservationsByIds'], ['sessions', 'getSessionSummariesByIds'], ['prompts', 'getUserPromptsByIds']]) {
    const nativeHydrate = store[method].bind(store);
    store[method] = (ids, options) => { hydratedByCategory[category].push(...ids); return nativeHydrate(ids, options); };
  }
  ChromaMcpManager.getInstance().callTool = async (name, args) => {
    if (name === 'chroma_create_collection') return {};
    if (name !== 'chroma_query_documents') throw new Error('Unexpected tool ' + name);
    calls.push(args);
    const hits = docs.filter(d => matches(args.where, d.metadata)).slice(0, args.n_results);
    return { ids: [hits.map(d => d.id)], metadatas: [hits.map(d => d.metadata)], distances: [hits.map(() => 0.1)] };
  };
  const chroma = new ChromaSync('filtered');
  const windows = [];
  const queryChroma = chroma.queryChroma.bind(chroma);
  chroma.queryChroma = (...args) => { windows.push(args[1]); return queryChroma(...args); };
  const manager = new SearchManager(new SessionSearch(store.db), store, chroma, new FormattingService(), new TimelineService());
  const filter = field === 'dateRange' ? { dateStart: new Date(now - 86400000).toISOString() }
    : field === 'obs_type' || cap ? { obs_type: 'decision' }
    : field === 'concepts' ? { concepts: 'target' }
    : field === 'files' ? { files: 'src/target.ts' } : {};
  const args = { query: 'retrievalneedle', project: 'filtered', type: process.env.SEARCH_TYPE || (sparseCategory ? 'all' : 'observations'),
    orderBy: 'relevance', limit: process.env.LIMIT || (sparseCategory ? '20' : '2'), offset: process.env.OFFSET || '0', ...filter };
  if (process.env.SEARCH_TYPE === 'default') delete args.type;
  const app = express(); new SearchRoutes(manager).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    const results = [];
    for (const pipeline of ['http', 'orchestrator', ...(sparseCategory ? ['strategy'] : [])]) {
      calls.length = 0; windows.length = 0;
      for (const ids of Object.values(hydratedByCategory)) ids.length = 0;
      const result = pipeline === 'http'
        ? await (await fetch('http://127.0.0.1:' + server.address().port + '/api/search?' + new URLSearchParams({ ...args, format: 'json' }))).json()
        : pipeline === 'orchestrator' ? await manager.getOrchestrator().search(args)
        : await new ChromaSearchStrategy(chroma, store).search({ ...args,
          searchType: args.type?.includes(',') ? args.type.split(',') : args.type,
          limit: Number(args.limit), offset: Number(args.offset) });
      const body = pipeline === 'http' ? result : result.results;
      const allIds = Object.fromEntries(categories.map(category => [category, body[category].map(row => row.id)]));
      results.push({ pipeline, ids: allIds.observations, allIds, calls: [...calls], windows: [...windows],
        hydrated: [...hydrated], hydratedByCategory: structuredClone(hydratedByCategory), budgetReached: result.semanticBudgetReached });
    }
    console.log(JSON.stringify({ first, second, third, wanted, results }));
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

// Work-cap tests spawn several fixtures that each seed past the 1600-candidate cap;
// slower CI runners need more than bun's 5s default.
const WORK_CAP_TEST_TIMEOUT_MS = 20_000;

describe('unified semantic candidates after row filtering', () => {
  for (const sparseCategory of ['observations', 'sessions', 'prompts']) {
    it(`fills all-category pages when ${sparseCategory} are sparse in the initial prefix`, () => {
      const result = runFixture({ SPARSE_CATEGORY: sparseCategory });
      for (const row of result.results) {
        for (const category of ['observations', 'sessions', 'prompts']) {
          expect(row.allIds[category], row.pipeline + ':' + category).toEqual(result.wanted[category].slice(0, 20));
          expect(new Set(row.hydratedByCategory[category]).size).toBe(row.hydratedByCategory[category].length);
        }
        expect(row.calls.length).toBeLessThanOrEqual(10);
      }
    });
  }

  it('fills each category through offset + limit before paging', () => {
    const result = runFixture({ SPARSE_CATEGORY: 'observations', OFFSET: '19', LIMIT: '2' });
    for (const row of result.results) {
      for (const category of ['observations', 'sessions', 'prompts']) expect(row.allIds[category]).toEqual(result.wanted[category].slice(19, 21));
    }
  });

  it('fills partial category pages at the work cap while preserving semantic matches', () => {
    for (const sparseCategory of ['observations', 'sessions', 'prompts']) {
      const result = runFixture({ SPARSE_CATEGORY: sparseCategory, BUDGET_SCENARIO: '1' });
      for (const row of result.results) {
        expect(row.allIds[sparseCategory][0]).toBe(result.wanted[sparseCategory][0]);
        expect(row.allIds[sparseCategory]).toHaveLength(row.pipeline === 'strategy' ? 1 : 20);
        if (row.pipeline === 'strategy') expect(row.budgetReached).toBe(true);
        for (const category of ['observations', 'sessions', 'prompts']) {
          expect(row.allIds[category].every((id: number) => result.wanted[category].includes(id))).toBe(true);
          expect(new Set(row.allIds[category]).size).toBe(row.allIds[category].length);
        }
        expect(row.calls.length).toBeLessThanOrEqual(10);
        expect(row.calls.reduce((total: number, call: { n_results: number }) => total + call.n_results, 0)).toBeLessThanOrEqual(13100);
      }
    }
  }, WORK_CAP_TEST_TIMEOUT_MS);

  it('ignores unrequested categories when their selected pages are full', () => {
    const result = runFixture({ SPARSE_CATEGORY: 'sessions', SEARCH_TYPE: 'observations,prompts', FULL_CATEGORY_COUNT: '200' });
    for (const row of result.results) {
      expect(row.allIds.sessions).toEqual([]);
      expect(row.allIds.observations).toEqual(result.wanted.observations.slice(0, 20));
      expect(row.allIds.prompts).toEqual(result.wanted.prompts.slice(0, 20));
      expect(row.windows).toEqual([100]);
    }
  });

  it('fills partial pages for the default all-category selection', () => {
    const result = runFixture({ SPARSE_CATEGORY: 'prompts', SEARCH_TYPE: 'default' });
    for (const row of result.results) expect(row.allIds.prompts).toEqual(result.wanted.prompts.slice(0, 20));
  });

  it('checks both categories of an explicit multi-category selection', () => {
    for (const sparseCategory of ['observations', 'prompts']) {
      const result = runFixture({ SPARSE_CATEGORY: sparseCategory, SEARCH_TYPE: 'observations,prompts' });
      for (const row of result.results) {
        expect(row.allIds.sessions).toEqual([]);
        for (const category of ['observations', 'prompts']) expect(row.allIds[category]).toEqual(result.wanted[category].slice(0, 20));
      }
    }
  });

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
  }, WORK_CAP_TEST_TIMEOUT_MS);
});
