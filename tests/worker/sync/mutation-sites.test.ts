// Phase 3 verification (plan 2026-07-17): the four mutation sites emit the
// right op with the right rev per the SyncApply contract (REV MINTING RULES):
//   (a) custom title (createSDKSession)          → set_title, rev 1
//   (b) prompt repair (requeuePromptSync via
//       updateMemorySessionId /
//       ensureMemorySessionIdRegistered)         → set_prompt_session, rev = post-bump sync_rev
//   (c) worktree adoption remap                  → remap_project, rev = 1+MAX(sync_rev)
//   (d) one-time cwd remap                       → remap_project, rev = 1+MAX(sync_rev)
// The remap sites are verified through their OWN-CONNECTION code paths: (c)
// via adoptMergedWorktrees against a real git repo + merged worktree, (d) via
// runOneTimeCwdRemap against a real pending_messages fixture — both open the
// DB file themselves, exactly as in production.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { openConfiguredSqliteDatabase } from '../../../src/services/sqlite/connection.js';
import { emitRemapProject, hasSyncLane } from '../../../src/services/sync/remap-outbox.js';
import { adoptMergedWorktrees } from '../../../src/services/infrastructure/WorktreeAdoption.js';
import { runOneTimeCwdRemap } from '../../../src/services/infrastructure/ProcessManager.js';

const ISO = '2026-07-09T00:00:00.000Z';

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.email=test@test', '-c', 'user.name=test', ...args], {
    encoding: 'utf8',
    timeout: 15000,
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
}

interface OutboxRow {
  op_uuid: string;
  rev: string;
  body: any;
}

function outboxRows(db: Database): OutboxRow[] {
  return (db.prepare('SELECT op_uuid, CAST(rev AS TEXT) AS rev, body FROM sync_outbox ORDER BY id').all() as Array<{ op_uuid: string; rev: string; body: string }>)
    .map(r => ({ op_uuid: r.op_uuid, rev: r.rev, body: JSON.parse(r.body) }));
}

