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

const REINFORCEMENT_SCHEMA_VERSION = 54;

describe('reinforcement columns migration', () => {
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

  it('records its schema version once, and re-opening the db is a no-op', () => {
    const db = store.db;
    expect(() => new SessionStore(db)).not.toThrow();
    const versions = db
      .prepare('SELECT COUNT(*) as n FROM schema_versions WHERE version = ?')
      .get(REINFORCEMENT_SCHEMA_VERSION) as { n: number };
    expect(versions.n).toBe(1);
  });

  it('adds the columns even when the version row already exists (PRAGMA is the guard)', () => {
    const db = store.db;
    db.run('ALTER TABLE observations DROP COLUMN last_reinforced');
    db.run('ALTER TABLE observations DROP COLUMN reinforcement_dates');
    expect(observationColumns(db).has('reinforcement_dates')).toBe(false);
    new SessionStore(db);
    const cols = observationColumns(db);
    expect(cols.has('reinforcement_dates')).toBe(true);
    expect(cols.has('last_reinforced')).toBe(true);
  });

  it('leaves rows written outside the write path NULL (no backfill)', () => {
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
