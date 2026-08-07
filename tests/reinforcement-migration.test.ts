// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

interface ColumnInfo {
  name: string;
}

function observationColumns(db: Database): Set<string> {
  const cols = db.query('PRAGMA table_info(observations)').all() as ColumnInfo[];
  return new Set(cols.map(c => c.name));
}

describe('Phase 1a — reinforcement columns migration', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.db.close();
  });

  it('adds reinforcement_dates and last_reinforced to observations', () => {
    const cols = observationColumns(store.db);
    expect(cols.has('reinforcement_dates')).toBe(true);
    expect(cols.has('last_reinforced')).toBe(true);
  });

  it('adds relevance_count for surfacing counts', () => {
    expect(observationColumns(store.db).has('relevance_count')).toBe(true);
  });

  it('records schema versions 50 (reinforcement) and 51 (surfacing)', () => {
    for (const version of [50, 51]) {
      const row = store.db
        .prepare('SELECT version FROM schema_versions WHERE version = ?')
        .get(version) as { version: number } | undefined;
      expect(row?.version).toBe(version);
    }
  });

  it('is idempotent — re-opening the same db does not error or duplicate', () => {
    // Reuse the same underlying Database through a second SessionStore.
    const db = store.db;
    expect(() => new SessionStore(db)).not.toThrow();
    const versions = db
      .prepare('SELECT COUNT(*) as n FROM schema_versions WHERE version = ?')
      .get(50) as { n: number };
    expect(versions.n).toBe(1);
  });

  it('new columns default to NULL (no backfill) and parse as empty history', () => {
    // Insert a minimal observation and confirm the reinforcement fields are NULL.
    store.db.run(
      `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, status, started_at, started_at_epoch)
       VALUES ('c1', 's1', 'proj', 'active', '2026-06-17', 1750000000)`,
    );
    store.db.run(
      `INSERT INTO observations (memory_session_id, project, text, type, created_at, created_at_epoch)
       VALUES ('s1', 'proj', 'hello', 'discovery', '2026-06-17', 1750000000)`,
    );
    const obs = store.db
      .prepare('SELECT reinforcement_dates, last_reinforced FROM observations LIMIT 1')
      .get() as { reinforcement_dates: string | null; last_reinforced: string | null };
    expect(obs.reinforcement_dates).toBeNull();
    expect(obs.last_reinforced).toBeNull();
  });
});
