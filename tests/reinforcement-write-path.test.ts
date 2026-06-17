// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { storeObservation } from '../src/services/sqlite/observations/store.js';
import { reinforceObservation, observationStrength } from '../src/services/reinforcement/persist.js';
import type { ObservationInput } from '../src/services/sqlite/observations/types.js';

const DAY = 86_400_000;
const obs = (over: Partial<ObservationInput> = {}): ObservationInput => ({
  type: 'discovery',
  title: 'reddit warmup',
  subtitle: null,
  facts: [],
  narrative: 'browser warmup beats headless',
  concepts: [],
  files_read: [],
  files_modified: [],
  ...over,
});

function makeSession(store: SessionStore, memId = 's1', contentId = 'c1'): void {
  store.db.run(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, status, started_at, started_at_epoch)
     VALUES (?, ?, 'proj', 'active', '2026-06-17', 1750000000)`,
    [contentId, memId],
  );
}

function datesOf(store: SessionStore, id: number): string[] {
  const row = store.db
    .prepare('SELECT reinforcement_dates FROM observations WHERE id = ?')
    .get(id) as { reinforcement_dates: string | null };
  return JSON.parse(row.reinforcement_dates ?? '[]');
}

describe('Phase 1c — reinforcement on the write path', () => {
  let store: SessionStore;
  const day1 = Date.parse('2026-06-10T12:00:00Z');
  const day2 = Date.parse('2026-06-12T12:00:00Z');

  beforeEach(() => {
    store = new SessionStore(':memory:');
    makeSession(store);
  });
  afterEach(() => store.db.close());

  it('seeds reinforcement_dates with the creation day on insert', () => {
    const { id } = storeObservation(store.db, 's1', 'proj', obs(), 1, 0, day1);
    expect(datesOf(store, id)).toEqual(['2026-06-10']);
    const last = (store.db.prepare('SELECT last_reinforced FROM observations WHERE id=?').get(id) as { last_reinforced: string }).last_reinforced;
    expect(last).toBe('2026-06-10');
  });

  it('reinforces (not drops) an exact-duplicate observation from a later day', () => {
    const first = storeObservation(store.db, 's1', 'proj', obs(), 1, 0, day1);
    const second = storeObservation(store.db, 's1', 'proj', obs(), 2, 0, day2);
    // Same content_hash → same row, no new insert.
    expect(second.id).toBe(first.id);
    expect(datesOf(store, first.id)).toEqual(['2026-06-10', '2026-06-12']);
  });

  it('same-day duplicate is an idempotent no-op', () => {
    const first = storeObservation(store.db, 's1', 'proj', obs(), 1, 0, day1);
    storeObservation(store.db, 's1', 'proj', obs(), 2, 0, day1);
    expect(datesOf(store, first.id)).toEqual(['2026-06-10']);
  });

  it('reinforced duplicate has higher strength than a single-event note', () => {
    const today = new Date('2026-06-12T12:00:00Z');
    const a = storeObservation(store.db, 's1', 'proj', obs({ title: 'a', narrative: 'a' }), 1, 0, day1);
    const b = storeObservation(store.db, 's1', 'proj', obs({ title: 'b', narrative: 'b' }), 1, 0, day1);
    storeObservation(store.db, 's1', 'proj', obs({ title: 'b', narrative: 'b' }), 2, 0, day2); // reinforce b
    expect(observationStrength(store.db, b.id, today)).toBeGreaterThan(
      observationStrength(store.db, a.id, today),
    );
  });

  it('reinforceObservation can be called directly (retrieval-feedback path)', () => {
    const { id } = storeObservation(store.db, 's1', 'proj', obs(), 1, 0, day1);
    const changed = reinforceObservation(store.db, id, new Date(day2));
    expect(changed).toBe(true);
    expect(datesOf(store, id)).toEqual(['2026-06-10', '2026-06-12']);
    // missing row → false
    expect(reinforceObservation(store.db, 9999, new Date(day2))).toBe(false);
  });

  // Regression: the worker writes observer output through the SessionStore
  // *methods* (storeObservations / storeObservationsAndMarkComplete), NOT the
  // standalone storeObservation() above. Live testing found those paths were
  // unseeded — organic observations landed with NULL reinforcement_dates.
  it('SessionStore.storeObservations (the worker batch path) seeds reinforcement', () => {
    const { observationIds } = store.storeObservations(
      's1',
      'proj',
      [obs({ title: 'batch a', narrative: 'a' }), obs({ title: 'batch b', narrative: 'b' })],
      null,
      1,
      0,
      day1,
      'claude-sonnet-4-5',
    );
    expect(observationIds.length).toBe(2);
    for (const id of observationIds) {
      expect(datesOf(store, id)).toEqual(['2026-06-10']);
      const row = store.db.prepare('SELECT last_reinforced FROM observations WHERE id=?').get(id) as { last_reinforced: string };
      expect(row.last_reinforced).toBe('2026-06-10');
    }
  });

  it('SessionStore.storeObservation (method) seeds and reinforces on exact dup', () => {
    const first = store.storeObservation('s1', 'proj', obs({ title: 'm', narrative: 'm' }), 1, 0, day1);
    expect(datesOf(store, first.id)).toEqual(['2026-06-10']);
    const again = store.storeObservation('s1', 'proj', obs({ title: 'm', narrative: 'm' }), 2, 0, day2);
    expect(again.id).toBe(first.id);
    expect(datesOf(store, first.id)).toEqual(['2026-06-10', '2026-06-12']);
  });
});
