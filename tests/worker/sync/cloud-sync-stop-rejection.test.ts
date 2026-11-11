import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { CloudSync, POISON_OP_REJECTION_THRESHOLD } from '../../../src/services/sync/CloudSync.js';

describe('cloud sync ownership after stop', () => {
  for (const stopBeforeReply of [true, false]) {
    it(`${stopBeforeReply ? 'retains' : 'quarantines'} a rejected snapshot when the push ${stopBeforeReply ? 'has stopped' : 'still owns the drain'}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sync-stop-rejection-'));
      const databasePath = join(dir, 'memory.db');
      let store = new SessionStore(databasePath);
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const requested = new Promise<void>(resolve => { entered = resolve; });
      let calls = 0;
      const sync = new CloudSync(store.db, {
        CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'fixture-token', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'fixture-user',
        CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'fixture-device', CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'http://127.0.0.1:1',
      }, {
        settingsPath: join(dir, 'settings.json'), backoffInitialMs: 60_000,
        fetchImpl: (async (_url, init) => {
          const ops = JSON.parse(String(init?.body)).ops;
          expect(ops).toHaveLength(1);
          if (++calls === POISON_OP_REJECTION_THRESHOLD) { entered(); await held; }
          return Response.json({ error: 'invalid_ops: ops[0] fixture rejection' }, { status: 400 });
        }) as typeof fetch,
      });
      let pending: Promise<void> | undefined;
      try {
        const session = store.createSDKSession('host-session', 'project', 'Keep this prompt');
        store.saveUserPrompt('host-session', 1, 'Keep this prompt', session);
        for (let i = 1; i < POISON_OP_REJECTION_THRESHOLD; i++) await sync.flush();
        expect(store.db.query('SELECT count(*) AS n FROM sync_content_outbox').get()).toEqual({ n: 1 });
        pending = sync.flush();
        await requested;
        if (stopBeforeReply) sync.stop();
        release();
        await pending;
        sync.stop();
        store.close();
        store = new SessionStore(databasePath);
        expect(store.db.query('SELECT count(*) AS n FROM sync_content_outbox').get()).toEqual({ n: stopBeforeReply ? 1 : 0 });
        expect(store.db.query('SELECT count(*) AS n FROM sync_dead_letter').get()).toEqual({ n: stopBeforeReply ? 0 : 1 });
        expect(store.db.query('SELECT synced_at FROM user_prompts').get()).toEqual({ synced_at: stopBeforeReply ? null : -1 });
        expect(calls).toBe(POISON_OP_REJECTION_THRESHOLD);
      } finally {
        release();
        await pending;
        sync.stop();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
