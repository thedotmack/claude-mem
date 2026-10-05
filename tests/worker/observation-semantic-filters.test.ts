import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
  import { SearchManager } from './src/services/worker/SearchManager.ts';
  import { SearchRoutes } from './src/services/worker/http/routes/SearchRoutes.ts';
  import { FormattingService } from './src/services/worker/FormattingService.ts';
  import { TimelineService } from './src/services/worker/TimelineService.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  import { ChromaSync } from './src/services/sync/ChromaSync.ts';
  import { ChromaMcpManager } from './src/services/sync/ChromaMcpManager.ts';
  ModeManager.getInstance().loadMode('code');
  const store = new SessionStore(':memory:');
  const sid = store.createSDKSession('host', 'obs-filters', 'ask');
  store.ensureMemorySessionIdRegistered(sid, 'memory');
  const docs = [];
  const make = (title, type, concepts, files_read, epoch) => {
    const id = store.storeObservation('memory', 'obs-filters', { type, title, subtitle: null, narrative: 'nativefilterneedle', facts: [], concepts, files_read, files_modified: [] }, 1, 0, epoch).id;
    for (let fragment = 0; fragment < Number(process.env.FRAGMENT_COUNT || 1); fragment++) {
      docs.push({ id: 'obs_' + id + '_fact_' + fragment, metadata: { doc_type: 'observation', sqlite_id: id, project: 'obs-filters', created_at_epoch: epoch } });
    }
  };
  for (let i = 0; i < Number(process.env.UNRELATED_COUNT || 1); i++) make('UNRELATED_CURRENT_' + i, 'discovery', ['other-concept'], ['src/other.ts'], Date.now());
  const wanted = [
    ['WANTED_CURRENT', 'bugfix', ['target-concept'], ['src/target.ts'], Date.now()],
    ['WANTED_ARCHIVE', 'bugfix', ['archive-concept'], ['src/archive.ts'], Date.UTC(2020, 5, 1)]
  ];
  if (process.env.REVERSE_WANTED_INSERTS === '1') wanted.reverse();
  for (const row of wanted) make(...row);
  const matches = (where, meta) => !where || (where.$and ? where.$and.every(w => matches(w, meta)) : where.$or ? where.$or.some(w => matches(w, meta)) : Object.entries(where).every(([key, value]) => typeof value === 'object' && value.$in ? value.$in.includes(meta[key]) : meta[key] === value));
  const calls = [];
  const hydratedIds = [];
  const nativeHydrate = store.getObservationsByIds.bind(store);
  store.getObservationsByIds = (ids, options) => { hydratedIds.push(...ids); return nativeHydrate(ids, options); };
  ChromaMcpManager.getInstance().callTool = async (tool, args) => {
    if (tool === 'chroma_create_collection') return {};
    if (tool !== 'chroma_query_documents') throw new Error('unexpected tool ' + tool);
    calls.push(args);
    const hits = docs.filter(d => matches(args.where, d.metadata)).slice(0, args.n_results);
    return { ids: [hits.map(d => d.id)], metadatas: [hits.map(d => d.metadata)], distances: [hits.map(() => 0.1)] };
  };
  try {
    const results = [];
    if (process.env.BUDGET_SCENARIO === '1') {
      const manager = new SearchManager(new SessionSearch(store.db), store, new ChromaSync('obs-filters'), new FormattingService(), new TimelineService());
      const handlers = new Map();
      new SearchRoutes(manager).setupRoutes({ use() {}, get(path, handler) { handlers.set(path, handler); }, post() {} });
      const body = await new Promise((resolve, reject) => {
        const res = { headersSent: false, locals: {}, status() { return res; }, json(body) { resolve(body); return res; } };
        handlers.get('/api/search/observations')({ path: '/api/search/observations', query: { query: 'nativefilterneedle', project: 'obs-filters', limit: '1', concepts: 'target-concept' }, body: {}, get() {} }, res, reject);
      });
      console.log(JSON.stringify({ text: body.content[0].text, calls, hydratedIds }));
      process.exit(0);
    }
    for (const chroma of [null, new ChromaSync('obs-filters')]) {
      const manager = new SearchManager(new SessionSearch(store.db), store, chroma, new FormattingService(), new TimelineService());
      const handlers = new Map();
      new SearchRoutes(manager).setupRoutes({ use() {}, get(path, handler) { handlers.set(path, handler); }, post() {} });
      for (const filter of [{ type: 'bugfix' }, { concepts: 'target-concept' }, { files: 'src/target.ts' }, { date_from: '2020-01-01', date_to: '2020-12-31' }, { concepts: 'never-matching' }]) {
        const query = { query: chroma ? 'semantic external request' : 'nativefilterneedle', project: 'obs-filters', limit: '1', ...filter };
        const body = await new Promise((resolve, reject) => {
          const res = { headersSent: false, locals: {}, status() { return res; }, json(body) { resolve(body); return res; } };
          handlers.get('/api/search/observations')({ path: '/api/search/observations', query, body: {}, get() {} }, res, reject);
        });
        results.push({ semantic: !!chroma, filter, text: body.content[0].text });
      }
    }
    console.log(JSON.stringify({ results, calls }));
  } finally { store.close(); }
