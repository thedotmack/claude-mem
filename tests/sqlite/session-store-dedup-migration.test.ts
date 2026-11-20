import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

function cols(store: any, t: string): string[] {
  return (store.db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
}
describe('dedup schema migration (#3038)', () => {
  let store: any;
  beforeEach(() => { store = new SessionStore(':memory:'); });
  afterEach(() => store.close());

  it('still adds the dedup columns to a DB that already recorded v56 without them', () => {
    const db = store.db;
    db.run('DROP INDEX IF EXISTS idx_observations_title_norm');
    db.run('ALTER TABLE observations DROP COLUMN title_norm_key');
    expect(cols(store, 'observations')).not.toContain('title_norm_key');
    new SessionStore(db);
    expect(cols(store, 'observations')).toContain('title_norm_key');
  });
});
