import { describe, it, expect } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

// v64: projectReadKeys runs on every SessionStart render (context cache). Its
// merged-into lookups must be answered from an index, never by loading rows.

describe('projectReadKeys index use (v64)', () => {
  it('answers every lookup from a covering index', () => {
    const store = new SessionStore(':memory:');
    const lookups: Array<{ sql: string; params: string[] }> = [
      {
        sql: `SELECT merged_into_project FROM observations WHERE merged_into_project COLLATE NOCASE IN (?)`,
        params: ['app'],
      },
      {
        sql: `SELECT project FROM observations WHERE project COLLATE NOCASE IN (?)`,
        params: ['app'],
      },
      // #4782 — the wholesale-merge promotion branch: candidates, then a
      // stored-rows vs stamped-rows count per candidate, all index-answered.
      {
        sql: `SELECT candidates.key FROM (
          SELECT project AS key FROM observations WHERE merged_into_project COLLATE NOCASE IN (?)
          UNION
          SELECT project AS key FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (?)
        ) candidates
        WHERE (
          (SELECT COUNT(*) FROM observations WHERE project COLLATE NOCASE = candidates.key)
          + (SELECT COUNT(*) FROM session_summaries WHERE project COLLATE NOCASE = candidates.key)
        ) = (
          (SELECT COUNT(*) FROM observations
            WHERE project COLLATE NOCASE = candidates.key AND merged_into_project COLLATE NOCASE IN (?))
          + (SELECT COUNT(*) FROM session_summaries
            WHERE project COLLATE NOCASE = candidates.key AND merged_into_project COLLATE NOCASE IN (?))
        )`,
        params: ['app', 'app', 'app', 'app'],
      },
    ];
    for (const { sql, params } of lookups) {
      const plan = (store.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map(row => row.detail).join('\n');
      expect(plan).toContain('COVERING INDEX');
    }
  });
});
