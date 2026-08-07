// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { recordRetrieved } from '../src/services/reinforcement/persist.js';
import { parseReinforcementDates } from '../src/services/reinforcement/strength.js';

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

const datesOf = (store: SessionStore, id: number): string[] =>
  parseReinforcementDates(
    (store.db.prepare('SELECT reinforcement_dates FROM observations WHERE id=?').get(id) as { reinforcement_dates: string | null }).reinforcement_dates,
  );

describe('Phase 5 — retrieval practice (recordRetrieved)', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore(':memory:');
    makeSession(store);
  });
  afterEach(() => store.db.close());

  it('active recall appends a real reinforcement date', () => {
    const created = Date.parse('2026-06-10T12:00:00Z');
    const a = store.storeObservation('s1', 'proj', obs({ title: 'a', narrative: 'a' }), 1, 0, created);
    expect(datesOf(store, a.id)).toEqual(['2026-06-10']);

    const today = new Date('2026-06-17T12:00:00Z');
    const changed = recordRetrieved(store.db, [a.id], today);
    expect(changed).toBe(1);
    expect(datesOf(store, a.id)).toEqual(['2026-06-10', '2026-06-17']);
  });

  it('is same-day idempotent — re-fetching within a day cannot inflate a note', () => {
    const created = Date.parse('2026-06-10T12:00:00Z');
    const a = store.storeObservation('s1', 'proj', obs({ title: 'a', narrative: 'a' }), 1, 0, created);
    const today = new Date('2026-06-17T12:00:00Z');

    expect(recordRetrieved(store.db, [a.id], today)).toBe(1);
    expect(recordRetrieved(store.db, [a.id], today)).toBe(0);
    expect(datesOf(store, a.id)).toEqual(['2026-06-10', '2026-06-17']);
  });

  it('ignores missing rows and empty input', () => {
    expect(recordRetrieved(store.db, [], new Date())).toBe(0);
    expect(recordRetrieved(store.db, [999999], new Date())).toBe(0);
  });
});
