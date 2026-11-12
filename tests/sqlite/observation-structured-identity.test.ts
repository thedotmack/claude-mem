import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { computeObservationContentHash } from '../../src/services/sqlite/observations/store.js';

type Observation = Parameters<SessionStore['storeObservation']>[2];
const observation = (changes: Partial<Observation> = {}): Observation => ({
  type: 'discovery', title: 'Build configuration', subtitle: null, narrative: null,
  facts: ['Use the amber target'], concepts: [], files_read: [], files_modified: [], ...changes,
});

describe('structured observation identity', () => {
  let store: SessionStore;
  let previousDedup: string | undefined;
  beforeEach(() => {
    previousDedup = process.env.CLAUDE_MEM_DEDUP_ENABLED;
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'false';
    store = new SessionStore(':memory:');
    const id = store.createSDKSession('structured-content', 'project', 'prompt');
    store.updateMemorySessionId(id, 'structured-memory');
  });
  afterEach(() => {
    store.close();
    if (previousDedup === undefined) delete process.env.CLAUDE_MEM_DEDUP_ENABLED;
    else process.env.CLAUDE_MEM_DEDUP_ENABLED = previousDedup;
  });

  it('stores and recalls distinct fact-only observations with the same title', () => {
    const search = new SessionSearch(store.db);
    const first = observation();
    const second = observation({ facts: ['Use the violet target'] });
    const result = store.storeObservations('structured-memory', 'project', [first, second, first, second], null);
    const [firstId, secondId] = result.observationIds;
    expect(firstId).not.toBe(secondId);
    expect(result.observationIds).toEqual([firstId, secondId, firstId, secondId]);
    expect(result.insertedObservationIds).toEqual([firstId, secondId]);
    expect(search.searchObservations('violet', { project: 'project' }).map(row => row.id)).toEqual([secondId]);
    expect(store.getObservationById(firstId)?.facts).toBe(JSON.stringify(first.facts));
    expect(store.getObservationById(secondId)?.facts).toBe(JSON.stringify(second.facts));
  });

  it.each([
    ['subtitle', { subtitle: 'Changed compiler flags' }],
    ['type', { type: 'decision' }],
    ['concepts', { concepts: ['trade-off'] }],
  ] as [string, Partial<Observation>][])('retains different %s under the same title and narrative', (_, changes) => {
    const first = store.storeObservation('structured-memory', 'project', observation());
    const changed = observation(changes);
    const second = store.storeObservation('structured-memory', 'project', changed);
    expect(second.id).not.toBe(first.id);
    expect(store.storeObservation('structured-memory', 'project', changed).id).toBe(second.id);
    expect(store.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 2 });
  });

  it('keeps a legacy row and its hash while deduplicating retries of both variants', () => {
    const first = store.storeObservation('structured-memory', 'project', observation());
    const legacyHash = computeObservationContentHash('structured-memory', observation().title, null);
    // Imported JSON may use different whitespace without changing the facts.
    store.db.query('UPDATE observations SET facts = ? WHERE id = ?').run('[\n  "Use the amber target"\n]', first.id);
    const changed = observation({ facts: ['Use the violet target'] });
    const second = store.storeObservation('structured-memory', 'project', changed);
    expect(second.id).not.toBe(first.id);
    expect(store.storeObservation('structured-memory', 'project', observation()).id).toBe(first.id);
    expect(store.storeObservation('structured-memory', 'project', changed).id).toBe(second.id);
    expect(store.db.query('SELECT content_hash FROM observations WHERE id = ?').get(first.id)).toEqual({ content_hash: legacyHash });
  });

  it('preserves authored details with exact-only dedup while keeping title merging opt-in', () => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    const first = observation();
    const second = observation({ facts: ['Use the violet target'] });
    const options = { skipTitleDedup: true };
    const result = store.storeObservations('structured-memory', 'project', [first, second, first, second], null, 1, 0, undefined, undefined, options);
    expect(new Set(result.observationIds).size).toBe(2);
    expect(result.insertedObservationIds).toHaveLength(2);
    expect(store.db.query('SELECT SUM(occurrence_count) AS n FROM observations').get()).toEqual({ n: 2 });
    const merged = store.storeObservation('structured-memory', 'project', observation({ facts: ['A third variant'] }));
    expect(merged.id).toBe(result.observationIds[0]);
    expect(merged.mergedIntoExisting).toBe(true);
  });

  it('still recognizes a retained variant after the legacy-hash row is deleted', () => {
    const first = store.storeObservation('structured-memory', 'project', observation());
    const changed = observation({ facts: ['Use the violet target'] });
    const second = store.storeObservation('structured-memory', 'project', changed);
    store.db.query('DELETE FROM observations WHERE id = ?').run(first.id);
    expect(store.storeObservation('structured-memory', 'project', changed).id).toBe(second.id);
    expect(store.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 1 });
  });
});
