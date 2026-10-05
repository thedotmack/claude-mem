// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { reinforceObservation } from '../src/services/reinforcement/persist.js';
import { parseReinforcementDates, parseReinforcementHistory } from '../src/services/reinforcement/strength.js';
import { blendedScore } from '../src/services/reinforcement/rank.js';

// The standalone storeObservation() helper is gone — SessionStore owns every
// observation write now, so the write path is exercised through its methods.
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
  return parseReinforcementDates(row.reinforcement_dates);
}

describe('reinforcement on the write path', () => {
  let store: SessionStore;
  const day1 = Date.parse('2026-06-10T12:00:00Z');
  const day2 = Date.parse('2026-06-12T12:00:00Z');

  beforeEach(() => {
    store = new SessionStore(':memory:');
    makeSession(store);
  });
  afterEach(() => store.db.close());

  it('seeds reinforcement_dates with the creation day on insert', () => {
    const { id } = store.storeObservation('s1', 'proj', obs(), 1, 0, day1);
    expect(datesOf(store, id)).toEqual(['2026-06-10']);
    const last = (store.db.prepare('SELECT last_reinforced FROM observations WHERE id=?').get(id) as { last_reinforced: string }).last_reinforced;
    expect(last).toBe('2026-06-10');
  });

  it('reinforces (not drops) an exact-duplicate observation from a later day', () => {
    const first = store.storeObservation('s1', 'proj', obs(), 1, 0, day1);
    const second = store.storeObservation('s1', 'proj', obs(), 2, 0, day2);
    // Same content_hash → same row, no new insert.
    expect(second.id).toBe(first.id);
    expect(datesOf(store, first.id)).toEqual(['2026-06-10', '2026-06-12']);
  });

  it('same-day duplicate is an idempotent no-op', () => {
    const first = store.storeObservation('s1', 'proj', obs(), 1, 0, day1);
    store.storeObservation('s1', 'proj', obs(), 2, 0, day1);
    expect(datesOf(store, first.id)).toEqual(['2026-06-10']);
  });

  it('a re-confirmed observation ranks above a same-day single-event one once ranking is on', () => {
    const today = new Date('2026-06-12T12:00:00Z');
    const a = store.storeObservation('s1', 'proj', obs({ title: 'a', narrative: 'a' }), 1, 0, day1);
    const b = store.storeObservation('s1', 'proj', obs({ title: 'b', narrative: 'b' }), 1, 0, day1);
    store.storeObservation('s1', 'proj', obs({ title: 'b', narrative: 'b' }), 2, 0, day2); // reinforce b
    const rowOf = (id: number) => store.db
      .prepare('SELECT created_at_epoch, reinforcement_dates FROM observations WHERE id = ?')
      .get(id) as { created_at_epoch: number; reinforcement_dates: string };
    expect(blendedScore(rowOf(b.id), today, 0.5)).toBeGreaterThan(blendedScore(rowOf(a.id), today, 0.5));
    expect(blendedScore(rowOf(b.id), today, 0)).toBe(blendedScore(rowOf(a.id), today, 0));
  });

  it('reinforceObservation appends a new day and reports missing rows', () => {
    const { id } = store.storeObservation('s1', 'proj', obs(), 1, 0, day1);
    const changed = reinforceObservation(store.db, id, new Date(day2));
    expect(changed).toBe(true);
    expect(datesOf(store, id)).toEqual(['2026-06-10', '2026-06-12']);
    // missing row → false
    expect(reinforceObservation(store.db, 9999, new Date(day2))).toBe(false);
  });

  it('records seed identity and upgrades legacy arrays on a later confirmation', () => {
    const { id } = store.storeObservation('s1', 'proj', obs(), 1, 0, day1);
    const raw = () => (store.db.prepare('SELECT reinforcement_dates FROM observations WHERE id = ?').get(id) as { reinforcement_dates: string }).reinforcement_dates;
    expect(parseReinforcementHistory(raw()).seedIndex).toBe(0);
    store.db.prepare('UPDATE observations SET reinforcement_dates = ? WHERE id = ?').run(JSON.stringify(['2026-06-10', '2026-06-11']), id);
    expect(reinforceObservation(store.db, id, new Date(day2))).toBe(true);
    expect(parseReinforcementHistory(raw())).toEqual({ dates: ['2026-06-10', '2026-06-11', '2026-06-12'], seedIndex: 0 });
    expect(JSON.parse(raw()).version).toBe(1);
  });

  it('preserves a legacy history whose creation seed is already absent', () => {
    const { id } = store.storeObservation('s1', 'proj', obs(), 1, 0, day1);
    store.db.prepare('UPDATE observations SET reinforcement_dates = ? WHERE id = ?').run(JSON.stringify(['2026-06-11']), id);
    reinforceObservation(store.db, id, new Date(day2));
    const row = store.db.prepare('SELECT reinforcement_dates FROM observations WHERE id = ?').get(id) as { reinforcement_dates: string };
    expect(parseReinforcementHistory(row.reinforcement_dates)).toEqual({ dates: ['2026-06-11', '2026-06-12'], seedIndex: null });
  });

  // Regression: the worker writes observer output through the batch method,
  // not the single-observation one. Live testing found that path unseeded —
  // organic observations landed with NULL reinforcement_dates.
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

});

// With near-duplicate dedup on (#3063), re-confirmations go through its merge
// site; reinforcement reuses that site rather than adding a duplicate path.
describe('reinforcement at the near-duplicate dedup merge site', () => {
  let store: SessionStore;
  const savedDedupEnabled = process.env.CLAUDE_MEM_DEDUP_ENABLED;
  const day1 = Date.parse('2026-06-10T12:00:00Z');
  const day2 = Date.parse('2026-06-12T12:00:00Z');

  beforeEach(() => {
    process.env.CLAUDE_MEM_DEDUP_ENABLED = 'true';
    store = new SessionStore(':memory:');
    makeSession(store, 's1', 'c1');
    makeSession(store, 's2', 'c2');
  });
  afterEach(() => {
    store.db.close();
    if (savedDedupEnabled === undefined) delete process.env.CLAUDE_MEM_DEDUP_ENABLED;
    else process.env.CLAUDE_MEM_DEDUP_ENABLED = savedDedupEnabled;
  });

  it('a Tier-0 merge from another session on a later day re-confirms the canonical row', () => {
    const first = store.storeObservation('s1', 'proj', obs({ title: 'On-Demand Checkpoint.' }), 1, 0, day1);
    const merged = store.storeObservation('s2', 'proj', obs({ title: 'on demand checkpoint', narrative: 'reworded' }), 1, 0, day2);
    expect(merged.id).toBe(first.id);
    expect(datesOf(store, first.id)).toEqual(['2026-06-10', '2026-06-12']);
  });

  it('an exact duplicate re-confirms its row with dedup on, as it does with dedup off', () => {
    const first = store.storeObservation('s1', 'proj', obs(), 1, 0, day1);
    const again = store.storeObservation('s1', 'proj', obs(), 2, 0, day2);
    expect(again.id).toBe(first.id);
    expect(datesOf(store, first.id)).toEqual(['2026-06-10', '2026-06-12']);
  });
});
