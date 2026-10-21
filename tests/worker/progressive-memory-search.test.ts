import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { ProgressiveMemorySearch } from '../../src/services/worker/ProgressiveMemorySearch.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';
import { progressiveSearchToolResult, PROGRESSIVE_RESPONSE_BYTES } from '../../src/shared/progressive-search.js';

describe('worker Dumb search with real SQLite fixtures', () => {
  let db: Database;
  let store: SessionStore;
  let manager: SearchManager;
  let progressive: ProgressiveMemorySearch;
  let authId: string;
  let unrelatedId: string;
  const project = 'progressive-fixture';
  const epoch = Date.UTC(2026, 9, 8, 12, 0, 0);

  function seed(target: string, title: string, narrative: string, timestamp: number): string {
    const memory = store.getOrCreateManualSession(target);
    return String(store.storeObservation(memory, target, {
      type: 'decision', title, subtitle: null, narrative, facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, timestamp).id);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SessionStore(db);
    manager = new SearchManager(new SessionSearch(db), store, null, new FormattingService(), new TimelineService());
    progressive = new ProgressiveMemorySearch(manager, store);
    seed(project, 'Authentication retry context', 'PRIVATE_CONTEXT_BODY', epoch - 1000);
    authId = seed(project, 'Authentication expiry fixed', 'PRIVATE_AUTH_BODY ' + '😀'.repeat(10_000), epoch);
    seed(project, 'Authentication tied sibling', 'PRIVATE_TIED_BODY', epoch);
    seed(project, 'Unrelated gardening', 'PRIVATE_GARDEN_BODY', epoch + 1000);
    unrelatedId = seed('another-project', 'Authentication elsewhere', 'PRIVATE_OTHER_BODY', epoch);
  });

  afterEach(() => db.close());

  it('performs bounded index, context and a selected fetch in one call', async () => {
    const response = await progressive.run({ query: 'authentication', project, limit: 8, maxDetails: 2 });
    expect(response.step).toBe(3);
    expect(response.trace.map(row => row.operation)).toEqual(['search', 'timeline', 'fetch']);
    expect(response.observations.length).toBeLessThanOrEqual(2);
    expect(response.observations.every(row => row.project === project)).toBe(true);
    expect(response.observations.some(row => row.content.includes('PRIVATE_OTHER_BODY'))).toBe(false);
  });

  it('uses the stored matching project for timeline context across checkout aliases', async () => {
    const response = await progressive.run({ query: 'authentication', project: 'checkout-new' }, ['checkout-new', project]);
    expect(response.trace.map(row => row.operation)).toEqual(['search', 'timeline', 'fetch']);
    expect(response.observations.length).toBeGreaterThan(0);
    expect(response.observations.every(row => row.project === project)).toBe(true);
  });

  it('keeps a strongly matching summary when observations fill their entire candidate budget', async () => {
    const memory = store.getOrCreateManualSession(project);
    const summary = store.storeSummary(memory, project, {
      request: 'Authentication token expiry', investigated: 'SUMMARY_DETAIL', learned: '', completed: '', next_steps: '', notes: null,
    }, 1, 0, epoch).id;
    const weak = Array.from({ length: 20 }, (_, i) => {
      const id = seed(project, `Authentication generic item ${i}`, 'WEAK_OBSERVATION', epoch - 1000 - i);
      return store.getObservationById(Number(id))!;
    });
    const summaryRow = store.getSessionSummariesByIds([summary])[0];
    const adapterManager = { search: async () => ({ observations: weak, sessions: [summaryRow], prompts: [] }) } as unknown as SearchManager;
    const adapter = new ProgressiveMemorySearch(adapterManager, store);
    const result = await adapter.run({ query: 'Authentication token expiry', project, limit: 20, maxDetails: 1 });
    expect(result.observations[0].id).toBe(`S${summary}`);
    expect(result.observations[0].content).toContain('SUMMARY_DETAIL');
  });

  it('reranks semantic candidates beyond the requested limit before cutting the index (#4865)', async () => {
    const target = 'candidate-limit-fixture';
    const query = 'Authentication token expiry correction';
    const recent = Date.now() - 60_000;
    const ids = [...Array.from({ length: 5 }, (_, i) => `Authentication notes ${i}`), query]
      .map((title, i) => seed(target, title, `CANDIDATE_BODY_${i}`, recent + i));
    const exactId = ids[5];
    const chroma = {
      queryChroma: async () => ({
        ids: ids.map(Number),
        distances: ids.map((_, i) => 0.1 + i * 0.01),
        metadatas: ids.map((id, i) => ({ sqlite_id: Number(id), doc_type: 'observation', project: target, created_at_epoch: recent + i })),
      }),
    };
    const semantic = new ProgressiveMemorySearch(
      new SearchManager(new SessionSearch(db), store, chroma as any, new FormattingService(), new TimelineService()),
      store,
    );
    const result = await semantic.run({ query, project: target, limit: 5, maxDetails: 1, depthBefore: 0, depthAfter: 0 });
    expect(result.index).toHaveLength(1);
    expect(result.index[0].id).toBe(exactId);
    expect(result.observations[0].id).toBe(exactId);
  });

  it('returns the same curated text from the HTTP worker route without duplicate internal state', async () => {
    const app = express();
    app.use(express.json());
    new SearchRoutes(manager).setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/api/dumb-search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'authentication', project }),
      });
      const payload = await response.json() as any;
      const expected = await progressive.run({ query: 'authentication', project });
      expect(payload).toEqual(progressiveSearchToolResult(expected));
      expect(payload.structuredContent).toBeUndefined();
      expect(payload.content[0].text).toStartWith('dumb-search — selected details');
      const invalid = await fetch(`http://127.0.0.1:${address.port}/api/dumb-search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'authentication', limit: 1000 }),
      });
      const error = await invalid.json() as any;
      expect(error.isError).toBe(true);
      expect(error.content[0].text).toContain('limit must be an integer');
      expect(() => JSON.parse(error.content[0].text)).toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('preserves JSON examples in selected SQLite narratives and the HTTP text response', async () => {
    const target = 'literal-json-fixture';
    const bodies = ['{"timeoutSeconds":30}', '["use staging"]'];
    const ids = bodies.map((body, index) => seed(target, `Literal JSON example ${index}`, body, epoch + index));
    const response = await progressive.run({ query: 'Literal JSON', project: target, maxDetails: 2 });
    expect(response.observations.map(row => row.id).sort()).toEqual([...ids].sort());
    const selected = progressiveSearchToolResult(response).content[0].text;
    for (const body of bodies) expect(selected).toContain(body);
    expect(selected).not.toContain('No readable memory details');
    const app = express(); app.use(express.json()); new SearchRoutes(manager).setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/api/dumb-search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'Literal JSON', project: target, maxDetails: 2 }),
      });
      const payload = await response.json() as { content: Array<{ type: string; text: string }>; structuredContent?: unknown };
      expect(response.status).toBe(200);
      expect(payload.structuredContent).toBeUndefined();
      for (const body of bodies) expect(payload.content[0].text).toContain(body);
      expect(() => JSON.parse(payload.content[0].text)).toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
