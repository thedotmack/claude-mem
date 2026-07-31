// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../src/services/sqlite/SessionSearch.js';
import { supersedeObservation } from '../src/services/reinforcement/persist.js';
import { findDedupCandidates } from '../src/services/reinforcement/dedup.js';
import { parseReinforcementDates, MAX_REINFORCEMENT_HISTORY } from '../src/services/reinforcement/strength.js';

// SessionStore owns observation writes; this mirrors the shape it accepts.
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

const rowOf = (store: SessionStore, id: number) =>
  store.db.prepare('SELECT reinforcement_dates, last_reinforced, superseded_by FROM observations WHERE id=?').get(id) as
    { reinforcement_dates: string | null; last_reinforced: string | null; superseded_by: number | null };

describe('Phase 6 — reconsolidation (supersedeObservation)', () => {
  describe('migration', () => {
    it('superseded_by exists and records schema v52', () => {
      const store = new SessionStore(':memory:');
      const cols = (store.db.query('PRAGMA table_info(observations)').all() as { name: string }[]).map(c => c.name);
      expect(cols).toContain('superseded_by');
      const v = store.db.prepare('SELECT version FROM schema_versions WHERE version=?').get(52) as { version: number } | undefined;
      expect(v?.version).toBe(52);
      store.db.close();
    });
  });

  describe('supersedeObservation', () => {
    let store: SessionStore;
    beforeEach(() => {
      store = new SessionStore(':memory:');
      makeSession(store);
    });
    afterEach(() => store.db.close());

    it('marks the old row and transfers the older half of its strength history', () => {
      const d1 = Date.parse('2026-06-01T12:00:00Z');
      const d2 = Date.parse('2026-06-05T12:00:00Z');
      const d3 = Date.parse('2026-06-10T12:00:00Z');
      // Same title/narrative → same content_hash → reinforces the same row,
      // accruing a 3-date history on the old observation.
      const old = store.storeObservation('s1', 'proj', obs({ title: 'cache', narrative: 'uses redis' }), 1, 0, d1);
      store.storeObservation('s1', 'proj', obs({ title: 'cache', narrative: 'uses redis' }), 2, 0, d2);
      store.storeObservation('s1', 'proj', obs({ title: 'cache', narrative: 'uses redis' }), 3, 0, d3);
      expect(parseReinforcementDates(rowOf(store, old.id).reinforcement_dates)).toEqual(['2026-06-01', '2026-06-05', '2026-06-10']);

      const dayNew = Date.parse('2026-06-17T12:00:00Z');
      const replacement = store.storeObservation('s1', 'proj', obs({ title: 'cache', narrative: 'uses valkey now' }), 4, 0, dayNew);

      expect(supersedeObservation(store.db, old.id, replacement.id)).toBe(true);

      const oldRow = rowOf(store, old.id);
      expect(oldRow.superseded_by).toBe(replacement.id);

      // ceil(3/2) = 2 oldest dates inherited + the replacement's own seed date.
      const newRow = rowOf(store, replacement.id);
      expect(parseReinforcementDates(newRow.reinforcement_dates)).toEqual(['2026-06-01', '2026-06-05', '2026-06-17']);
      expect(newRow.last_reinforced).toBe('2026-06-17');
    });

    it('the first supersession wins — an already-superseded row is not re-marked', () => {
      const old = store.storeObservation('s1', 'proj', obs({ title: 'a', narrative: 'a' }), 1, 0, Date.parse('2026-06-01T12:00:00Z'));
      const first = store.storeObservation('s1', 'proj', obs({ title: 'b', narrative: 'b' }), 2, 0, Date.parse('2026-06-10T12:00:00Z'));
      const second = store.storeObservation('s1', 'proj', obs({ title: 'c', narrative: 'c' }), 3, 0, Date.parse('2026-06-17T12:00:00Z'));

      expect(supersedeObservation(store.db, old.id, first.id)).toBe(true);
      expect(supersedeObservation(store.db, old.id, second.id)).toBe(false);
      expect(rowOf(store, old.id).superseded_by).toBe(first.id);
    });

    it('is a no-op when either row is missing', () => {
      const a = store.storeObservation('s1', 'proj', obs({ title: 'a', narrative: 'a' }), 1, 0, Date.parse('2026-06-01T12:00:00Z'));
      expect(supersedeObservation(store.db, a.id, 999999)).toBe(false);
      expect(supersedeObservation(store.db, 999999, a.id)).toBe(false);
      expect(rowOf(store, a.id).superseded_by).toBeNull();
    });

    it('caps the inherited history at MAX_REINFORCEMENT_HISTORY', () => {
      const old = store.storeObservation('s1', 'proj', obs({ title: 'a', narrative: 'a' }), 1, 0, Date.parse('2026-06-01T12:00:00Z'));
      const many = Array.from({ length: MAX_REINFORCEMENT_HISTORY }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`);
      store.db.prepare('UPDATE observations SET reinforcement_dates = ? WHERE id = ?').run(JSON.stringify(many), old.id);

      const replacement = store.storeObservation('s1', 'proj', obs({ title: 'b', narrative: 'b' }), 2, 0, Date.parse('2026-06-17T12:00:00Z'));
      expect(supersedeObservation(store.db, old.id, replacement.id)).toBe(true);
      expect(parseReinforcementDates(rowOf(store, replacement.id).reinforcement_dates).length).toBeLessThanOrEqual(MAX_REINFORCEMENT_HISTORY);
    });

    it('superseded rows drop out of dedup candidacy', () => {
      new SessionSearch(store.db); // sets up observations_fts + triggers

      const old = store.storeObservation('s1', 'proj', obs({ title: 'cache layer', narrative: 'cache uses redis cluster' }), 1, 0, Date.parse('2026-06-01T12:00:00Z'));
      const live = store.storeObservation('s1', 'proj', obs({ title: 'cache layer', narrative: 'cache uses valkey cluster' }), 2, 0, Date.parse('2026-06-17T12:00:00Z'));
      supersedeObservation(store.db, old.id, live.id);

      const candidates = findDedupCandidates(store.db, {
        project: 'proj',
        type: 'discovery',
        title: 'cache layer',
        narrative: 'cache cluster storage',
      });
      expect(candidates.map(c => c.id)).toContain(live.id);
      expect(candidates.map(c => c.id)).not.toContain(old.id);
    });
  });
});
