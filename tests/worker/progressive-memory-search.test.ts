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
import { progressiveSearchToolResult, PROGRESSIVE_RESPONSE_BYTES, type MemoryIndexRow } from '../../src/shared/progressive-search.js';

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

describe('worker timeline context window', () => {
  let db: Database;
  let store: SessionStore;
  let manager: SearchManager;
  let progressive: ProgressiveMemorySearch;
  const project = 'timeline-window-fixture';
  const decoyProject = 'timeline-window-decoy';
  const base = Date.UTC(2026, 9, 8, 12, 0, 0);
  type SeedRow = { id: number; kind: MemoryIndexRow['kind']; epoch: number; title: string; type: string | null };
  let seeded: SeedRow[];

  function observation(title: string, timestamp: number, target = project): SeedRow {
    const memory = store.getOrCreateManualSession(target);
    const id = store.storeObservation(memory, target, {
      type: 'decision', title, subtitle: null, narrative: title, facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, timestamp).id;
    return { id, kind: 'observation', epoch: timestamp, title, type: 'decision' };
  }
  function summary(request: string, timestamp: number): SeedRow {
    const memory = store.getOrCreateManualSession(project);
    const id = store.storeSummary(memory, project, {
      request, investigated: '', learned: '', completed: '', next_steps: '', notes: null,
    }, 1, 0, timestamp).id;
    return { id, kind: 'summary', epoch: timestamp, title: request, type: null };
  }
  function prompt(text: string, timestamp: number, promptNumber: number): SeedRow {
    const memory = store.getOrCreateManualSession(project);
    const session = store.db.prepare('SELECT id, content_session_id FROM sdk_sessions WHERE memory_session_id = ?')
      .get(memory) as { id: number; content_session_id: string };
    const id = store.saveUserPrompt(session.content_session_id, promptNumber, text, session.id);
    // The store stamps prompts with "now"; this fixture needs controlled epochs.
    store.db.prepare('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?').run(timestamp, id);
    return { id, kind: 'prompt', epoch: timestamp, title: text.slice(0, 160), type: null };
  }

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SessionStore(db);
    manager = new SearchManager(new SessionSearch(db), store, null, new FormattingService(), new TimelineService());
    progressive = new ProgressiveMemorySearch(manager, store);
    // Every kind shares epochs with the others so ties and kind ordering decide
    // the window, not insertion order.
    seeded = [
      observation('Authentication earliest', base - 3000),
      observation('Authentication tied before a', base - 2000),
      observation('Authentication tied before b', base - 2000),
      summary('Authentication summary before', base - 2000),
      observation('Authentication just before', base - 1000),
      prompt('Authentication prompt before', base - 1000, 1),
      observation('Authentication anchor', base),
      observation('Authentication anchor sibling', base),
      summary('Authentication summary at anchor', base),
      prompt('Authentication prompt at anchor', base, 2),
      observation('Authentication just after', base + 1000),
      prompt('Authentication prompt after', base + 1000, 3),
      observation('Authentication tied after a', base + 2000),
      observation('Authentication tied after b', base + 2000),
      summary('Authentication summary after', base + 2000),
      observation('Authentication latest', base + 3000),
    ];
    observation('Authentication decoy', base, decoyProject);
  });

  afterEach(() => db.close());

  const pick = (title: string) => seeded.find(row => row.title === title)!;
  const refId = (row: { id: number; kind: MemoryIndexRow['kind'] }) =>
    row.kind === 'summary' ? `S${row.id}` : row.kind === 'prompt' ? `P${row.id}` : String(row.id);
  const asIndexRow = (row: SeedRow): MemoryIndexRow =>
    ({ id: refId(row), kind: row.kind, project, title: row.title, createdAt: row.epoch, type: row.type });
  const orderKey = (row: { id: number; kind: MemoryIndexRow['kind']; epoch: number }) => [row.epoch, row.kind, row.id] as const;
  const compareKeys = (a: readonly [number, string, number], b: readonly [number, string, number]) =>
    a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || a[2] - b[2];

  it('bounds each timeline union arm instead of materialising the project', async () => {
    // A project large enough that an unbounded arm has to read all of it.
    for (let i = 0; i < 300; i++) observation(`Authentication filler ${i}`, base + 10_000 + i * 7);
    const captured: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: Database['prepare'] }).prepare = ((sql: string, ...rest: unknown[]) => {
      if (sql.includes('memory_index')) captured.push(sql);
      return (originalPrepare as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as unknown as Database['prepare'];
    try {
      const response = await progressive.run({ query: 'authentication', project, limit: 8, maxDetails: 2 });
      expect(response.trace.map(row => row.operation)).toContain('timeline');
    } finally {
      (db as unknown as { prepare: Database['prepare'] }).prepare = originalPrepare as unknown as Database['prepare'];
    }
    expect(captured.length).toBeGreaterThan(0);

    const plan = db.prepare(`EXPLAIN QUERY PLAN ${captured[0]}`).all() as Array<{ id: number; parent: number; detail: string }>;
    const byParent = new Map<number, Array<{ id: number; parent: number; detail: string }>>();
    for (const row of plan) byParent.set(row.parent, [...(byParent.get(row.parent) ?? []), row]);
    const subtree = (id: number): Array<{ detail: string }> => (byParent.get(id) ?? [])
      .flatMap(child => [child, ...subtree(child.id)]);
    // LEFT-MOST SUBQUERY + one UNION ALL per remaining arm.
    const arms = plan.filter(row => row.detail === 'LEFT-MOST SUBQUERY' || row.detail === 'UNION ALL');
    expect(arms).toHaveLength(3);
    // What this PR guarantees: the LIMIT lives inside each arm, so SQLite plans
    // each arm as its own bounded subquery (a CO-ROUTINE node) that stops after
    // `limit` rows instead of streaming every matching row of the project into
    // the CTE. An arm without an internal LIMIT has no such node.
    //
    // Deliberately not pinned: how an arm sorts. Whether a `USE TEMP B-TREE`
    // node appears depends on which index the planner picks for the arm's
    // ORDER BY, so requiring (or forbidding) one would turn this test red when a
    // better index is added later. Sorting is not what this test claims.
    //
    // Honest limit of the guarantee: the `user_prompts` arm still gathers the
    // project's prompts. Its project filter lives on the joined `sdk_sessions`,
    // and `user_prompts` has no `(session_db_id, created_at_epoch)` index that
    // could bound it by project; adding that index is deliberately out of scope.
    const boundedArms = arms.map(arm => subtree(arm.id))
      .filter(nodes => nodes.some(node => node.detail.startsWith('CO-ROUTINE (subquery')));
    expect(boundedArms).toHaveLength(3);
  });

  it('returns exactly the boundary window rows for matched and mismatched anchors', () => {
    const timeline = progressive as unknown as {
      timeline(anchor: MemoryIndexRow, before: number, after: number): MemoryIndexRow[];
    };
    const anchors: Array<{ id: number; kind: MemoryIndexRow['kind']; epoch: number; title: string; type: string | null }> = [
      pick('Authentication anchor'),
      pick('Authentication summary at anchor'),
      pick('Authentication prompt at anchor'),
      pick('Authentication earliest'),
      pick('Authentication latest'),
      // An anchor that is not a stored row still windows by the same tuple.
      { id: 4242, kind: 'prompt', epoch: base, title: 'Phantom anchor', type: null },
    ];
    const windows: Array<[number, number]> = [[3, 3], [1, 3], [3, 1], [0, 2], [2, 0]];
    for (const anchor of anchors) {
      const anchorKey = orderKey(anchor);
      const sorted = [...seeded].sort((a, b) => compareKeys(orderKey(a), orderKey(b)));
      const below = sorted.filter(row => compareKeys(orderKey(row), anchorKey) < 0);
      const above = sorted.filter(row => compareKeys(orderKey(row), anchorKey) > 0);
      for (const [before, after] of windows) {
        const anchorRow: MemoryIndexRow = {
          id: refId(anchor), kind: anchor.kind, project, title: anchor.title, createdAt: anchor.epoch, type: anchor.type,
        };
        const expected = [
          ...(before ? below.slice(-before) : []).map(asIndexRow),
          anchorRow,
          ...above.slice(0, after).map(asIndexRow),
        ];
        expect(timeline.timeline(anchorRow, before, after)).toEqual(expected);
      }
    }
  });
});
