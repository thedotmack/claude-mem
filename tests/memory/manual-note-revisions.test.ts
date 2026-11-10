import { afterEach, describe, expect, it } from 'bun:test';
import { saveMemory } from '../../src/services/memory/save-memory.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';

const originalDedup = process.env.CLAUDE_MEM_DEDUP_ENABLED;
afterEach(() => {
  if (originalDedup === undefined) delete process.env.CLAUDE_MEM_DEDUP_ENABLED;
  else process.env.CLAUDE_MEM_DEDUP_ENABLED = originalDedup;
});

describe('explicit memory note revisions', () => {
  it('stores changed prose under the same authored title while preserving exact replay identity', () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    const store = new SessionStore(':memory:');
    const manager = {
      getConnection: () => store.db,
      getSessionStore: () => store,
      getCloudSync: () => null,
      getChromaSync: () => null,
    };
    try {
      const search = new SessionSearch(store.db);
      const first = saveMemory(manager as any, 'notes', { title: 'Deployment setting', text: 'Deploy to staging.' });
      const revised = saveMemory(manager as any, 'notes', { title: 'Deployment setting', text: 'Deploy to production.' });
      expect(revised.id).not.toBe(first.id);
      expect(store.db.query('SELECT title, narrative, occurrence_count FROM observations ORDER BY id').all()).toEqual([
        { title: 'Deployment setting', narrative: 'Deploy to staging.', occurrence_count: 1 },
        { title: 'Deployment setting', narrative: 'Deploy to production.', occurrence_count: 1 },
      ]);
      const replay = saveMemory(manager as any, 'notes', { title: 'Deployment setting', text: 'Deploy to production.' });
      expect(replay.id).toBe(revised.id);
      expect(store.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 2 });
      expect(search.searchObservations('production', { project: 'notes' }).map(row => row.id)).toEqual([revised.id]);
    } finally {
      store.close();
    }
  });

  it('keeps separate untitled notes whose first sixty characters coincide', () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    const store = new SessionStore(':memory:');
    const manager = { getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null };
    try {
      const prefix = 'This deployment has a deliberately shared introduction. '.padEnd(65, 'x');
      const first = saveMemory(manager as any, 'notes', { text: `${prefix} staging` });
      const second = saveMemory(manager as any, 'notes', { text: `${prefix} production` });
      expect(second.title).toBe(first.title);
      expect(second.id).not.toBe(first.id);
    } finally {
      store.close();
    }
  });
});
