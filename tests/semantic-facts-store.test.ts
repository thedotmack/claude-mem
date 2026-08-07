// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import {
  insertFact,
  reinforceFact,
  supersedeFact,
  invalidateFact,
  recordFactSurfaced,
  recordFactsRetrieved,
  getActiveFacts,
  getFactsByIds,
  computeFactContentHash,
  parseSourceObservationIds,
  type SemanticFactRow,
} from '../src/services/sqlite/facts/store.js';
import { parseReinforcementDates, MAX_REINFORCEMENT_HISTORY } from '../src/services/reinforcement/strength.js';

type ObservationInput = {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
};

const obs = (over: Partial<ObservationInput> = {}): ObservationInput => ({
  type: 'discovery',
  title: 'x',
  subtitle: null,
  facts: [],
  narrative: 'x',
  concepts: [],
  files_read: [],
  files_modified: [],
  ...over,
});

function makeSession(store: SessionStore): void {
  store.db.run(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, status, started_at, started_at_epoch)
     VALUES ('c1', 's1', 'proj', 'active', '2026-06-17', 1750000000)`,
  );
}

const rowOf = (store: SessionStore, id: number): SemanticFactRow =>
  store.db.prepare('SELECT * FROM semantic_facts WHERE id = ?').get(id) as SemanticFactRow;

const NOW = new Date('2026-06-17T12:00:00Z');

describe('Semantic memory layer — fact store', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    makeSession(store);
  });

  afterEach(() => store.db.close());

  describe('insertFact', () => {
    it('inserts a fact with a seeded reinforcement date and content hash', () => {
      const { id, inserted } = insertFact(store.db, {
        project: 'proj', kind: 'environment', fact: 'This project runs on Bun.', sourceObservationIds: [],
      }, NOW);
      expect(inserted).toBe(true);

      const row = rowOf(store, id);
      expect(row.kind).toBe('environment');
      expect(row.fact).toBe('This project runs on Bun.');
      expect(row.content_hash).toBe(computeFactContentHash('proj', 'This project runs on Bun.'));
      expect(parseReinforcementDates(row.reinforcement_dates)).toEqual(['2026-06-17']);
      expect(row.last_reinforced).toBe('2026-06-17');
      expect(row.superseded_by).toBeNull();
      expect(row.invalidated_at).toBeNull();
    });

    it('dedups identical (project, fact) via content hash — reinforces instead of duplicating', () => {
      const first = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'Bun runtime', sourceObservationIds: [] }, new Date('2026-06-01T12:00:00Z'));
      const second = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'Bun runtime', sourceObservationIds: [] }, NOW);

      expect(second.inserted).toBe(false);
      expect(second.id).toBe(first.id);
      expect(parseReinforcementDates(rowOf(store, first.id).reinforcement_dates)).toEqual(['2026-06-01', '2026-06-17']);

      const count = store.db.prepare('SELECT COUNT(*) AS n FROM semantic_facts').get() as { n: number };
      expect(count.n).toBe(1);
    });

    it('scopes the dedup hash per project — same fact text in another project inserts', () => {
      const a = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'Bun runtime', sourceObservationIds: [] }, NOW);
      const b = insertFact(store.db, { project: 'other', kind: 'environment', fact: 'Bun runtime', sourceObservationIds: [] }, NOW);
      expect(b.inserted).toBe(true);
      expect(b.id).not.toBe(a.id);
    });

    it('defaults valid_from to the earliest source observation day', () => {
      const early = store.storeObservation('s1', 'proj', obs({ title: 'a', narrative: 'a' }), 1, 0, Date.parse('2026-03-01T12:00:00Z'));
      const late = store.storeObservation('s1', 'proj', obs({ title: 'b', narrative: 'b' }), 2, 0, Date.parse('2026-06-10T12:00:00Z'));

      const { id } = insertFact(store.db, {
        project: 'proj', kind: 'project_convention', fact: 'Tests run via bun test.', sourceObservationIds: [late.id, early.id],
      }, NOW);
      expect(rowOf(store, id).valid_from).toBe('2026-03-01');
    });

    it('falls back to today for valid_from when sources do not resolve', () => {
      const { id } = insertFact(store.db, {
        project: 'proj', kind: 'environment', fact: 'x', sourceObservationIds: [999999],
      }, NOW);
      expect(rowOf(store, id).valid_from).toBe('2026-06-17');
    });
  });

  describe('supersedeFact', () => {
    it('marks the old row, sets valid_to, and transfers the older half of strength history', () => {
      const old = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'cache uses redis', sourceObservationIds: [] }, new Date('2026-06-01T12:00:00Z'));
      store.db.prepare('UPDATE semantic_facts SET reinforcement_dates = ? WHERE id = ?')
        .run(JSON.stringify(['2026-06-01', '2026-06-05', '2026-06-10']), old.id);

      const replacement = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'cache uses valkey', sourceObservationIds: [] }, NOW);

      expect(supersedeFact(store.db, old.id, replacement.id, NOW)).toBe(true);

      const oldRow = rowOf(store, old.id);
      expect(oldRow.superseded_by).toBe(replacement.id);
      expect(oldRow.valid_to).toBe('2026-06-17');
      expect(oldRow.invalidated_at).toBeNull();

      // ceil(3/2) = 2 oldest dates inherited + the replacement's own seed date.
      const newRow = rowOf(store, replacement.id);
      expect(parseReinforcementDates(newRow.reinforcement_dates)).toEqual(['2026-06-01', '2026-06-05', '2026-06-17']);
      expect(newRow.last_reinforced).toBe('2026-06-17');
    });

    it('the first supersession wins — no chains', () => {
      const old = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'a', sourceObservationIds: [] }, NOW);
      const first = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'b', sourceObservationIds: [] }, NOW);
      const second = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'c', sourceObservationIds: [] }, NOW);

      expect(supersedeFact(store.db, old.id, first.id, NOW)).toBe(true);
      expect(supersedeFact(store.db, old.id, second.id, NOW)).toBe(false);
      expect(rowOf(store, old.id).superseded_by).toBe(first.id);
    });

    it('is a no-op when either row is missing', () => {
      const a = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'a', sourceObservationIds: [] }, NOW);
      expect(supersedeFact(store.db, a.id, 999999, NOW)).toBe(false);
      expect(supersedeFact(store.db, 999999, a.id, NOW)).toBe(false);
      expect(rowOf(store, a.id).superseded_by).toBeNull();
    });

    it('caps the inherited history at MAX_REINFORCEMENT_HISTORY', () => {
      const old = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'a', sourceObservationIds: [] }, NOW);
      const many = Array.from({ length: MAX_REINFORCEMENT_HISTORY }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`);
      store.db.prepare('UPDATE semantic_facts SET reinforcement_dates = ? WHERE id = ?').run(JSON.stringify(many), old.id);

      const replacement = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'b', sourceObservationIds: [] }, NOW);
      expect(supersedeFact(store.db, old.id, replacement.id, NOW)).toBe(true);
      expect(parseReinforcementDates(rowOf(store, replacement.id).reinforcement_dates).length).toBeLessThanOrEqual(MAX_REINFORCEMENT_HISTORY);
    });
  });

  describe('invalidateFact', () => {
    it('tombstones the row — invalidated_at + valid_to, never a physical delete', () => {
      const { id } = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'a', sourceObservationIds: [] }, NOW);
      expect(invalidateFact(store.db, id, NOW)).toBe(true);

      const row = rowOf(store, id);
      expect(row.invalidated_at).toBe(NOW.toISOString());
      expect(row.valid_to).toBe('2026-06-17');

      const count = store.db.prepare('SELECT COUNT(*) AS n FROM semantic_facts WHERE id = ?').get(id) as { n: number };
      expect(count.n).toBe(1); // still present — tombstone only
    });

    it('is idempotent and refuses to touch superseded rows', () => {
      const old = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'a', sourceObservationIds: [] }, NOW);
      const replacement = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'b', sourceObservationIds: [] }, NOW);

      expect(invalidateFact(store.db, old.id, NOW)).toBe(true);
      expect(invalidateFact(store.db, old.id, NOW)).toBe(false); // already tombstoned

      supersedeFact(store.db, replacement.id, old.id, NOW);
      expect(invalidateFact(store.db, replacement.id, NOW)).toBe(false); // superseded rows keep their tombstone semantics
      expect(invalidateFact(store.db, 999999, NOW)).toBe(false);
    });
  });

  describe('reinforce / retrieval / surfacing', () => {
    it('reinforceFact is same-day idempotent', () => {
      const { id } = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'a', sourceObservationIds: [] }, NOW);
      expect(reinforceFact(store.db, id, NOW)).toBe(false);
      expect(reinforceFact(store.db, id, new Date('2026-06-18T12:00:00Z'))).toBe(true);
      expect(parseReinforcementDates(rowOf(store, id).reinforcement_dates)).toEqual(['2026-06-17', '2026-06-18']);
    });

    it('recordFactsRetrieved appends a real reinforcement date', () => {
      const { id } = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'a', sourceObservationIds: [] }, NOW);
      expect(recordFactsRetrieved(store.db, [id], new Date('2026-06-20T12:00:00Z'))).toBe(1);
      expect(recordFactsRetrieved(store.db, [id], new Date('2026-06-20T13:00:00Z'))).toBe(0); // same-day
      expect(parseReinforcementDates(rowOf(store, id).reinforcement_dates)).toContain('2026-06-20');
    });

    it('recordFactSurfaced bumps relevance_count without touching dates', () => {
      const { id } = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'a', sourceObservationIds: [] }, NOW);
      recordFactSurfaced(store.db, [id]);
      recordFactSurfaced(store.db, [id]);
      const row = rowOf(store, id);
      expect(row.relevance_count).toBe(2);
      expect(parseReinforcementDates(row.reinforcement_dates)).toEqual(['2026-06-17']);
    });
  });

  describe('getActiveFacts / getFactsByIds', () => {
    it('excludes superseded and invalidated rows from the active set', () => {
      const live = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'live', sourceObservationIds: [] }, NOW);
      const superseded = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'old', sourceObservationIds: [] }, NOW);
      const invalidated = insertFact(store.db, { project: 'proj', kind: 'environment', fact: 'dead', sourceObservationIds: [] }, NOW);
      supersedeFact(store.db, superseded.id, live.id, NOW);
      invalidateFact(store.db, invalidated.id, NOW);

      const active = getActiveFacts(store.db, ['proj'], 10);
      expect(active.map(f => f.id)).toEqual([live.id]);

      // Full-row fetch still returns tombstoned history.
      const all = getFactsByIds(store.db, [live.id, superseded.id, invalidated.id]);
      expect(all.length).toBe(3);
    });
  });

  describe('parseSourceObservationIds', () => {
    it('parses the provenance array and tolerates garbage', () => {
      expect(parseSourceObservationIds('[1, 2, 3]')).toEqual([1, 2, 3]);
      expect(parseSourceObservationIds('not json')).toEqual([]);
      expect(parseSourceObservationIds(null)).toEqual([]);
      expect(parseSourceObservationIds('["a", 4]')).toEqual([4]);
    });
  });
});