describe('mutation sites', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-mutation-sites-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // (a) custom title — createSDKSession, worker connection
  // ---------------------------------------------------------------------------
  describe('set_title (createSDKSession)', () => {
    let db: Database;
    let store: SessionStore;

    beforeEach(() => {
      db = new Database(':memory:');
      store = new SessionStore(db);
    });

    afterEach(() => db.close());

    it('emits set_title rev 1 with the (platform, content id) target on fresh creation', () => {
      store.createSDKSession('sess-1', 'proj-x', 'first prompt', 'A Title', 'cursor');

      const ops = outboxRows(db);
      expect(ops.length).toBe(1);
      expect(ops[0].rev).toBe('1'); // rev 1 always — REV MINTING RULES
      expect(ops[0].op_uuid).toMatch(/^[0-9a-f-]{36}$/); // minted at enqueue, stable across retries
      expect(ops[0].body).toEqual({
        op: 'set_title',
        target: { content_session_id: 'sess-1', platform_source: 'cursor' },
        fields: { custom_title: 'A Title' },
      });
      // sdk_sessions rows do not sync: no sync_rev bump, no synced_at churn.
      const session = db.prepare('SELECT custom_title FROM sdk_sessions WHERE id = 1').get() as any;
      expect(session.custom_title).toBe('A Title');
    });

    it('emits no op when the session has no custom title', () => {
      store.createSDKSession('sess-1', 'proj-x', 'first prompt');
      expect(outboxRows(db).length).toBe(0);
    });

    it('emits an op for the NULL-guarded fill on an existing session, and none when the title is already set', () => {
      store.createSDKSession('sess-1', 'proj-x', 'first prompt'); // untitled
      expect(outboxRows(db).length).toBe(0);

      store.createSDKSession('sess-1', 'proj-x', 'again', 'Late Title'); // fills NULL
      let ops = outboxRows(db);
      expect(ops.length).toBe(1);
      expect(ops[0].body.fields.custom_title).toBe('Late Title');

      store.createSDKSession('sess-1', 'proj-x', 'third', 'Ignored Title'); // NULL guard rejects
      ops = outboxRows(db);
      expect(ops.length).toBe(1); // no second op — nothing changed locally
      const session = db.prepare('SELECT custom_title FROM sdk_sessions WHERE id = 1').get() as any;
      expect(session.custom_title).toBe('Late Title');
    });
  });

  // ---------------------------------------------------------------------------
  // (b) prompt repair — requeuePromptSync via its two callers
  // ---------------------------------------------------------------------------
  describe('set_prompt_session (requeuePromptSync)', () => {
    let db: Database;
    let store: SessionStore;

    beforeEach(() => {
      db = new Database(':memory:');
      store = new SessionStore(db);
      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
        VALUES ('sess-1', NULL, 'proj-x', 'claude', ?, 1751234567000, 'active')
      `).run(ISO);
      db.prepare(`
        INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, synced_at)
        VALUES (1, 'sess-1', 1, 'first', ?, 1751234567890, 111)
      `).run(ISO);
      db.prepare(`
        INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, synced_at)
        VALUES (1, 'sess-1', 2, 'second', ?, 1751234567891, NULL)
      `).run(ISO);
    });

    afterEach(() => db.close());

    function promptRows(): Array<{ id: number; sync_rev: string; synced_at: number | null }> {
      return db.prepare('SELECT id, sync_rev, synced_at FROM user_prompts ORDER BY id').all() as any;
    }

    it('updateMemorySessionId bumps sync_rev, re-nulls synced_at, and enqueues one op per native prompt at the post-bump rev', () => {
      store.updateMemorySessionId(1, 'mem-late');

      // Both prompts: sync_rev 1 → 2, synced_at NULL (row lane re-push at rev 2).
      for (const row of promptRows()) {
        expect(row.sync_rev).toBe('2');
        expect(row.synced_at).toBeNull();
      }

      const ops = outboxRows(db);
      expect(ops.length).toBe(2);
      const byTarget = new Map(ops.map(o => [o.body.target.origin_local_id, o]));
      for (const promptId of ['1', '2']) {
        const op = byTarget.get(promptId)!;
        expect(op.rev).toBe('2'); // rev = post-bump sync_rev — REV MINTING RULES
        expect(op.body.op).toBe('set_prompt_session');
        // NULL = "this device"; CloudSync substitutes its resolved id at push
        // time (single identity source).
        expect(op.body.target.origin_device_id).toBeNull();
        expect(op.body.fields).toEqual({
          memory_session_id: 'mem-late',
          project: 'proj-x',
          content_session_id: 'sess-1',
          platform_source: 'claude',
        });
      }
    });

    it('ensureMemorySessionIdRegistered goes through the same repair (only when the id actually changes)', () => {
      store.ensureMemorySessionIdRegistered(1, 'mem-late');
      expect(outboxRows(db).length).toBe(2);

      // Same id again: no change, no bump, no new ops.
      store.ensureMemorySessionIdRegistered(1, 'mem-late');
      expect(outboxRows(db).length).toBe(2);
      for (const row of promptRows()) expect(row.sync_rev).toBe('2');
    });

    it('clearing the memory id emits nothing', () => {
      store.updateMemorySessionId(1, null);
      expect(outboxRows(db).length).toBe(0);
      for (const row of promptRows()) expect(row.sync_rev).toBe('1');
    });

    it('leaves replica prompt rows untouched (their repair travels from their origin device)', () => {
      db.prepare(`
        INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, synced_at, origin_device_id, origin_local_id)
        VALUES (1, 'sess-1', 3, 'replica', ?, 1751234567892, 999, 'device-other', '55')
      `).run(ISO);

      store.updateMemorySessionId(1, 'mem-late');

      const replica = db.prepare(`SELECT sync_rev, synced_at FROM user_prompts WHERE origin_local_id = '55'`).get() as any;
      expect(replica.sync_rev).toBe('1');
      expect(replica.synced_at).toBe(999);
      // Ops only for the two native prompts.
      expect(outboxRows(db).length).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // emitRemapProject — the shared pure-SQL helper both remap sites call,
  // exercised on an OWN connection (openConfiguredSqliteDatabase on a file
  // DB, the exact connection type the sites use).
  // ---------------------------------------------------------------------------
  describe('emitRemapProject (own connection)', () => {
    let dbPath: string;
    let db: Database;

    beforeEach(() => {
      dbPath = join(tempDir, 'claude-mem.db');
      const store = new SessionStore(dbPath);
      store.db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES ('sess-1', 'mem-1', 'parent/wt', ?, 1751234567000, 'active')
      `).run(ISO);
      store.db.close();
      db = openConfiguredSqliteDatabase(dbPath); // the sites' own-connection shape
    });

    afterEach(() => db.close());

    function seedObs(project: string, syncRev: number, syncedAt: number | null, origin?: { device: string; localId: string }): void {
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch, sync_rev, synced_at, origin_device_id, origin_local_id)
        VALUES ('mem-1', ?, 'discovery', 't', ?, 1751234567890, ?, ?, ?, ?)
      `).run(project, ISO, syncRev, syncedAt, origin?.device ?? null, origin?.localId ?? null);
    }

    it('computes R = 1 + MAX(sync_rev) across both tables, stamps matched rows, and queues the op', () => {
      seedObs('parent/wt', 1, 100);
      seedObs('parent/wt', 3, 200);
      db.prepare(`
        INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch, sync_rev, synced_at)
        VALUES ('mem-1', 'parent/wt', 'req', ?, 1751234567891, 2, 300)
      `).run(ISO);
      seedObs('other-project', 9, 400); // outside the predicate — untouched

      const result = emitRemapProject(
        db,
        { project: 'parent/wt', merged_into_project_is_null: true },
        { merged_into_project: 'parent' }
      );

      expect(result).toEqual({ observations: 2, summaries: 1, rev: '4' }); // 1 + MAX(1,3,2)

      const remapped = db.prepare(`
        SELECT merged_into_project, sync_rev, synced_at FROM observations WHERE project = 'parent/wt' ORDER BY id
      `).all() as any[];
      for (const row of remapped) {
        expect(row.merged_into_project).toBe('parent');
        expect(row.sync_rev).toBe('4');
        expect(row.synced_at).toBeNull(); // native rows re-push at rev R
      }
      const untouched = db.prepare(`SELECT sync_rev, merged_into_project FROM observations WHERE project = 'other-project'`).get() as any;
      expect(untouched.sync_rev).toBe('9');
      expect(untouched.merged_into_project).toBeNull();

      const ops = outboxRows(db);
      expect(ops.length).toBe(1);
      expect(ops[0].rev).toBe('4');
      expect(ops[0].body).toEqual({
        op: 'remap_project',
        where: { project: 'parent/wt', merged_into_project_is_null: true },
        fields: { merged_into_project: 'parent' },
      });
    });

    it('keeps replica rows stamped (synced_at intact) while still bumping their rev', () => {
      seedObs('parent/wt', 1, null);
      seedObs('parent/wt', 2, 555, { device: 'device-other', localId: '77' });

      const result = emitRemapProject(
        db,
        { project: 'parent/wt', merged_into_project_is_null: true },
        { merged_into_project: 'parent' }
      );
      expect(result.rev).toBe('3');

      const replica = db.prepare(`SELECT sync_rev, synced_at, merged_into_project FROM observations WHERE origin_local_id = '77'`).get() as any;
      expect(replica.merged_into_project).toBe('parent'); // remapped locally
      expect(replica.sync_rev).toBe('3');
      expect(replica.synced_at).toBe(555); // never queued for push under OUR identity
    });

    it('supports the cwd-remap shape (where memory_session_id, set project) and emits nothing on zero matches', () => {
      seedObs('parent/wt', 2, 100);

      const miss = emitRemapProject(db, { memory_session_id: 'mem-none' }, { project: 'newproj' });
      expect(miss).toEqual({ observations: 0, summaries: 0, rev: '0' });
      expect(outboxRows(db).length).toBe(0);

      const hit = emitRemapProject(db, { memory_session_id: 'mem-1' }, { project: 'newproj' });
      expect(hit).toEqual({ observations: 1, summaries: 0, rev: '3' });
      const ops = outboxRows(db);
      expect(ops.length).toBe(1);
      expect(ops[0].body).toEqual({
        op: 'remap_project',
        where: { memory_session_id: 'mem-1' },
        fields: { project: 'newproj' },
      });
      const row = db.prepare(`SELECT project, sync_rev, synced_at FROM observations WHERE id = 1`).get() as any;
      expect(row.project).toBe('newproj');
      expect(row.sync_rev).toBe('3');
      expect(row.synced_at).toBeNull();
    });

    it('hasSyncLane is true post-migration and false without the outbox', () => {
      expect(hasSyncLane(db)).toBe(true);
      db.prepare('DROP TABLE sync_outbox').run();
      expect(hasSyncLane(db)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // (c) worktree adoption — the REAL site, own connection, real git repo with
  // a merged worktree. Summaries only (no observation ids ⇒ the site's Chroma
  // patch is skipped — vector search is not under test here).
  // ---------------------------------------------------------------------------
  it('adoptMergedWorktrees emits remap_project through its own connection', async () => {
    const repo = join(tempDir, 'mainrepo');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'x');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
    const wtPath = join(tempDir, 'wt');
    git(repo, 'worktree', 'add', '-b', 'feature', wtPath); // same commit ⇒ merged

    const dataDir = join(tempDir, 'data');
    mkdirSync(dataDir);
    const dbPath = join(dataDir, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    store.db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('sess-1', 'mem-1', 'mainrepo/wt', ?, 1751234567000, 'active')
    `).run(ISO);
    store.db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch, sync_rev, synced_at)
      VALUES ('mem-1', 'mainrepo/wt', 'req', ?, 1751234567891, 2, 123)
    `).run(ISO);
    store.db.close();

    const result = await adoptMergedWorktrees({ repoPath: repo, dataDirectory: dataDir });
    expect(result.mergedBranches).toContain('feature');
    expect(result.adoptedSummaries).toBe(1);
    expect(result.adoptedObservations).toBe(0);

    const db = openConfiguredSqliteDatabase(dbPath);
    try {
      const summary = db.prepare('SELECT merged_into_project, sync_rev, synced_at FROM session_summaries WHERE id = 1').get() as any;
      expect(summary.merged_into_project).toBe('mainrepo');
      expect(summary.sync_rev).toBe('3'); // R = 1 + MAX(2)
      expect(summary.synced_at).toBeNull();

      const ops = outboxRows(db);
      expect(ops.length).toBe(1);
      expect(ops[0].rev).toBe('3');
      expect(ops[0].body).toEqual({
        op: 'remap_project',
        where: { project: 'mainrepo/wt', merged_into_project_is_null: true },
        fields: { merged_into_project: 'mainrepo' },
      });
    } finally {
      db.close();
    }
  });

  // ---------------------------------------------------------------------------
  // (d) one-time cwd remap — the REAL site, own connection, real git repo
  // classified from pending_messages.cwd.
  // ---------------------------------------------------------------------------
  it('runOneTimeCwdRemap emits remap_project through its own connection', () => {
    const repo = join(tempDir, 'realproj');
    mkdirSync(repo);
    git(repo, 'init', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'x');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');

    const dataDir = join(tempDir, 'data');
    mkdirSync(dataDir);
    const dbPath = join(dataDir, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    store.db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('sess-1', 'mem-1', 'stale-name', ?, 1751234567000, 'active')
    `).run(ISO);
    store.db.prepare(`
      INSERT INTO pending_messages (session_db_id, content_session_id, message_type, cwd, status, created_at_epoch)
      VALUES (1, 'sess-1', 'observation', ?, 'pending', 1751234567000)
    `).run(repo);
    store.db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch, sync_rev, synced_at)
      VALUES ('mem-1', 'stale-name', 'discovery', 't', ?, 1751234567890, 1, 100)
    `).run(ISO);
    store.db.close();

    runOneTimeCwdRemap(dataDir);
    expect(existsSync(join(dataDir, '.cwd-remap-applied-v1'))).toBe(true);

    const db = openConfiguredSqliteDatabase(dbPath);
    try {
      const session = db.prepare('SELECT project FROM sdk_sessions WHERE id = 1').get() as any;
      expect(session.project).toBe('realproj'); // classified from the git repo root

      const obs = db.prepare('SELECT project, sync_rev, synced_at FROM observations WHERE id = 1').get() as any;
      expect(obs.project).toBe('realproj');
      expect(obs.sync_rev).toBe('2'); // R = 1 + MAX(1)
      expect(obs.synced_at).toBeNull();

      const ops = outboxRows(db);
      expect(ops.length).toBe(1);
      expect(ops[0].rev).toBe('2');
      expect(ops[0].body).toEqual({
        op: 'remap_project',
        where: { memory_session_id: 'mem-1' },
        fields: { project: 'realproj' },
      });
    } finally {
      db.close();
    }
  });
});
