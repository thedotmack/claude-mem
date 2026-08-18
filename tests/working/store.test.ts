// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import {
  appendJournal,
  closeTask,
  DEFAULT_TASK_KEY,
  dropEntry,
  estimateTokens,
  listEntries,
  promoteEntry,
  setEntry,
  touchTtl,
  WorkingLimitError,
  WorkingNotFoundError,
  type WorkingLimits,
} from '../../src/services/working/store.js';

const NOW = new Date('2026-08-18T12:00:00Z').getTime();
const DAY_MS = 86_400_000;

const limits = (over: Partial<WorkingLimits> = {}): WorkingLimits => ({
  maxKeys: 3,
  maxTokens: 1000,
  journalSize: 3,
  ttlDays: 7,
  ...over,
});

let store: SessionStore;

beforeEach(() => {
  store = new SessionStore(':memory:');
});

describe('working memory store', () => {
  it('creates the working_memory table (schema v56)', () => {
    const table = store.db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'working_memory'"
    ).all();
    expect(table.length).toBe(1);
    const version = store.db.prepare('SELECT version FROM schema_versions WHERE version = 56').get();
    expect(version).toBeTruthy();
  });

  it('upserts by (project, task_key, key) instead of appending', () => {
    setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'hypothesis', 'v1', limits(), NOW);
    const updated = setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'hypothesis', 'v2', limits(), NOW + 1000);

    const entries = listEntries(store.db, 'proj', DEFAULT_TASK_KEY, NOW + 1000);
    expect(entries.length).toBe(1);
    expect(updated.value).toBe('v2');
    expect(updated.updated_at_epoch).toBe(NOW + 1000);
    // created_at survives the upsert; TTL slides with the update.
    expect(updated.created_at_epoch).toBe(NOW);
    expect(updated.expires_at_epoch).toBe(NOW + 1000 + 7 * DAY_MS);
  });

  it('rejects a new intent key beyond maxKeys with a 409-style key list', () => {
    const lim = limits({ maxKeys: 3 });
    setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'a', '1', lim, NOW);
    setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'b', '22', lim, NOW);
    setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'c', '333', lim, NOW);

    let caught: WorkingLimitError | null = null;
    try {
      setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'd', '4', lim, NOW);
    } catch (error) {
      caught = error as WorkingLimitError;
    }

    expect(caught).toBeInstanceOf(WorkingLimitError);
    expect(caught!.code).toBe('WORKING_LIMIT');
    expect(caught!.keys.map(k => k.key)).toEqual(['a', 'b', 'c']);
    expect(caught!.keys.map(k => k.chars)).toEqual([1, 2, 3]);

    // Upserting an EXISTING key still works at the limit.
    const again = setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'a', 'updated', lim, NOW);
    expect(again.value).toBe('updated');
  });

  it('does not count journal rows against the intent slot limit', () => {
    const lim = limits({ maxKeys: 1, journalSize: 5 });
    appendJournal(store.db, 'proj', DEFAULT_TASK_KEY, 'Read src/x.ts', lim, NOW);
    appendJournal(store.db, 'proj', DEFAULT_TASK_KEY, 'Edit src/y.ts', lim, NOW);
    setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'plan', 'do the thing', lim, NOW);

    let caught: unknown = null;
    try {
      setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'second', 'slot', lim, NOW);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkingLimitError);
    expect((caught as WorkingLimitError).keys.map(k => k.key)).toEqual(['plan']);
  });

  it('rejects writes that exceed the token budget (journal counts toward it)', () => {
    const lim = limits({ maxKeys: 10, maxTokens: 5 }); // 20 chars total
    appendJournal(store.db, 'proj', DEFAULT_TASK_KEY, '1234567890', lim, NOW); // 10 chars of journal

    let caught: unknown = null;
    try {
      setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'big', 'x'.repeat(11), lim, NOW); // 10 + 11 > 20
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkingLimitError);
    expect((caught as WorkingLimitError).keys.some(k => k.chars === 10)).toBe(true);

    const ok = setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'small', 'x'.repeat(10), lim, NOW);
    expect(ok.key).toBe('small');
  });

  it('keeps the journal as a ring of journalSize, evicting the oldest', () => {
    const lim = limits({ journalSize: 3 });
    for (let i = 1; i <= 5; i++) {
      appendJournal(store.db, 'proj', DEFAULT_TASK_KEY, `line ${i}`, lim, NOW + i);
    }

    const journal = listEntries(store.db, 'proj', DEFAULT_TASK_KEY, NOW + 10)
      .filter(e => e.kind === 'journal');
    expect(journal.map(e => e.value)).toEqual(['line 3', 'line 4', 'line 5']);
  });

  it('lazily filters expired entries on read', () => {
    const lim = limits({ ttlDays: 1 });
    setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'stale', 'old', lim, NOW);
    setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'fresh', 'new', lim, NOW + 2 * DAY_MS);

    const at = NOW + 2.5 * DAY_MS; // 'stale' expired at NOW+1d, 'fresh' lives until NOW+3d
    const keys = listEntries(store.db, 'proj', DEFAULT_TASK_KEY, at).map(e => e.key);
    expect(keys).toEqual(['fresh']);

    // The expired row is filtered, not deleted — no timers anywhere.
    const raw = store.db.prepare('SELECT COUNT(*) AS n FROM working_memory').get() as { n: number };
    expect(raw.n).toBe(2);
  });

  it('touchTtl slides the expiry window', () => {
    const lim = limits({ ttlDays: 1 });
    setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'k', 'v', lim, NOW);
    touchTtl(store.db, 'proj', DEFAULT_TASK_KEY, 'k', lim, NOW + 2 * DAY_MS);

    const entries = listEntries(store.db, 'proj', DEFAULT_TASK_KEY, NOW + 2.5 * DAY_MS);
    expect(entries.length).toBe(1);
    expect(entries[0].expires_at_epoch).toBe(NOW + 3 * DAY_MS);

    expect(() => touchTtl(store.db, 'proj', DEFAULT_TASK_KEY, 'missing', lim, NOW)).toThrow(WorkingNotFoundError);
  });

  it('promote stores a real observation and clears the slot', () => {
    setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'confirmed', 'the fix was the config', limits(), NOW);

    const result = promoteEntry(store, 'proj', DEFAULT_TASK_KEY, 'confirmed', 'decision', NOW + 1000);

    const obs = store.db.prepare('SELECT * FROM observations WHERE id = ?').get(result.observationId) as any;
    expect(obs).toBeTruthy();
    expect(obs.type).toBe('decision');
    expect(obs.narrative).toBe('the fix was the config');
    expect(obs.project).toBe('proj');

    expect(listEntries(store.db, 'proj', DEFAULT_TASK_KEY, NOW + 1000)).toEqual([]);
    expect(() => promoteEntry(store, 'proj', DEFAULT_TASK_KEY, 'confirmed', 'decision', NOW)).toThrow(WorkingNotFoundError);
  });

  it('refuses to promote an expired entry', () => {
    setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'k', 'v', limits({ ttlDays: 1 }), NOW);
    expect(() => promoteEntry(store, 'proj', DEFAULT_TASK_KEY, 'k', 'decision', NOW + 2 * DAY_MS))
      .toThrow(WorkingNotFoundError);
  });

  it('closeTask drops the whole set (intent + journal) for the task only', () => {
    const lim = limits();
    setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'a', '1', lim, NOW);
    appendJournal(store.db, 'proj', DEFAULT_TASK_KEY, 'j1', lim, NOW);
    setEntry(store.db, 'proj', 'other-task', 'b', '2', lim, NOW);

    const dropped = closeTask(store.db, 'proj', DEFAULT_TASK_KEY);
    expect(dropped).toBe(2);

    expect(listEntries(store.db, 'proj', DEFAULT_TASK_KEY, NOW)).toEqual([]);
    expect(listEntries(store.db, 'proj', 'other-task', NOW).length).toBe(1);
  });

  it('dropEntry removes one slot and reports missing keys', () => {
    setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'a', '1', limits(), NOW);
    dropEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'a');
    expect(listEntries(store.db, 'proj', DEFAULT_TASK_KEY, NOW)).toEqual([]);
    expect(() => dropEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'a')).toThrow(WorkingNotFoundError);
  });

  it('listEntries without a task spans all tasks of the project (injection path)', () => {
    const lim = limits();
    setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'a', '1', lim, NOW);
    setEntry(store.db, 'proj', 'named-task', 'b', '2', lim, NOW);
    setEntry(store.db, 'other-proj', DEFAULT_TASK_KEY, 'c', '3', lim, NOW);

    const entries = listEntries(store.db, 'proj', undefined, NOW);
    expect(entries.map(e => e.key).sort()).toEqual(['a', 'b']);
  });

  it('estimateTokens uses the chars/4 heuristic', () => {
    expect(estimateTokens([{ value: '1234' }, { value: '12345' }])).toBe(Math.ceil(9 / 4));
    expect(estimateTokens([])).toBe(0);
  });
});
