// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { recordSurfaced } from '../src/services/reinforcement/persist.js';
import { blendedScore } from '../src/services/reinforcement/rank.js';
import { DEFAULT_TUNABLES } from '../src/services/reinforcement/strength.js';

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
const countOf = (store: SessionStore, id: number) =>
  (store.db.prepare('SELECT relevance_count FROM observations WHERE id=?').get(id) as { relevance_count: number }).relevance_count;

describe('Phase 4 — surfacing observability', () => {
  describe('migration', () => {
    it('relevance_count exists and records schema v34', () => {
      const store = new SessionStore(':memory:');
      const cols = (store.db.query('PRAGMA table_info(observations)').all() as { name: string }[]).map(c => c.name);
      expect(cols).toContain('relevance_count');
      const v = store.db.prepare('SELECT version FROM schema_versions WHERE version=?').get(34) as { version: number } | undefined;
      expect(v?.version).toBe(34);
      store.db.close();
    });
  });

  describe('recordSurfaced', () => {
    let store: SessionStore;
    beforeEach(() => {
      store = new SessionStore(':memory:');
      makeSession(store);
    });
    afterEach(() => store.db.close());

    it('bumps relevance_count for each surfaced id, repeatable', () => {
      const a = store.storeObservation('s1', 'proj', obs({ title: 'a', narrative: 'a' }), 1, 0, 1750000000000);
      const b = store.storeObservation('s1', 'proj', obs({ title: 'b', narrative: 'b' }), 1, 0, 1750000000000);
      expect(countOf(store, a.id)).toBe(0);

      recordSurfaced(store.db, [a.id, b.id]);
      recordSurfaced(store.db, [a.id]);
      expect(countOf(store, a.id)).toBe(2);
      expect(countOf(store, b.id)).toBe(1);
    });

    it('is a no-op on empty input', () => {
      expect(() => recordSurfaced(store.db, [])).not.toThrow();
    });
  });

  describe('blendedScore beta term', () => {
    const today = new Date('2026-06-17T12:00:00Z');
    const base = { created_at_epoch: today.getTime(), reinforcement_dates: null };

    it('a more-surfaced note scores higher when beta>0', () => {
      const t = { ...DEFAULT_TUNABLES, beta: 0.1 };
      const cold = blendedScore({ ...base, relevance_count: 0 }, today, t);
      const warm = blendedScore({ ...base, relevance_count: 20 }, today, t);
      expect(warm).toBeGreaterThan(cold);
    });

    it('beta=0 ignores relevance_count entirely', () => {
      const t = { ...DEFAULT_TUNABLES, beta: 0 };
      const a = blendedScore({ ...base, relevance_count: 0 }, today, t);
      const b = blendedScore({ ...base, relevance_count: 999 }, today, t);
      expect(a).toBe(b);
    });
  });
});
