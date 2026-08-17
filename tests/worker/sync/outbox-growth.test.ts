// sync_outbox growth bounds — the two halves of the unbounded-growth fix:
//
//   1. PRODUCER GATE: sync_outbox rows are only ever deleted by CloudSync's
//      ack path, and DatabaseManager constructs CloudSync iff cloud sync is
//      fully credentialed. SessionStore therefore takes the same
//      configuration state (syncOpsEnabled) and enqueues NOTHING when it is
//      false — an unconfigured install must not produce ops it can never
//      drain. The default stays true (pre-flag behavior) so direct
//      constructions keep enqueueing.
//   2. SUPERSEDE, DON'T APPEND: each session (re)start can mint a fresh
//      synthetic memory_session_id, and every re-registration re-emits one
//      set_prompt_session op per prompt in the session (requeuePromptSync,
//      full history each time). Observed in a live unconfigured 13.15.0
//      deployment: 369 distinct prompts amplified into 10,457 queued ops
//      (28x) across ~20 sessions x ~21 re-registrations. The newest op per
//      (op, target) carries the complete field set at the highest rev
//      (the mutation site bumps sync_rev before each enqueue), so enqueueing
//      now deletes the superseded queued op first — bounding the outbox at
//      one row per prompt regardless of re-registration count.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore, type SessionStoreOptions } from '../../../src/services/sqlite/SessionStore.js';

const ISO = '2026-07-09T00:00:00.000Z';

interface OutboxRow {
  op_uuid: string;
  rev: string;
  body: any;
}

function outboxRows(db: Database): OutboxRow[] {
  return (db.prepare('SELECT op_uuid, CAST(rev AS TEXT) AS rev, body FROM sync_outbox ORDER BY id').all() as Array<{ op_uuid: string; rev: string; body: string }>)
    .map(r => ({ op_uuid: r.op_uuid, rev: r.rev, body: JSON.parse(r.body) }));
}

