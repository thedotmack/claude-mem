import { describe, it, expect } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

// v64: projectReadKeys runs on every SessionStart render (context cache). Its
// merged-into lookups must be answered from an index, never by loading rows.

describe('projectReadKeys index use (v64)', () => {
  it('answers every lookup from a covering index', () => {
    const store = new SessionStore(':memory:');
    const lookups = [
      `SELECT project FROM observations WHERE merged_into_project COLLATE NOCASE IN (?)`,
      `SELECT project FROM session_summaries WHERE merged_into_project COLLATE NOCASE IN (?)`,
      `SELECT merged_into_project FROM observations WHERE merged_into_project COLLATE NOCASE IN (?)`,
      `SELECT project FROM observations WHERE project COLLATE NOCASE IN (?)`,
    ];
    for (const sql of lookups) {
      const plan = (store.db.query(`EXPLAIN QUERY PLAN ${sql}`).all('app') as Array<{ detail: string }>)
        .map(row => row.detail).join('\n');
      expect(plan).toContain('COVERING INDEX');
    }
  });
});
