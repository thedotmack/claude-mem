import { describe, it, expect, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('SessionStore work state (v61)', () => {
  let store: SessionStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
  });

  it('returns entries oldest first with their fields as written, including null', () => {
    store = new SessionStore(':memory:');
    store.appendWorkStateEntry({ project: 'acme', listName: 'release', fields: { version: '13.25.2', blocked_on: 'npm token' }, createdAtEpoch: 1_000 });
    store.appendWorkStateEntry({ project: 'acme', listName: 'release', fields: { blocked_on: null, attempt: 2, shipped: false }, createdAtEpoch: 2_000 });

    const entries = store.getWorkStateEntries(['acme']);

    expect(entries.map(entry => entry.fields)).toEqual([
      { version: '13.25.2', blocked_on: 'npm token' },
      { blocked_on: null, attempt: 2, shipped: false },
    ]);
    expect(entries.map(entry => entry.created_at_epoch)).toEqual([1_000, 2_000]);
    expect(entries.every(entry => entry.list_name === 'release' && entry.project === 'acme')).toBe(true);
  });

  it('reads every requested project key, case-insensitively, and leaves other projects out', () => {
    store = new SessionStore(':memory:');
    store.appendWorkStateEntry({ project: 'acme', listName: 'release', fields: { version: '1.0' } });
    store.appendWorkStateEntry({ project: 'acme/feature-tree', listName: 'todo', fields: { task: 'tests' } });
    store.appendWorkStateEntry({ project: 'other', listName: 'todo', fields: { task: 'unrelated' } });

    const entries = store.getWorkStateEntries(['ACME', 'acme/feature-tree']);

    expect(entries.map(entry => entry.project)).toEqual(['acme', 'acme/feature-tree']);
    expect(store.getWorkStateEntries([])).toEqual([]);
  });

  it('narrows to one list when named', () => {
    store = new SessionStore(':memory:');
    store.appendWorkStateEntry({ project: 'acme', listName: 'release', fields: { version: '1.0' } });
    store.appendWorkStateEntry({ project: 'acme', listName: 'todo', fields: { task: 'tests' } });

    expect(store.getWorkStateEntries(['acme'], 'todo').map(entry => entry.list_name)).toEqual(['todo']);
  });
});
