import { describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { ChromaSync } from '../../src/services/sync/ChromaSync.js';
import { ChromaMcpManager } from '../../src/services/sync/ChromaMcpManager.js';

async function runFixture(options: Record<string, string> = {}): Promise<any> {
  const mode = ModeManager.getInstance() as any;
  const previousMode = mode.activeMode;
  const previousModeId = mode.activeModeId;
  const chromaMcp = ChromaMcpManager.getInstance();
  const originalCallTool = chromaMcp.callTool;
  const store = new SessionStore(':memory:');
  const originalHydrate = store.getObservationsByIds;
  try {
    mode.loadMode('code');
    const sid = store.createSDKSession('host', 'obs-filters', 'ask');
    store.ensureMemorySessionIdRegistered(sid, 'memory');
    const docs: Array<{ id: string; metadata: Record<string, unknown> }> = [];
    const partial = options.PARTIAL_SCENARIO === '1';
    const make = (title: string, type: string, concepts: string[], files_read: string[], epoch: number) => {
      const id = store.storeObservation('memory', 'obs-filters', { type, title, subtitle: null,
        narrative: partial && options.PARTIAL_DUPLICATE !== '1' && title === 'WANTED_SEMANTIC' ? 'meaning without literal query' : 'nativefilterneedle',
        facts: [], concepts, files_read, files_modified: [] }, 1, 0, epoch).id;
      for (let fragment = 0; fragment < Number(options.FRAGMENT_COUNT || 1); fragment++) {
        docs.push({ id: 'obs_' + id + '_fact_' + fragment, metadata: { doc_type: 'observation', sqlite_id: id, project: 'obs-filters', created_at_epoch: epoch } });
      }
    };
    if (partial) make('WANTED_SEMANTIC', 'bugfix', ['target-concept'], ['src/target.ts'], Date.now());
    for (let i = 0; i < Number(options.UNRELATED_COUNT || 1); i++) make('UNRELATED_CURRENT_' + i, 'discovery', ['other-concept'], ['src/other.ts'], Date.now());
    const wanted: Parameters<typeof make>[] = [
      ['WANTED_CURRENT', 'bugfix', ['target-concept'], ['src/target.ts'], Date.now()],
      ['WANTED_ARCHIVE', 'bugfix', ['archive-concept'], ['src/archive.ts'], Date.UTC(2020, 5, 1)]
    ];
    if (options.REVERSE_WANTED_INSERTS === '1') wanted.reverse();
    for (const row of wanted) make(...row);
    const matches = (where: any, meta: Record<string, unknown>): boolean => !where || (where.$and
      ? where.$and.every((w: any) => matches(w, meta)) : where.$or
        ? where.$or.some((w: any) => matches(w, meta))
        : Object.entries(where).every(([key, value]: [string, any]) => value && typeof value === 'object' && value.$in ? value.$in.includes(meta[key]) : meta[key] === value));
    const calls: any[] = [];
    const hydratedIds: number[] = [];
    store.getObservationsByIds = (ids, options) => {
      hydratedIds.push(...ids);
      return originalHydrate.call(store, ids, options);
    };
    chromaMcp.callTool = async (tool, args) => {
      if (tool === 'chroma_create_collection') return {};
      if (tool !== 'chroma_query_documents') throw new Error('unexpected tool ' + tool);
      calls.push(args);
      const hits = docs.filter(d => matches(args.where, d.metadata)).slice(0, Number(args.n_results));
      return { ids: [hits.map(d => d.id)], metadatas: [hits.map(d => d.metadata)], distances: [hits.map(() => 0.1)] };
    };
    const handlersFor = (chroma: ChromaSync | null) => {
      const manager = new SearchManager(new SessionSearch(store.db), store, chroma, new FormattingService(), new TimelineService());
      const handlers = new Map<string, any>();
      new SearchRoutes(manager).setupRoutes({ use() {}, get(path: string, handler: unknown) { handlers.set(path, handler); }, post() {} } as any);
      return handlers;
    };
    const search = (handlers: Map<string, any>, query: Record<string, string>): Promise<any> => new Promise((resolve, reject) => {
      const res = { headersSent: false, locals: {}, status() { return res; }, json(body: unknown) { resolve(body); return res; } };
      handlers.get('/api/search/observations')({ path: '/api/search/observations', query, body: {}, get() {} }, res, reject);
    });
    if (options.BUDGET_SCENARIO === '1' || partial) {
      const body = await search(handlersFor(new ChromaSync('obs-filters')), {
        query: 'nativefilterneedle', project: 'obs-filters', limit: partial ? '2' : '1', concepts: 'target-concept'
      });
      return { text: body.content[0].text, calls, hydratedIds };
    }
    const results = [];
    for (const chroma of [null, new ChromaSync('obs-filters')]) {
      const handlers = handlersFor(chroma);
      const filters: Record<string, string>[] = [{ type: 'bugfix' }, { concepts: 'target-concept' }, { files: 'src/target.ts' },
        { date_from: '2020-01-01', date_to: '2020-12-31' }, { concepts: 'never-matching' }];
      for (const filter of filters) {
        const body = await search(handlers, { query: chroma ? 'semantic external request' : 'nativefilterneedle', project: 'obs-filters', limit: '1', ...filter });
        results.push({ semantic: !!chroma, filter, text: body.content[0].text });
      }
    }
    return { results, calls };
  } finally {
    chromaMcp.callTool = originalCallTool;
    store.getObservationsByIds = originalHydrate;
    mode.activeMode = previousMode;
    mode.activeModeId = previousModeId;
    store.close();
  }
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
  it.each(['0', '1'])('keeps partial semantic matches while keyword fallback fills the remaining limit (duplicate=%s)', async (duplicate) => {
    const result = await runFixture({ PARTIAL_SCENARIO: '1', PARTIAL_DUPLICATE: duplicate, UNRELATED_COUNT: '2700' });
    expect(result.text).toContain('WANTED_SEMANTIC');
    expect(result.text).toContain('WANTED_CURRENT');
    expect(result.text).toContain('Found 2 observation(s)');
    expect(result.text).not.toContain('UNRELATED_CURRENT');
    expect(result.calls.length).toBeLessThanOrEqual(10);
    expect(result.hydratedIds.length).toBeLessThanOrEqual(1600);
    expect(result.text.match(/WANTED_SEMANTIC/g)).toHaveLength(1);
  });
  it.each(['1', '5'])('bounds raw semantic work, hydrates each ID once and uses filtered keyword fallback (fragments=%s)', async (fragments) => {
    const result = await runFixture({ BUDGET_SCENARIO: '1', UNRELATED_COUNT: '2700', FRAGMENT_COUNT: fragments });
    expect(result.text).toContain('WANTED_CURRENT');
    expect(result.text).not.toContain('UNRELATED_CURRENT');
    expect(result.calls.length).toBeLessThanOrEqual(10);
    expect(result.calls.reduce((total: number, call: any) => total + call.n_results, 0)).toBeLessThanOrEqual(13100);
    expect(result.hydratedIds.length).toBeLessThanOrEqual(1600);
    expect(new Set(result.hydratedIds).size).toBe(result.hydratedIds.length);
  });
  it('applies filters on both production paths without depending on a tied FTS winner', async () => {
    for (const reversed of ['0', '1']) expectFilteredResults((await runFixture({ REVERSE_WANTED_INSERTS: reversed })).results);
  });

  it('retrieves qualifying semantic rows beyond 100 candidates, including fragmented documents, and stops on exhaustion', async () => {
    for (const [unrelated, fragments] of [['100', '1'], ['100', '5'], ['550', '1']]) {
      const result = await runFixture({ UNRELATED_COUNT: unrelated, FRAGMENT_COUNT: fragments });
      expectFilteredResults(result.results);
      expect(result.calls.some((call: { n_results: number; where?: unknown }) => call.where && call.n_results > 100)).toBe(true);
      expect(result.calls.length).toBeLessThan(40);
    }
  });
});
