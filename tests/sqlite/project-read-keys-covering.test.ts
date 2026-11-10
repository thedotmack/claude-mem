import { describe, it, expect } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { projectReadKeys } from '../../src/services/sqlite/project-read-keys.js';

// v64: projectReadKeys runs on every SessionStart render (context cache). Its
// merged-into lookups must be answered from an index, never by loading rows.
// Every table access in a plan is checked, not just one: a single
// `COVERING INDEX` in the combined plan can hide a count that reads table
// rows (#4789 review).

describe('projectReadKeys index use (v64)', () => {
  it('answers every lookup from a covering index', () => {
    const store = new SessionStore(':memory:');
    const prepare = store.db.prepare;
    const queries: string[] = [];
    try {
      store.db.prepare = ((...args: Parameters<typeof prepare>) => {
        queries.push(args[0]);
        return prepare.apply(store.db, args);
      }) as typeof prepare;
      try {
        projectReadKeys(store.db, ['app']);
      } finally {
        store.db.prepare = prepare;
      }
      expect(queries.length).toBeGreaterThan(0);
      for (const sql of queries) {
        const plan = (store.db.query(`EXPLAIN QUERY PLAN ${sql}`).all('app') as Array<{ detail: string }>)
          .map(row => row.detail);
        const tableAccesses = plan.filter(line =>
          /\b(SCAN|SEARCH)\s+(observations|session_summaries|sdk_sessions)\b/.test(line)
        );
        expect(tableAccesses.length).toBeGreaterThan(0);
        for (const access of tableAccesses) {
          expect(access).toContain('USING COVERING INDEX');
        }
      }
    } finally {
      store.close();
    }
  });
});
