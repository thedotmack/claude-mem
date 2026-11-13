import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';
import type { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

describe('date-ordered file lookup does not depend on semantic search availability', () => {
  let store: SessionStore;
  let search: SearchOrchestrator;
  let calls: number;
  const unavailable = new Error('Chroma connection lost');

  function seed(epoch: number, project = 'project', source = 'claude') {
    const memory = `${project}-${source}-${epoch}`;
    const session = store.createSDKSession(`content-${memory}`, project, 'prompt');
    store.ensureMemorySessionIdRegistered(session, memory);
    store.db.prepare('UPDATE sdk_sessions SET platform_source = ? WHERE id = ?').run(source, session);
    store.storeObservation(memory, project, {
      type: 'discovery', title: memory, subtitle: null, narrative: memory,
      facts: [], concepts: [], files_read: ['src/file.ts'], files_modified: [],
    }, 1, 0, epoch);
    store.storeSummary(memory, project, {
      request: memory, investigated: null, learned: null, completed: null,
      next_steps: null, notes: null, files_read: ['src/file.ts'],
    }, 1, 0, epoch);
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
    calls = 0;
    for (const epoch of [100, 200, 300]) seed(epoch);
    seed(400, 'other-project');
    seed(250, 'project', 'codex');
    const chroma = { queryChroma: async () => { calls++; throw unavailable; } };
    search = new SearchOrchestrator(new SessionSearch(store.db), store, chroma as unknown as ChromaSync);
  });

  afterEach(() => store.close());

  for (const isFolder of [false, true]) {
    for (const orderBy of ['date_asc', 'date_desc'] as const) {
      it(`returns the SQLite ${isFolder ? 'folder' : 'file'} page in ${orderBy} during a Chroma outage`, async () => {
        const result = await search.findByFile(isFolder ? 'src' : 'src/file.ts', {
          project: 'project', platformSource: 'claude', isFolder, limit: 3, orderBy,
        });
        const expected = orderBy === 'date_asc' ? [100, 200, 300] : [300, 200, 100];
        expect(result.observations.map(row => row.created_at_epoch)).toEqual(expected);
        expect(result.sessions.map(row => row.created_at_epoch)).toEqual(expected);
        expect(result.usedChroma).toBe(false);
        expect(calls).toBe(0);
      });
    }
  }

  it('preserves the offset and date window of the selected SQLite page', async () => {
    const result = await search.findByFile('src/file.ts', {
      project: 'project', platformSource: 'claude', limit: 1, offset: 1,
      orderBy: 'date_asc', dateRange: { start: 150, end: 350 },
    });
    expect(result.observations.map(row => row.created_at_epoch)).toEqual([300]);
    expect(result.sessions.map(row => row.created_at_epoch)).toEqual([300]);
    expect(calls).toBe(0);
  });

  it('keeps project and source filters while bypassing unnecessary embeddings', async () => {
    const result = await search.findByFile('src/file.ts', {
      project: 'project', platformSource: 'codex', orderBy: 'date_desc', limit: 5,
    });
    expect(result.observations.map(row => row.created_at_epoch)).toEqual([250]);
    expect(result.sessions.map(row => row.created_at_epoch)).toEqual([250]);
    expect(calls).toBe(0);
  });

  for (const orderBy of [undefined, 'relevance'] as const) {
    it(`still reports semantic failures for ${orderBy ?? 'default'} ordering`, async () => {
      await expect(search.findByFile('src/file.ts', { project: 'project', orderBy }))
        .rejects.toBe(unavailable);
      expect(calls).toBe(1);
    });
  }
});