function seedSessionWithPrompts(db: Database, promptCount: number): void {
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
    VALUES ('sess-1', NULL, 'proj-x', 'claude', ?, 1751234567000, 'active')
  `).run(ISO);
  for (let i = 1; i <= promptCount; i++) {
    db.prepare(`
      INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, synced_at)
      VALUES (1, 'sess-1', ?, ?, ?, ?, ?)
    `).run(i, `prompt ${i}`, ISO, 1751234567890 + i, i === 1 ? 111 : null);
  }
}

function promptRows(db: Database): Array<{ id: number; sync_rev: string; synced_at: number | null }> {
  return db.prepare('SELECT id, CAST(sync_rev AS TEXT) AS sync_rev, synced_at FROM user_prompts ORDER BY id').all() as any;
}

describe('sync_outbox growth bounds', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => db.close());

  function makeStore(options?: SessionStoreOptions): SessionStore {
    return new SessionStore(db, options);
  }

  // ---------------------------------------------------------------------------
  // (1) producer gate — syncOpsEnabled: false enqueues nothing, anywhere
  // ---------------------------------------------------------------------------
  describe('producer gate (syncOpsEnabled: false)', () => {
    it('updateMemorySessionId records the mapping but leaves sync_outbox empty and prompt sync state untouched', () => {
      const store = makeStore({ syncOpsEnabled: false });
      seedSessionWithPrompts(db, 2);

      store.updateMemorySessionId(1, 'mem-late');

      // The mapping itself still lands — only the sync lane is gated.
      const session = db.prepare('SELECT memory_session_id FROM sdk_sessions WHERE id = 1').get() as any;
      expect(session.memory_session_id).toBe('mem-late');

      expect(outboxRows(db)).toEqual([]);
      // The whole repair transaction is skipped: no sync_rev bump, no
      // synced_at re-null — those serve only the sync lanes.
      const prompts = promptRows(db);
      expect(prompts.map(p => p.sync_rev)).toEqual(['1', '1']);
      expect(prompts[0].synced_at).toBe(111);
      expect(prompts[1].synced_at).toBeNull();
    });

    it('ensureMemorySessionIdRegistered leaves sync_outbox empty', () => {
      const store = makeStore({ syncOpsEnabled: false });
      seedSessionWithPrompts(db, 2);

      store.ensureMemorySessionIdRegistered(1, 'mem-late');
      store.ensureMemorySessionIdRegistered(1, 'mem-later'); // id change — the amplification trigger

      const session = db.prepare('SELECT memory_session_id FROM sdk_sessions WHERE id = 1').get() as any;
      expect(session.memory_session_id).toBe('mem-later');
      expect(outboxRows(db)).toEqual([]);
      expect(promptRows(db).map(p => p.sync_rev)).toEqual(['1', '1']);
    });

    it('createSDKSession still records a custom title locally but enqueues no set_title op', () => {
      const store = makeStore({ syncOpsEnabled: false });

      store.createSDKSession('sess-t', 'proj-x', 'first prompt', 'A Title', 'claude');

      const session = db.prepare("SELECT custom_title FROM sdk_sessions WHERE content_session_id = 'sess-t'").get() as any;
      expect(session.custom_title).toBe('A Title');
      expect(outboxRows(db)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // (2) supersede — re-registrations replace queued repair ops per target
  // ---------------------------------------------------------------------------
  describe('set_prompt_session supersede (sync enabled)', () => {
    it('one registration enqueues exactly one op per prompt with the full repair body (pre-fix behavior preserved)', () => {
      const store = makeStore({ syncOpsEnabled: true });
      seedSessionWithPrompts(db, 2);

      store.updateMemorySessionId(1, 'mem-late');

      const ops = outboxRows(db);
      expect(ops.length).toBe(2);
      const byTarget = new Map(ops.map(o => [o.body.target.origin_local_id, o]));
      for (const promptId of ['1', '2']) {
        const op = byTarget.get(promptId)!;
        expect(op.rev).toBe('2'); // rev = post-bump sync_rev — REV MINTING RULES
        expect(op.body.op).toBe('set_prompt_session');
        expect(op.body.target.origin_device_id).toBeNull();
        expect(op.body.fields).toEqual({
          memory_session_id: 'mem-late',
          project: 'proj-x',
          content_session_id: 'sess-1',
          platform_source: 'claude',
        });
      }
    });

    it('N re-registrations leave one op per prompt at the newest rev and fields, not N ops', () => {
      // The observed field failure in miniature: 3 prompts x 21 synthetic
      // memory ids produced 63 queued ops pre-fix; the bound is 3.
      const store = makeStore(); // default construction — enqueue stays on
      seedSessionWithPrompts(db, 3);

      for (let k = 1; k <= 21; k++) {
        store.ensureMemorySessionIdRegistered(1, `mem-${k}`);
      }

      const ops = outboxRows(db);
      expect(ops.length).toBe(3); // one per prompt, NOT 63
      const targets = ops.map(o => o.body.target.origin_local_id).sort();
      expect(targets).toEqual(['1', '2', '3']);
      for (const op of ops) {
        expect(op.rev).toBe('22'); // 1 + one bump per re-registration
        expect(op.body.fields.memory_session_id).toBe('mem-21'); // newest repair wins
      }
      // The row lane agrees: prompts sit at the same post-bump rev, unsynced.
      for (const row of promptRows(db)) {
        expect(row.sync_rev).toBe('22');
        expect(row.synced_at).toBeNull();
      }
    });

    it('supersede is scoped to the (op, target) pair: other sessions and set_title ops survive', () => {
      const store = makeStore();
      seedSessionWithPrompts(db, 1);
      // A second session with its own prompt, plus a queued set_title op.
      store.createSDKSession('sess-2', 'proj-y', 'other prompt', 'Titled', 'claude');
      db.prepare(`
        INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
        VALUES (2, 'sess-2', 1, 'second session prompt', ?, 1751234567999)
      `).run(ISO);
      store.updateMemorySessionId(2, 'mem-other');

      store.updateMemorySessionId(1, 'mem-a');
      store.updateMemorySessionId(1, 'mem-b'); // supersedes only session 1's repair

      const ops = outboxRows(db);
      const titles = ops.filter(o => o.body.op === 'set_title');
      const repairs = ops.filter(o => o.body.op === 'set_prompt_session');
      expect(titles.length).toBe(1); // untouched by the repair supersede
      expect(repairs.length).toBe(2); // one per prompt target across both sessions

      const bySession = new Map(repairs.map(o => [o.body.fields.memory_session_id, o]));
      expect(bySession.get('mem-other')!.body.target.origin_local_id).toBe('2');
      expect(bySession.get('mem-b')!.body.target.origin_local_id).toBe('1');
      expect(bySession.has('mem-a')).toBe(false); // superseded op is gone
    });

    it('mints a fresh op UUID for the superseding op (a UUID is never reused for a different logical mutation)', () => {
      const store = makeStore();
      seedSessionWithPrompts(db, 1);

      store.updateMemorySessionId(1, 'mem-a');
      const first = outboxRows(db)[0];
      store.updateMemorySessionId(1, 'mem-b');
      const second = outboxRows(db)[0];

      expect(outboxRows(db).length).toBe(1);
      expect(second.op_uuid).not.toBe(first.op_uuid);
      expect(second.rev).toBe('3');
    });
  });
});
