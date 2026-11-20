import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { getWorkStateEntries } from '../../src/services/sqlite/work-state.js';
import { isSharedWorkList } from '../../src/services/work-view/shared-records.mjs';
import { foldWorkStateList } from '../../src/services/context/sections/WorkStateRenderer.js';

function metered(db: Database) {
  const reads = { rows: 0, bytes: 0, queries: 0 };
  return { reads, db: new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(stmt, member) {
        if (member === 'all') return (...args: unknown[]) => {
          const rows = (stmt.all as Function).apply(stmt, args);
          if (sql.includes('FROM work_state_entries')) {
            reads.queries++;
            reads.rows += rows.length;
            reads.bytes += rows.reduce((sum: number, row: { fields: string }) => sum + Buffer.byteLength(row.fields), 0);
          }
          return rows;
        };
        const value = Reflect.get(stmt, member);
        return typeof value === 'function' ? value.bind(stmt) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) };
}

describe('work-state reads exclude shared payloads in SQLite', () => {
  it('does not transfer shared My Work payloads into a small SessionStart history', () => {
    const store = new SessionStore(':memory:');
    try {
      for (let i = 0; i < 80; i++) {
        store.appendWorkStateEntry({ project: 'repo', listName: '__my_work_v1:entry',
          fields: { payload: 'x'.repeat(48000) }, createdAtEpoch: i });
      }
      store.appendWorkStateEntry({ project: 'repo', listName: 'release', fields: { next: 'verify' }, createdAtEpoch: 100 });
      const measured = metered(store.db);
      expect(getWorkStateEntries(measured.db, ['REPO']).map(row => row.fields)).toEqual([{ next: 'verify' }]);
      expect(measured.reads.rows).toBe(1);
      expect(measured.reads.bytes).toBeLessThan(100);
    } finally { store.close(); }
  });

  it('matches the reserved version grammar exactly, including future versions and similar authored names', () => {
    const store = new SessionStore(':memory:');
    try {
      const names = ['__my_work_v1:entry', '__my_work_v002:manifest', '__my_work_v99:anything',
        '__my_work_v1:', '__my_work_v1:entry:part', '__my_work_v:notes', '__my_work_v1draft:notes',
        '__my_work_v1.2:notes', '__my_work_v١:notes', '__MY_WORK_V1:notes', 'prefix__my_work_v1:notes',
        '__my_work_v1', '__my_work_v1\n:notes', 'ordinary'];
      names.forEach((listName, index) => store.appendWorkStateEntry({ project: 'repo', listName,
        fields: { task: listName }, createdAtEpoch: index }));
      const expected = names.filter(name => !isSharedWorkList(name));
      const measured = metered(store.db);
      expect(getWorkStateEntries(measured.db, ['repo']).map(row => row.list_name)).toEqual(expected);
      expect(measured.reads.rows).toBe(expected.length);
    } finally { store.close(); }
  });

  it('preserves complete public history and project/list scope while avoiding a named shared-list read', () => {
    const store = new SessionStore(':memory:');
    try {
      store.appendWorkStateEntry({ project: 'repo', listName: 'release', fields: { next: 'test', owner: 'me' }, createdAtEpoch: 100 });
      store.appendWorkStateEntry({ project: 'other', listName: 'release', fields: { next: 'unrelated' }, createdAtEpoch: 200 });
      store.appendWorkStateEntry({ project: 'repo', listName: '__my_work_v2:entry', fields: { payload: 'shared' }, createdAtEpoch: 300 });
      store.appendWorkStateEntry({ project: 'repo', listName: 'release', fields: { next: null, status: 'done' }, createdAtEpoch: 400 });
      const measured = metered(store.db);
      const entries = getWorkStateEntries(measured.db, ['REPO'], 'release');
      expect(entries).toHaveLength(2);
      expect(foldWorkStateList(entries).state).toEqual({ next: null, owner: 'me', status: 'done' });
      const before = measured.reads.queries;
      expect(getWorkStateEntries(measured.db, ['repo'], '__my_work_v2:entry')).toEqual([]);
      expect(measured.reads.queries).toBe(before);
    } finally { store.close(); }
  });
});
