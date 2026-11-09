import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { backfillProjectDedup, bumpTokenDf, getProjectDocCount } from '../../src/services/sqlite/dedup-store.js';

function insert(db: Database, title: string) {
  db.prepare(`INSERT INTO observations
    (memory_session_id, project, type, title, created_at, created_at_epoch)
    VALUES ('memory', 'app', 'discovery', ?, '2026-11-01T00:00:00.000Z', 1793491200000)`).run(title);
  bumpTokenDf(db, 'app', title);
}

function seed(store: SessionStore) {
  const session = store.createSDKSession('content', 'app', 'prompt');
  store.updateMemorySessionId(session, 'memory');
  insert(store.db, 'shared original');
}

describe('dedup rebuild snapshot', () => {
  it('does not replace an intervening writer\'s IDF increments with an older snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-mem-dedup-snapshot-'));
    const path = join(directory, 'memory.db');
    const store = new SessionStore(path);
    const writer = new Database(path);
    writer.exec('PRAGMA busy_timeout = 0');
    try {
      seed(store);
      let attempted = false;
      let waitingForRebuild = false;
      const write = writer.transaction(() => insert(writer, 'shared concurrent'));
      // Place a second real SQLite connection at the snapshot/write boundary.
      // An immediate rebuild transaction makes this writer wait; without it,
      // its successful increments are overwritten by the stale snapshot.
      const observed = new Proxy(store.db, {
        get(target, property) {
          if (property !== 'prepare') {
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.startsWith('SELECT o.id, o.title')) return statement;
            return new Proxy(statement, {
              get(query, method) {
                if (method !== 'all') {
                  const value = Reflect.get(query, method, query);
                  return typeof value === 'function' ? value.bind(query) : value;
                }
                return (...args: any[]) => {
                  const rows = query.all(...args);
                  attempted = true;
                  try { write(); }
                  catch (error) {
                    if (!/locked|busy/i.test(String(error))) throw error;
                    waitingForRebuild = true;
                  }
                  return rows;
                };
              },
            });
          };
        },
      });

      expect(backfillProjectDedup(observed, 'app')).toBe(1);
      expect(attempted).toBe(true);
      if (waitingForRebuild) write();
      expect((store.db.prepare('SELECT COUNT(*) AS count FROM observations').get() as any).count).toBe(2);
      expect(getProjectDocCount(store.db, 'app')).toBe(2);
      expect(store.db.prepare('SELECT token, df FROM token_df ORDER BY token').all()).toEqual([
        { token: 'concurrent', df: 1 }, { token: 'original', df: 1 }, { token: 'shared', df: 2 },
      ]);
    } finally {
      writer.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the existing model and keys intact if rebuilding fails', () => {
    const store = new SessionStore(':memory:');
    try {
      seed(store);
      store.db.exec(`CREATE TRIGGER reject_rebuild BEFORE INSERT ON token_df
        WHEN NEW.token = 'original' BEGIN SELECT RAISE(ABORT, 'rebuild failed'); END`);
      expect(() => backfillProjectDedup(store.db, 'app')).toThrow('rebuild failed');
      expect(getProjectDocCount(store.db, 'app')).toBe(1);
      expect((store.db.prepare('SELECT title_norm_key FROM observations').get() as any).title_norm_key).toBeNull();
      expect(store.db.prepare('SELECT token, df FROM token_df ORDER BY token').all()).toEqual([
        { token: 'original', df: 1 }, { token: 'shared', df: 1 },
      ]);
    } finally { store.close(); }
  });

  it('leaves a capped project untouched and releases its write reservation', () => {
    const store = new SessionStore(':memory:');
    try {
      seed(store);
      expect(backfillProjectDedup(store.db, 'app', 0)).toBe(0);
      expect(getProjectDocCount(store.db, 'app')).toBe(1);
      expect(store.db.inTransaction).toBe(false);
      expect((store.db.prepare('SELECT title_norm_key FROM observations').get() as any).title_norm_key).toBeNull();
    } finally { store.close(); }
  });
});
