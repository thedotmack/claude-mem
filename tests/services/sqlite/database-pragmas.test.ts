import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';

function busyTimeout(db: Database): number {
  return (db.query('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
}

describe('SQLite connection pragmas', () => {
  it('sets busy_timeout on SessionStore-owned connections', () => {
    const store = new SessionStore(':memory:');
    try {
      expect(busyTimeout(store.db)).toBe(5000);
    } finally {
      store.db.close();
    }
  });

  it('sets busy_timeout on existing connections handed to SessionStore', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db);
      expect(busyTimeout(db)).toBe(5000);
    } finally {
      db.close();
    }
  });

  it('sets busy_timeout on existing connections handed to SessionSearch', () => {
    const db = new Database(':memory:');
    try {
      new SessionSearch(db);
      expect(busyTimeout(db)).toBe(5000);
    } finally {
      db.close();
    }
  });
});
