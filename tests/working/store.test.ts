// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import {
  appendJournal,
  closeTask,
  DEFAULT_TASK_KEY,
  capTasksForRender,
  dropEntry,
  estimateTokens,
  listEntries,
  promoteEntry,
  setEntry,
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

  it('token budget counts intent rows only — the journal can never starve the agent', () => {
    const lim = limits({ maxKeys: 10, maxTokens: 5 }); // 20 chars of intent budget
    appendJournal(store.db, 'proj', DEFAULT_TASK_KEY, 'x'.repeat(4000), lim, NOW); // fat journal row

    // A small intent write succeeds despite the journal being way over budget:
    // the journal is bounded by its ring, not by the agent's token budget.
    const ok = setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'small', 'fits', lim, NOW);
    expect(ok.value).toBe('fits');

    // …while intent-only overflow is still rejected.
    let caught: unknown = null;
    try {
      setEntry(store.db, 'proj', DEFAULT_TASK_KEY, 'big', 'x'.repeat(17), lim, NOW); // 4 + 17 > 20
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkingLimitError);
  });

  it('capTasksForRender keeps whole freshest tasks within the global budget', () => {
    const lim = limits({ maxTokens: 10 }); // 40 chars global
    setEntry(store.db, 'proj', 'old-task', 'k', 'o'.repeat(30), lim, NOW);
    setEntry(store.db, 'proj', 'mid-task', 'k', 'm'.repeat(30), lim, NOW + DAY_MS);
    setEntry(store.db, 'proj', 'new-task', 'k', 'n'.repeat(30), lim, NOW + 2 * DAY_MS);

    const capped = capTasksForRender(listEntries(store.db, 'proj', undefined, NOW + 3 * DAY_MS), lim);
    const tasks = [...new Set(capped.map(e => e.task_key))];
    // Only the freshest task fits the 40-char budget; the rest wait for TTL/close.
    expect(tasks).toEqual(['new-task']);
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
