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

const REINFORCEMENT_SCHEMA_VERSION = 57;

describe('reinforcement columns migration', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.db.close();
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

});
