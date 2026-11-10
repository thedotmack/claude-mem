import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { swapDatabaseFromSnapshot } from '../../src/services/backup/restore-swap.js';

test.each(['sdk_sessions', 'observations', 'session_summaries'] as const)(
  'rejects a current-schema snapshot without %s before changing the live database', async (table) => {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-restore-audit-'));
    try {
      const live = join(dir, 'live.db');
      const snap = join(dir, 'snapshot.db');
      const store = new SessionStore(live);
      store.createSDKSession('live-session', 'fixture', 'prompt');
      const stamp = store.db.query('PRAGMA user_version').get();
      store.db.run("VACUUM INTO ?", [snap]);
      store.close();
      const damaged = new Database(snap);
      damaged.run('PRAGMA foreign_keys=OFF');
      damaged.run(`DROP TABLE ${table}`);
      expect(damaged.query('PRAGMA user_version').get()).toEqual(stamp);
      expect(damaged.query('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
      damaged.close();
      const before = readFileSync(live);
      await expect(swapDatabaseFromSnapshot(live, snap, { preRestoreDir: dir })).rejects.toThrow(`required worker table ${table}`);
      expect(readFileSync(live)).toEqual(before);
      expect(readdirSync(dir).filter(name => name.includes('restore-'))).toEqual([]);
      const after = new Database(live, { readonly: true });
      try {
        expect(after.query('SELECT content_session_id FROM sdk_sessions').get()).toEqual({ content_session_id: 'live-session' });
      } finally { after.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
);
