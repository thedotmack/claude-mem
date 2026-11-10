import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readGoals } from '../../src/services/work-view/request-groups.mjs';

function fixture(rows) {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
  const insert = database.prepare('INSERT INTO work_state_entries VALUES (?, ?, ?, ?, ?)');
  for (const [id, at, fields] of rows) insert.run(id, 'repo', 'owner-goals', JSON.stringify(fields), at);
  return database;
}

describe('owner goal chronological replay', () => {
  it('keeps completed goals closed when older active rows are imported later', () => {
    const database = fixture([
      [1, 3000, { task: 'search', status: 'done' }],
      [99, 1000, { task: 'search', status: 'doing', goal_kind: 'ask', title: 'Fix search' }],
    ]);
    try {
      expect(readGoals(database).goals).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('keeps the latest list summary and clears fields in event order', () => {
    const database = fixture([
      [1, 3000, { human_summary: 'Current focus', generated_at: '2026-11-09', map_path: null }],
      [99, 1000, { human_summary: 'Old focus', generated_at: '2026-10-01', map_path: '/old-map.json' }],
    ]);
    try {
      expect(readGoals(database)).toEqual({
        summary: 'Current focus',
        generatedAt: '2026-11-09',
        mapPath: null,
        goals: [],
      });
    } finally {
      database.close();
    }
  });

  it('uses row IDs to preserve deterministic ordering for equal timestamps', () => {
    const database = fixture([
      [1, 1000, { task: 'search', goal_kind: 'ask', title: 'Old title', status: 'doing' }],
      [2, 1000, { task: 'search', title: 'Current title' }],
    ]);
    try {
      const goals = readGoals(database).goals;
      expect(goals).toHaveLength(1);
      expect(goals[0].title).toBe('Current title');
    } finally {
      database.close();
    }
  });
});
