import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { ProgressiveMemorySearch } from '../../src/services/worker/ProgressiveMemorySearch.js';
import { isMemoryDetailCandidate } from '../../src/shared/progressive-search.js';

describe('Dumb search canonical title spelling', () => {
  it('does not erase accents or meaningful combining marks', () => {
    const candidate = { id: '1', kind: 'observation' as const, project: 'canonical-title', createdAt: 0, type: 'decision' };
    expect(isMemoryDetailCandidate({ ...candidate, title: 'café' }, 'cafe')).toBe(false);
    expect(isMemoryDetailCandidate({ ...candidate, title: 'की' }, 'क')).toBe(false);
  });
  for (const [query, title] of [
    ['café', 'cafe\u0301'],
    ['cafe\u0301', 'café'],
    ['Åsa', 'A\u030Asa'],
  ]) {
    it(`retrieves the stored title ${JSON.stringify(title)} for ${JSON.stringify(query)}`, async () => {
      const db = new Database(':memory:');
      try {
        const store = new SessionStore(db);
        const manager = new SearchManager(new SessionSearch(db), store, null, new FormattingService(), new TimelineService());
        const project = 'canonical-title';
        const memory = store.getOrCreateManualSession(project);
        const record = (heading: string, narrative: string, epoch: number) => store.storeObservation(memory, project, {
          type: 'decision', title: heading, subtitle: null, narrative,
          facts: [], concepts: [], files_read: [], files_modified: [],
        }, 1, 0, epoch).id;
        const id = record(title, 'SELECTED_EVIDENCE', 1000);
        record('Unrelated title', `BODY_ONLY ${query}`, 2000);
        const raw = await manager.search({ query, project, format: 'json' });
        expect(raw.observations.some(row => row.id === id)).toBe(true);
        const result = await new ProgressiveMemorySearch(manager, store).run({
          query, project, limit: 1, maxDetails: 1, depthBefore: 0, depthAfter: 0,
        });
        expect(result.step).toBe(3);
        expect(result.observations.map(row => row.id)).toEqual([String(id)]);
        expect(result.observations[0].content).toContain('SELECTED_EVIDENCE');
        expect(result.observations[0].title).toBe(title);
        expect(store.getObservationById(id)?.title).toBe(title);
      } finally { db.close(); }
    });
  }
});
