import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { SearchManager } from '../../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../src/services/worker/TimelineService.js';
import { SearchRoutes } from '../../../src/services/worker/http/routes/SearchRoutes.js';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';
import { ChromaSearchStrategy } from '../../../src/services/worker/search/strategies/ChromaSearchStrategy.js';
import { SEARCH_CATEGORIES } from '../../../src/services/worker/search/types.js';

let store: SessionStore;
afterEach(() => store?.close());

function fixture({ count = 8, ranking = Array.from({ length: count }, (_, index) => index + 1), ties = false } = {}) {
  store = new SessionStore(':memory:');
  const sessionId = store.createSDKSession('content', 'auth-service', 'Authentication');
  store.ensureMemorySessionIdRegistered(sessionId, 'memory');
  const epoch = Date.now();
  for (let n = 1; n <= count; n++) {
    const timestamp = ties ? epoch : epoch - n * 1000;
    store.storeObservation('memory', 'auth-service', {
      type: n % 2 ? 'bugfix' : 'discovery', title: `Authentication fix ${n}`, subtitle: null,
      narrative: 'Token renewal preserves active sessions', facts: [],
      concepts: n % 2 ? ['problem-solution'] : [], files_read: n % 2 ? ['src/auth.ts'] : [], files_modified: [],
    }, n, 0, timestamp);
    store.storeSummary('memory', 'auth-service', {
      request: `Authentication task ${n}`, investigated: null, learned: null,
      completed: null, next_steps: null, notes: null,
    }, n, 0, timestamp);
    store.db.prepare(`INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)`).run(sessionId, 'content', n, `Authentication question ${n}`, new Date(timestamp).toISOString(), timestamp);
  }
  // Only vector ranking is controlled; filtering, hydration, union and paging use real SQLite.
  const chroma = Object.create(ChromaSync.prototype) as ChromaSync;
  chroma.queryChroma = async () => ({
    ids: ranking.flatMap(id => [id, id, id]),
    distances: ranking.flatMap((_, index) => [index / 10, index / 10, index / 10]),
    metadatas: ranking.flatMap(id => ['observation', 'session_summary', 'user_prompt'].map(doc_type => ({
      sqlite_id: id, doc_type, project: 'auth-service', platform_source: 'claude',
      created_at_epoch: ties ? epoch : epoch - id * 1000,
    }))),
  });
  const sqlite = new SessionSearch(store.db);
  const manager = (vector: ChromaSync | null = chroma) => new SearchManager(sqlite, store, vector, new FormattingService(), new TimelineService());
  return { chroma, manager, orchestrator: new SearchOrchestrator(sqlite, store, chroma) };
}