`;

function runFixture(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'observation-filters-'));
  try {
    const run = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../..'), env: { ...process.env, ...extraEnv, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe',
    });
    if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
    return JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function expectFilteredResults(results: any[]) {
  for (const entry of results) {
    expect(entry.text, JSON.stringify(entry.filter)).not.toContain('UNRELATED_CURRENT');
    if (entry.filter.concepts === 'never-matching') {
      expect(entry.text).toContain('No observations found');
    } else if (entry.filter.date_from) {
      expect(entry.text).toContain('WANTED_ARCHIVE');
      expect(entry.text).not.toContain('WANTED_CURRENT');
    } else if (entry.filter.type && !entry.semantic) {
      // Both bugfix rows have equal FTS rank. Either is valid at limit=1.
      expect(entry.text.match(/WANTED_(CURRENT|ARCHIVE)/g)).toHaveLength(1);
    } else {
      expect(entry.text).toContain('WANTED_CURRENT');
      expect(entry.text).not.toContain('WANTED_ARCHIVE');
    }
  }
}

describe('observation endpoint semantic row filters', () => {
  it('bounds raw semantic work, hydrates each ID once and uses filtered keyword fallback', () => {
    for (const fragments of ['1', '5']) {
      const result = runFixture({ BUDGET_SCENARIO: '1', UNRELATED_COUNT: '8192', FRAGMENT_COUNT: fragments });
      expect(result.text).toContain('WANTED_CURRENT');
      expect(result.text).not.toContain('UNRELATED_CURRENT');
      expect(result.calls.length).toBeLessThanOrEqual(10);
      expect(result.calls.reduce((total: number, call: any) => total + call.n_results, 0)).toBeLessThanOrEqual(13100);
      expect(result.hydratedIds.length).toBeLessThanOrEqual(1600);
      expect(new Set(result.hydratedIds).size).toBe(result.hydratedIds.length);
    }
  });
  it('applies filters on both production paths without depending on a tied FTS winner', () => {
    for (const reversed of ['0', '1']) expectFilteredResults(runFixture({ REVERSE_WANTED_INSERTS: reversed }).results);
  });

  it('retrieves qualifying semantic rows beyond 100 candidates, including fragmented documents, and stops on exhaustion', () => {
    for (const [unrelated, fragments] of [['100', '1'], ['100', '5'], ['550', '1']]) {
      const result = runFixture({ UNRELATED_COUNT: unrelated, FRAGMENT_COUNT: fragments });
      expectFilteredResults(result.results);
      expect(result.calls.some((call: { n_results: number; where?: unknown }) => call.where && call.n_results > 100)).toBe(true);
      expect(result.calls.length).toBeLessThan(40);
    }
  });
});
