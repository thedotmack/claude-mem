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

describe('progressive worker search with real SQLite fixtures', () => {
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

  it('discloses no narratives until selected context reaches step 3', async () => {
    const first = await progressive.run({ query: 'authentication', project, mode: 'guided' });
    expect(first.step).toBe(1);
    expect(first.continuation).toMatch(/^ms_[A-Za-z0-9_-]{24}$/);
    expect(first.index.some(row => row.id === authId)).toBe(true);
    expect(first.index.some(row => row.id === unrelatedId)).toBe(false);
    expect(JSON.stringify(first)).not.toContain('PRIVATE_');
    expect(first.next?.instruction).toContain('step 2 of 3');
    const second = await progressive.run({ continuation: first.continuation!, selectedIds: [authId] });
    expect(second.step).toBe(2);
    expect(second.index.some(row => row.title === 'Authentication tied sibling')).toBe(true);
    expect(JSON.stringify(second)).not.toContain('PRIVATE_');
    const third = await progressive.run({ continuation: second.continuation!, selectedIds: [authId] });
    expect(third.step).toBe(3);
    expect(third.observations).toHaveLength(1);
    expect(third.observations[0].content).toContain('PRIVATE_AUTH_BODY');
    expect(third.observations[0].truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(third))).toBeLessThanOrEqual(PROGRESSIVE_RESPONSE_BYTES);
  });

  it('rejects skipped steps, undisclosed IDs, changed scope and tampered tokens', async () => {
    await expect(progressive.run({ query: 'authentication', selectedIds: [authId] })).rejects.toThrow('preceding step');
    const first = await progressive.run({ query: 'authentication', project });
    await expect(progressive.run({ continuation: first.continuation!, selectedIds: [unrelatedId] })).rejects.toThrow('not disclosed');
    await expect(progressive.run({ continuation: first.continuation!, selectedIds: [authId] }, 'different-scope')).rejects.toThrow('different memory scope');
    await expect(progressive.run({ continuation: first.continuation!.slice(0, -5) + 'AAAAA', selectedIds: [authId] })).rejects.toMatchObject({ code: 'invalid_continuation' });
    await expect(progressive.run({ continuation: first.continuation!, selectedIds: [authId], project: 'another-project' })).rejects.toThrow('original search options');
  });

  it('auto mode performs bounded index, context and a selected fetch', async () => {
    const response = await progressive.run({ query: 'authentication', project, mode: 'auto', limit: 8, maxDetails: 2 });
    expect(response.complete).toBe(true);
    expect(response.trace.map(row => row.operation)).toEqual(['search', 'timeline', 'fetch']);
    expect(response.observations.length).toBeLessThanOrEqual(2);
    expect(response.observations.every(row => row.project === project)).toBe(true);
    expect(response.observations.some(row => row.content.includes('PRIVATE_OTHER_BODY'))).toBe(false);
  });

  it('uses the stored matching project for timeline context across checkout aliases', async () => {
    const first = await progressive.run({ query: 'authentication', project: 'checkout-new' }, 'checkout-scope', ['checkout-new', project]);
    expect(first.index.some(row => row.id === authId)).toBe(true);
    const second = await progressive.run({ continuation: first.continuation!, selectedIds: [authId] }, 'checkout-scope');
    expect(second.index.some(row => row.title === 'Authentication tied sibling')).toBe(true);
    expect(second.index.every(row => row.project === project)).toBe(true);
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
    const first = await adapter.run({ query: 'Authentication token expiry', project, limit: 20 });
    expect(first.index).toHaveLength(20);
    expect(first.index[0].id).toBe(`S${summary}`);
    const auto = await adapter.run({ query: 'Authentication token expiry', project, limit: 20, mode: 'auto', maxDetails: 1 });
    expect(auto.observations[0].id).toBe(`S${summary}`);
    expect(auto.observations[0].content).toContain('SUMMARY_DETAIL');
  });

  it('returns the same curated text from the HTTP worker route without duplicate internal state', async () => {
    const app = express();
    app.use(express.json());
    new SearchRoutes(manager).setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/api/mem-search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'authentication', project, mode: 'auto' }),
      });
      const payload = await response.json() as any;
      const expected = await progressive.run({ query: 'authentication', project, mode: 'auto' });
      expect(payload).toEqual(progressiveSearchToolResult(expected));
      expect(payload.structuredContent).toBeUndefined();
      expect(payload.content[0].text).toStartWith('mem-search step 3 of 3');
      const invalid = await fetch(`http://127.0.0.1:${address.port}/api/mem-search`, {
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
});