async function withSearchRoute(manager: SearchManager, check: (url: string) => Promise<void>) {
  const app = express();
  new SearchRoutes(manager).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No owned HTTP address');
  try {
    await check(`http://127.0.0.1:${address.port}/api/search`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('semantic memory pagination', () => {
  for (const category of SEARCH_CATEGORIES) {
    it(`pages ${category} through SearchManager without repeating the first page`, async () => {
      const { manager } = fixture();
      for (const offset of [0, 2, 6, 8]) {
        const result = await manager().search({ query: 'Authentication', type: category, project: 'auth-service', format: 'json', limit: 2, offset });
        expect(result[category].map((row: { id: number }) => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].slice(offset, offset + 2));
      }
    });

    it(`pages ${category} through the orchestrator after empty-category supplementation`, async () => {
      const { orchestrator } = fixture();
      for (const offset of [0, 2, 6, 8]) {
        const result = await orchestrator.search({ query: 'Authentication', searchType: category, project: 'auth-service', limit: 2, offset });
        expect(result.results[category].map(row => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].slice(offset, offset + 2));
      }
    });
  }

  for (const orderBy of ['date_asc', 'date_desc'] as const) {
    for (const category of ['sessions', 'prompts'] as const) {
      it(`pages semantic-only ${category} with tied timestamps in ${orderBy}`, async () => {
        const { chroma, manager, orchestrator } = fixture({ count: 4, ties: true });
        const ordered = orderBy === 'date_asc' ? [1, 2, 3, 4] : [4, 3, 2, 1];
        const args = { query: 'SemanticOnly', project: 'auth-service', orderBy, limit: 2 };
        for (const offset of [0, 2, 4]) {
          const expected = ordered.slice(offset, offset + 2);
          const unified = await manager().search({ ...args, type: category, format: 'json', offset });
          expect(unified[category].map((row: { id: number }) => row.id)).toEqual(expected);
          const pipeline = await orchestrator.search({ ...args, searchType: category, offset });
          expect(pipeline.results[category].map(row => row.id)).toEqual(expected);
          const direct = await new ChromaSearchStrategy(chroma, store).search({ ...args, searchType: category, offset });
          expect(direct.results[category].map(row => row.id)).toEqual(expected);
        }
      });
    }

    for (const ties of [false, true]) {
      it(`pages the deduplicated semantic/keyword union in ${orderBy}, timestamp ties=${ties}`, async () => {
        const { manager } = fixture({ ranking: [1, 3], ties });
        const ascending = ties ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
        const ordered = orderBy === 'date_asc' ? ascending : [...ascending].reverse();
        for (const offset of [0, 2, 6, 8]) {
          const result = await manager().search({ query: 'Authentication', project: 'auth-service', format: 'json', orderBy, limit: 2, offset });
          for (const category of SEARCH_CATEGORIES) expect(result[category].map((row: { id: number }) => row.id)).toEqual(ordered.slice(offset, offset + 2));
        }
      });
    }
  }

  for (const category of SEARCH_CATEGORIES) {
    it(`pages keyword-only ${category} through HTTP when limit is omitted`, async () => {
      const { manager } = fixture({ count: 30, ranking: [] });
      const keyword = await manager(null).search({ query: 'Authentication', project: 'auth-service', type: category, format: 'json', orderBy: 'relevance', limit: 30 });
      const ordered = keyword[category].map((row: { id: number }) => row.id);
      expect(ordered).toHaveLength(30);
      await withSearchRoute(manager(), async url => {
        for (const offset of [0, 20, 30]) {
          const query = new URLSearchParams({ query: 'Authentication', project: 'auth-service', type: category, format: 'json', orderBy: 'relevance', offset: String(offset) });
          const response = await fetch(`${url}?${query}`);
          expect(response.status).toBe(200);
          const result = await response.json() as Record<string, Array<{ id: number }>>;
          expect(result[category].map(row => row.id)).toEqual(ordered.slice(offset, offset + 20));
        }
      });
    });

    it(`pages keyword-filled categories beside semantic ${category} when limit is omitted`, async () => {
      const { chroma, manager } = fixture({ count: 30 });
      const queryChroma = chroma.queryChroma;
      const docType = { observations: 'observation', sessions: 'session_summary', prompts: 'user_prompt' }[category];
      chroma.queryChroma = async (...args) => {
        const result = await queryChroma(...args);
        const indexes = result.metadatas.flatMap((metadata, index) => metadata?.doc_type === docType ? [index] : []);
        return {
          ids: indexes.map(index => result.ids[index]),
          distances: indexes.map(index => result.distances[index]),
          metadatas: indexes.map(index => result.metadatas[index]),
        };
      };
      const ordered = Array.from({ length: 30 }, (_, index) => index + 1);
      const keyword = await manager(null).search({ query: 'Authentication', project: 'auth-service', format: 'json', orderBy: 'relevance', limit: 30 });
      for (const requested of SEARCH_CATEGORIES) expect(keyword[requested]).toHaveLength(30);
      for (const offset of [0, 20, 30]) {
        const result = await manager().search({ query: 'Authentication', project: 'auth-service', format: 'json', orderBy: 'relevance', offset });
        for (const requested of SEARCH_CATEGORIES) {
          // Omitted-limit semantic results keep their existing candidate budget.
          const expected = requested === category ? ordered.slice(offset) : keyword[requested].map((row: { id: number }) => row.id).slice(offset, offset + 20);
          expect(result[requested].map((row: { id: number }) => row.id)).toEqual(expected);
        }
      }
    });
  }

  it('applies observation filters before the page boundary', async () => {
    const { manager, orchestrator } = fixture();
    const args = { query: 'Authentication', project: 'auth-service', obs_type: 'bugfix', concepts: 'problem-solution', files: 'src/auth.ts', limit: 2, offset: 2 };
    const unified = await manager().search({ ...args, type: 'observations', format: 'json' });
    expect(unified.observations.map((row: { id: number }) => row.id)).toEqual([5, 7]);
    const pipeline = await orchestrator.search({ ...args, searchType: 'observations' });
    expect(pipeline.results.observations.map(row => row.id)).toEqual([5, 7]);
  });

  it('keeps relevance order and does not refill an exhausted semantic page with keyword hits', async () => {
    const { manager, orchestrator } = fixture({ ranking: [5, 1, 7, 3] });
    const args = { query: 'Authentication', project: 'auth-service', limit: 2, offset: 2, orderBy: 'relevance' };
    const unified = await manager().search({ ...args, type: 'observations', format: 'json' });
    expect(unified.observations.map((row: { id: number }) => row.id)).toEqual([7, 3]);
    const pipeline = await orchestrator.search({ ...args, offset: 4 });
    for (const category of SEARCH_CATEGORIES) expect(pipeline.results[category]).toEqual([]);
    const exhausted = await manager().search({ ...args, offset: 4, format: 'json' });
    for (const category of SEARCH_CATEGORIES) expect(exhausted[category]).toEqual([]);
  });

  it('supports the standalone Chroma strategy and retains category supplementation', async () => {
    const { chroma, orchestrator } = fixture();
    const args = { query: 'Authentication', project: 'auth-service', limit: 2, offset: 2 };
    const direct = await new ChromaSearchStrategy(chroma, store).search(args);
    for (const category of SEARCH_CATEGORIES) expect(direct.results[category].map(row => row.id)).toEqual([3, 4]);
    chroma.queryChroma = async () => ({ ids: [1, 2, 3, 4], distances: [0.1, 0.2, 0.3, 0.4], metadatas: [1, 2, 3, 4].map(id => ({
      sqlite_id: id, doc_type: 'observation', created_at_epoch: Date.now(),
    })) });
    const supplemented = await orchestrator.search(args);
    expect(supplemented.strategy).toBe('hybrid');
    for (const category of SEARCH_CATEGORIES) expect(supplemented.results[category].map(row => row.id)).toEqual([3, 4]);
  });

  it('retains SQLite-only and Chroma-error pagination', async () => {
    const { chroma, manager } = fixture();
    const args = { query: 'Authentication', project: 'auth-service', format: 'json', limit: 2, offset: 2, orderBy: 'date_desc' };
    for (const category of SEARCH_CATEGORIES) {
      const result = await manager(null).search({ ...args, type: category });
      expect(result[category].map((row: { id: number }) => row.id)).toEqual([3, 4]);
    }
    chroma.queryChroma = async () => { throw new Error('Controlled vector outage'); };
    const result = await manager().search(args);
    for (const category of SEARCH_CATEGORIES) expect(result[category].map((row: { id: number }) => row.id)).toEqual([3, 4]);
  });

  it('honors string limit/offset through the real HTTP search route', async () => {
    const { manager } = fixture();
    await withSearchRoute(manager(), async url => {
      for (const offset of [0, 2, 8]) {
        const query = new URLSearchParams({ query: 'Authentication', project: 'auth-service', type: 'observations', format: 'json', limit: '2', offset: String(offset) });
        const response = await fetch(`${url}?${query}`);
        expect(response.status).toBe(200);
        const result = await response.json() as { observations: Array<{ id: number }> };
        expect(result.observations.map(row => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].slice(offset, offset + 2));
      }
    });
  });
});
