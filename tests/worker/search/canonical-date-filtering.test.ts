import { afterEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { SearchManager } from '../../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../src/services/worker/TimelineService.js';
import { ChromaSearchStrategy } from '../../../src/services/worker/search/strategies/ChromaSearchStrategy.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';

const DAY = 86_400_000;
const PROJECT = 'canonical-dates';
const QUERY = 'semantic-only-needle';
const CATEGORIES = ['observations', 'sessions', 'prompts'] as const;
type Dates = { stored: number; indexed: number };
let store: SessionStore;
afterEach(() => store?.close());

function fixture(dates: Dates[], observationsOnly = false) {
  ModeManager.getInstance().loadMode('code');
  store = new SessionStore(':memory:');
  const sid = store.createSDKSession('content', PROJECT, 'ask');
  store.ensureMemorySessionIdRegistered(sid, 'memory');
  const docs: Array<{ id: number; meta: { doc_type: string; created_at_epoch: number; sqlite_id: number; project: string } }> = [];
  store.db.transaction(() => {
    for (const [index, date] of dates.entries()) {
      const observation = store.storeObservation('memory', PROJECT, {
        type: 'discovery', title: `Memory ${index + 1}`, subtitle: null, narrative: 'A paraphrased result',
        facts: [], concepts: [], files_read: [], files_modified: [],
      }, index + 1, 0, date.stored);
      docs.push({ id: observation.id, meta: { sqlite_id: observation.id, doc_type: 'observation', project: PROJECT, created_at_epoch: date.indexed } });
      if (observationsOnly) continue;
      const summary = store.storeSummary('memory', PROJECT, {
        request: `Task ${index + 1}`, investigated: null, learned: null, completed: null, next_steps: null, notes: null,
      }, index + 1, 0, date.stored);
      docs.push({ id: summary.id, meta: { sqlite_id: summary.id, doc_type: 'session_summary', project: PROJECT, created_at_epoch: date.indexed } });
      const promptId = Number(store.db.prepare(`INSERT INTO user_prompts
        (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?)`).run(sid, 'content', index + 1, `Question ${index + 1}`, new Date(date.stored).toISOString(), date.stored).lastInsertRowid);
      docs.push({ id: promptId, meta: { sqlite_id: promptId, doc_type: 'user_prompt', project: PROJECT, created_at_epoch: date.indexed } });
    }
  })();
  // Only vector ranking and its stale date copy are controlled. SQLite row
  // filtering, hydration, paging, fallback and timeline formatting are real.
  const windows: number[] = [];
  const chroma = Object.create(ChromaSync.prototype) as ChromaSync;
  chroma.queryChroma = async (_query, limit, _where, progress) => {
    windows.push(limit);
    const selected = docs.slice(0, limit);
    if (progress) progress.exhausted = docs.length < limit;
    return { ids: selected.map(doc => doc.id), metadatas: selected.map(doc => doc.meta), distances: selected.map((_, index) => index / 1000) };
  };
  const hydrated: number[] = [];
  const getObservations = store.getObservationsByIds.bind(store);
  store.getObservationsByIds = (ids, options) => {
    hydrated.push(...ids);
    return getObservations(ids, options);
  };
  const manager = new SearchManager(new SessionSearch(store.db), store, chroma, new FormattingService(), new TimelineService());
  return { chroma, manager, windows, hydrated };
}

describe('semantic date filtering against current SQLite rows', () => {
  for (const pipeline of ['strategy', 'orchestrator', 'manager'] as const) {
    it(`uses current dates and inclusive explicit bounds through ${pipeline}`, async () => {
      const start = Date.UTC(2020, 5, 1);
      const end = start + DAY;
      const { chroma, manager } = fixture([
        { stored: start - 1, indexed: start },
        { stored: start + 1000, indexed: start - DAY },
        { stored: end + 1, indexed: end },
        { stored: start, indexed: end + DAY },
        { stored: end, indexed: start - DAY },
      ]);
      const args = { query: QUERY, project: PROJECT, dateRange: { start, end }, orderBy: 'relevance' as const, limit: 20 };
      const result = pipeline === 'manager'
        ? await manager.search({ ...args, format: 'json' })
        : pipeline === 'orchestrator'
          ? (await manager.getOrchestrator().search(args)).results
          : (await new ChromaSearchStrategy(chroma, store).search(args)).results;
      for (const category of CATEGORIES) expect(result[category].map((row: { id: number }) => row.id)).toEqual([2, 4, 5]);
    });
  }

  it('uses current dates for the default recency window', async () => {
    const now = Date.now();
    const old = now - 120 * DAY;
    const { chroma } = fixture([{ stored: old, indexed: now }, { stored: now, indexed: old }]);
    const result = await new ChromaSearchStrategy(chroma, store).search({ query: QUERY, project: PROJECT });
    for (const category of CATEGORIES) expect(result.results[category].map(row => row.id)).toEqual([2]);
  });

  it('keeps disabled and explicitly unrestricted date windows', async () => {
    const now = Date.now();
    const old = now - 120 * DAY;
    const { chroma } = fixture([{ stored: old, indexed: now }, { stored: now, indexed: old }]);
    for (const options of [{ ignoreDefaultRecencyWindow: true }, { dateRange: {} }]) {
      const result = await new ChromaSearchStrategy(chroma, store).search({ query: QUERY, project: PROJECT, orderBy: 'relevance', ...options });
      for (const category of CATEGORIES) expect(result.results[category].map(row => row.id)).toEqual([1, 2]);
    }
    const disabled = await new ChromaSearchStrategy(chroma, store, 0).search({ query: QUERY, project: PROJECT, orderBy: 'relevance' });
    for (const category of CATEGORIES) expect(disabled.results[category].map(row => row.id)).toEqual([1, 2]);
  });

  it('widens past stale in-window metadata before applying offset and limit', async () => {
    const now = Date.now();
    const old = now - 120 * DAY;
    const { chroma, windows, hydrated } = fixture([
      { stored: now, indexed: old },
      ...Array.from({ length: 100 }, () => ({ stored: old, indexed: now })),
      { stored: now, indexed: old },
      { stored: now, indexed: old },
    ], true);
    const result = await new ChromaSearchStrategy(chroma, store).search({ query: QUERY, project: PROJECT,
      searchType: 'observations', orderBy: 'relevance', offset: 1, limit: 2 });
    expect(result.results.observations.map(row => row.id)).toEqual([102, 103]);
    expect(windows).toEqual([100, 200]);
    expect(hydrated).toHaveLength(103);
    expect(new Set(hydrated).size).toBe(hydrated.length);
    expect(result.semanticBudgetReached).toBeUndefined();
  });

  it('retains the finite semantic work cap when current dates reject the entire prefix', async () => {
    const now = Date.now();
    const old = now - 120 * DAY;
    const { chroma, windows, hydrated } = fixture([
      ...Array.from({ length: 1600 }, () => ({ stored: old, indexed: now })),
      { stored: now, indexed: old },
    ], true);
    const result = await new ChromaSearchStrategy(chroma, store).search({ query: QUERY, project: PROJECT,
      searchType: 'observations', orderBy: 'relevance', limit: 1 });
    expect(result.results.observations).toEqual([]);
    expect(result.semanticBudgetReached).toBe(true);
    expect(windows).toEqual([100, 200, 400, 800, 1600]);
    expect(hydrated).toHaveLength(1600);
    expect(new Set(hydrated).size).toBe(hydrated.length);
  });

  for (const interactive of [false, true]) {
    it(`applies canonical recency before the timeline anchor limit, interactive=${interactive}`, async () => {
      const now = Date.now();
      const old = now - 120 * DAY;
      const { manager, windows } = fixture([
        { stored: old, indexed: now },
        { stored: now, indexed: old },
        { stored: now, indexed: now },
        { stored: now, indexed: now },
      ], true);
      const result = interactive
        ? await manager.getTimelineByQuery({ query: QUERY, project: PROJECT, mode: 'interactive', limit: 2 })
        : await manager.timeline({ query: QUERY, project: PROJECT });
      const text = result.content[0].text;
      if (interactive) {
        expect([...text.matchAll(/ - ID: (\d+)/g)].map(match => Number(match[1]))).toEqual([2, 3]);
        expect(text).toContain('Found 2 observation(s)');
      } else {
        expect(text).toContain('**Anchor:** Observation #2 - Memory 2');
      }
      expect(windows).toEqual([100]);
    });
  }
});
