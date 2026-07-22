import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { CloudSync } from '../../src/services/sync/CloudSync.js';
import { SyncApply } from '../../src/services/sync/SyncApply.js';

const SYNCED_TABLES = ['observations', 'session_summaries', 'user_prompts'] as const;

function columnNames(db: Database, table: string): Set<string> {
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(col => col.name));
}

function syncedAtById(db: Database, table: string): Map<number, number | null> {
  const rows = db.prepare(`SELECT id, synced_at FROM ${table} ORDER BY id`).all() as Array<{ id: number; synced_at: number | null }>;
  return new Map(rows.map(row => [row.id, row.synced_at]));
}

function stampedCount(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE synced_at IS NOT NULL`).get() as { n: number }).n;
}

function contentSnapshot(db: Database): Record<string, Array<Record<string, unknown>>> {
  return Object.fromEntries(SYNCED_TABLES.map(table => [
    table,
    (db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Array<Record<string, unknown>>)
      .map(({ synced_at: _syncedAt, ...content }) => content),
  ]));
}

function rowCount(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function seedRows(db: Database): void {
  const now = new Date().toISOString();
  const epoch = Date.now();
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run('content-sync', 'memory-sync', 'sync-project', now, epoch);
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, content_hash, created_at, created_at_epoch)
    VALUES ('memory-sync', 'sync-project', 'discovery', 'hash-1', ?, ?)
  `).run(now, epoch);
  db.prepare(`
    INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
    VALUES ('memory-sync', 'sync-project', 'request', ?, ?)
  `).run(now, epoch);
  db.prepare(`
    INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES ('content-sync', 1, 'prompt', ?, ?)
  `).run(now, epoch);
}

describe('SessionStore SyncHub launch baseline', () => {
  it('creates synced_at columns, unsynced indexes, and the durable launch boundary', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db);
      for (const table of SYNCED_TABLES) {
        expect(columnNames(db, table).has('synced_at')).toBe(true);
        const index = db.prepare(`
          SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?
        `).get(`idx_${table}_unsynced`) as { sql: string } | undefined;
        expect(index?.sql).toContain('synced_at IS NULL');
      }
      expect(db.prepare('SELECT version FROM schema_versions WHERE version = 47').get()).not.toBeNull();
      expect(db.prepare('SELECT version FROM schema_versions WHERE version = 48').get()).not.toBeNull();
      expect(db.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sync_launch_exclusions'
      `).get()).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('preserves all content while marking only the native pre-launch corpus and clearing stale sync state', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db);
      seedRows(db);
      db.prepare(`
        INSERT INTO observations
          (memory_session_id, project, type, title, content_hash, created_at, created_at_epoch, synced_at)
        VALUES ('memory-sync', 'sync-project', 'discovery', 'already stamped', 'hash-2',
                '2026-07-20T00:00:00.000Z', 1752969600000, 777)
      `).run();
      db.prepare(`
        INSERT INTO observations
          (memory_session_id, project, type, title, content_hash, created_at, created_at_epoch,
           synced_at, origin_device_id, origin_local_id)
        VALUES ('memory-sync', 'sync-project', 'discovery', 'replica', 'hash-3',
                '2026-07-20T00:00:01.000Z', 1752969601000, NULL, 'device-other', '9')
      `).run();
      db.prepare(`
        INSERT INTO sync_outbox (op_uuid, rev, body, created_at_epoch)
        VALUES ('old-mutation', '1', '{"op":"set_title"}', 1)
      `).run();
      db.prepare(`
        INSERT INTO sync_content_outbox
          (entity_id, kind, origin_local_id, entity_rev, body, operation_sha256, deleted, created_at_epoch)
        VALUES ('old-doc', 'observation', '1', '1', '{}', 'hash', 1, 1)
      `).run();
      db.prepare(`
        INSERT INTO sync_dead_letter
          (lane, queue_key, kind, origin_local_id, entity_rev, reason, raw_body, created_at_epoch)
        VALUES ('content', 'old-doc', 'observation', '1', '1', 'pre-launch fixture', '{}', 1)
      `).run();
      db.prepare(`
        INSERT INTO sync_entity_heads
          (entity_id, kind, origin_device_id, origin_local_id, entity_rev,
           operation_sha256, deleted, updated_at_epoch)
        VALUES ('preserved-head', 'observation', 'device-self', '1', '4', 'head-hash', 0, 1)
      `).run();
      const insertState = db.prepare('INSERT INTO sync_state (k, v) VALUES (?, ?)');
      insertState.run('cursor', '42');
      insertState.run('epoch', 'pre-launch-epoch');
      insertState.run('cutover_hub_url', 'https://pre-launch-hub.test');
      insertState.run('parked_title:mem:old', 'stale title');

      const contentBefore = contentSnapshot(db);

      // Reproduce a database created before the v47 launch boundary landed.
      db.run('DELETE FROM schema_versions WHERE version = 47');
      new SessionStore(db);

      expect(contentSnapshot(db)).toEqual(contentBefore);
      for (const table of ['session_summaries', 'user_prompts']) {
        expect(stampedCount(db, table)).toBe(1);
      }
      expect(db.prepare(`
        SELECT title, synced_at, origin_device_id FROM observations ORDER BY id
      `).all()).toEqual([
        { title: null, synced_at: expect.any(Number), origin_device_id: null },
        { title: 'already stamped', synced_at: 777, origin_device_id: null },
        { title: 'replica', synced_at: null, origin_device_id: 'device-other' },
      ]);
      expect(rowCount(db, 'sync_outbox')).toBe(0);
      expect(rowCount(db, 'sync_content_outbox')).toBe(0);
      expect(rowCount(db, 'sync_dead_letter')).toBe(0);
      expect(rowCount(db, 'sync_state')).toBe(0);
      expect(rowCount(db, 'sync_entity_heads')).toBe(1);
      expect(db.prepare(`
        SELECT kind, origin_local_id, through_rev
        FROM sync_launch_exclusions
        ORDER BY kind, origin_local_id
      `).all()).toEqual([
        { kind: 'observation', origin_local_id: '1', through_rev: '1' },
        { kind: 'observation', origin_local_id: '2', through_rev: '1' },
        { kind: 'prompt', origin_local_id: '1', through_rev: '1' },
        { kind: 'summary', origin_local_id: '1', through_rev: '1' },
      ]);
      expect(db.prepare('SELECT entity_rev, operation_sha256 FROM sync_entity_heads').get())
        .toEqual({ entity_rev: '4', operation_sha256: 'head-hash' });
    } finally {
      db.close();
    }
  });

  it('preserves excluded pre-launch revisions across epoch changes while requeueing post-launch native rows', () => {
    const db = new Database(':memory:');
    let sync: CloudSync | null = null;
    try {
      new SessionStore(db);
      seedRows(db);

      // Reproduce a database whose content existed when the one-time launch
      // boundary was applied.
      db.run('DELETE FROM schema_versions WHERE version IN (47, 48)');
      db.run('DELETE FROM sync_launch_exclusions');
      new SessionStore(db);

      const baseline = Object.fromEntries(SYNCED_TABLES.map(table => [
        table,
        db.prepare(`SELECT id, synced_at FROM ${table} ORDER BY id`).all(),
      ]));
      expect(rowCount(db, 'sync_launch_exclusions')).toBe(3);

      const now = new Date().toISOString();
      const epoch = Date.now() + 10_000;
      db.prepare(`
        INSERT INTO observations
          (memory_session_id, project, type, title, content_hash, created_at, created_at_epoch, synced_at)
        VALUES ('memory-sync', 'sync-project', 'discovery', 'post-launch observation',
                'post-launch-hash', ?, ?, ?)
      `).run(now, epoch, epoch);
      db.prepare(`
        INSERT INTO session_summaries
          (memory_session_id, project, request, created_at, created_at_epoch, synced_at)
        VALUES ('memory-sync', 'sync-project', 'post-launch summary', ?, ?, ?)
      `).run(now, epoch + 1, epoch + 1);
      db.prepare(`
        INSERT INTO user_prompts
          (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, synced_at)
        VALUES ('content-sync', 2, 'post-launch prompt', ?, ?, ?)
      `).run(now, epoch + 2, epoch + 2);

      const apply = new SyncApply(db, { deviceId: 'epoch-boundary-device' });
      expect(apply.handleEpoch('epoch-one')).toBe(false);
      expect(apply.handleEpoch('epoch-two')).toBe(true);

      for (const table of SYNCED_TABLES) {
        const rows = db.prepare(`SELECT id, synced_at FROM ${table} ORDER BY id`).all() as Array<{
          id: number;
          synced_at: number | null;
        }>;
        expect(rows[0]).toEqual((baseline[table] as Array<{ id: number; synced_at: number }>)[0]);
        expect(rows.at(-1)?.synced_at).toBeNull();
        expect(db.prepare(`
          SELECT id FROM ${table}
          WHERE synced_at IS NULL AND origin_device_id IS NULL
        `).all()).toEqual([{ id: rows.at(-1)?.id }]);
      }

      sync = new CloudSync(db, {
        CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'test-token',
        CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'test-user',
        CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test',
        CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'epoch-boundary-device',
      });
      expect(sync.status().pending).toEqual({
        observations: 1,
        summaries: 1,
        prompts: 1,
        mutations: 0,
        tombstones: 0,
      });

      // The exclusion is revision-bounded, not a permanent row-id ban. A
      // post-launch edit of a baseline row has a higher native revision and
      // must re-enter a later rebuilt Hub log.
      db.prepare(`
        UPDATE observations SET sync_rev = '2', synced_at = ? WHERE id = 1
      `).run(epoch + 3);
      expect(apply.handleEpoch('epoch-three')).toBe(true);
      expect(db.prepare('SELECT synced_at FROM observations WHERE id = 1').get())
        .toEqual({ synced_at: null });
    } finally {
      sync?.stop();
      db.close();
    }
  });

  it('repairs an earlier v47 database without excluding later writes', () => {
    const db = new Database(':memory:');
    try {
      new SessionStore(db);
      const appliedAt = (db.prepare(`
        SELECT applied_at FROM schema_versions WHERE version = 47
      `).get() as { applied_at: string }).applied_at;
      const boundaryMs = Date.parse(appliedAt);

      seedRows(db);
      for (const table of SYNCED_TABLES) db.run(`UPDATE ${table} SET synced_at = ${boundaryMs}`);
      db.prepare(`
        INSERT INTO observations
          (memory_session_id, project, type, title, content_hash, created_at, created_at_epoch, synced_at)
        VALUES ('memory-sync', 'sync-project', 'discovery', 'later write', 'later-write-hash',
                ?, ?, ?)
      `).run(new Date(boundaryMs + 1).toISOString(), boundaryMs + 1, boundaryMs + 1);

      // Earlier v47 builds had only the applied_at boundary and stamps, not
      // the explicit revision ledger introduced by v48.
      db.run('DROP TABLE sync_launch_exclusions');
      db.run('DELETE FROM schema_versions WHERE version = 48');
      new SessionStore(db);

      expect(rowCount(db, 'sync_launch_exclusions')).toBe(3);
      expect(db.prepare(`
        SELECT origin_local_id FROM sync_launch_exclusions
        WHERE kind = 'observation' ORDER BY origin_local_id
      `).all()).toEqual([{ origin_local_id: '1' }]);

      const apply = new SyncApply(db, { deviceId: 'v48-repair-device' });
      expect(apply.handleEpoch('repair-one')).toBe(false);
      expect(apply.handleEpoch('repair-two')).toBe(true);
      expect(db.prepare(`
        SELECT id, synced_at FROM observations ORDER BY id
      `).all()).toEqual([
        { id: 1, synced_at: boundaryMs },
        { id: 2, synced_at: null },
      ]);
    } finally {
      db.close();
    }
  });

  it('runs once and cannot clear post-boundary queues after restarts or lower-version migration repair', () => {
    const db = new Database(':memory:');
    try {
      const store = new SessionStore(db);
      seedRows(db);
      for (const table of SYNCED_TABLES) expect(stampedCount(db, table)).toBe(0);
      store.createSDKSession('content-edit', 'sync-project', 'prompt', 'Post-launch title', 'claude');
      db.prepare(`
        INSERT INTO sync_content_outbox
          (entity_id, kind, origin_local_id, entity_rev, body, operation_sha256, deleted, created_at_epoch)
        VALUES ('post-launch-doc', 'observation', '1', '1', '{}', 'post-launch-hash', 0, 2)
      `).run();
      db.prepare(`
        INSERT INTO sync_dead_letter
          (lane, queue_key, kind, origin_local_id, entity_rev, reason, raw_body, created_at_epoch)
        VALUES ('content', 'post-launch-bad', 'observation', '2', '1', 'post-launch fixture', '{}', 2)
      `).run();

      // Simulate an older build repairing the lower v44-v46 bookkeeping rows.
      // Unknown v47 remains in schema_versions, as SQLite migrations must.
      db.run('DELETE FROM schema_versions WHERE version IN (44, 45, 46)');

      new SessionStore(db);
      for (const table of SYNCED_TABLES) expect(stampedCount(db, table)).toBe(0);
      expect(rowCount(db, 'sync_outbox')).toBe(1);
      expect(rowCount(db, 'sync_content_outbox')).toBe(1);
      expect(rowCount(db, 'sync_dead_letter')).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM schema_versions WHERE version = 47').get() as { n: number }).n).toBe(1);

      new SessionStore(db);
      expect(rowCount(db, 'sync_outbox')).toBe(1);
      expect(rowCount(db, 'sync_content_outbox')).toBe(1);
      expect(rowCount(db, 'sync_dead_letter')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('keeps later edits, deletes, and revives in the canonical queues across restart', async () => {
    const db = new Database(':memory:');
    let sync: CloudSync | null = null;
    try {
      const store = new SessionStore(db);
      seedRows(db);

      store.createSDKSession('content-edit', 'sync-project', 'prompt', 'Post-launch title', 'claude');
      expect(rowCount(db, 'sync_outbox')).toBe(1);
      new SessionStore(db);
      expect(rowCount(db, 'sync_outbox')).toBe(1);

      let seq = 0;
      let failNext = false;
      const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (failNext) {
          failNext = false;
          return new Response('offline', { status: 503 });
        }
        const request = JSON.parse(String(init?.body)) as {
          ops: Array<{ body: string; operation_sha256: string }>;
        };
        const acked = request.ops.map(op => {
          const body = JSON.parse(op.body) as {
            id: string;
            kind: string;
            origin_local_id: string | null;
            entity_rev: string;
          };
          seq += 1;
          return {
            id: body.id,
            kind: body.kind,
            origin_local_id: body.origin_local_id,
            entity_rev: body.entity_rev,
            operation_sha256: op.operation_sha256,
            seq: String(seq),
          };
        });
        return Response.json({ acked, head_seq: String(seq), projected_seq: String(seq) });
      }) as typeof fetch;
      sync = new CloudSync(db, {
        CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'token',
        CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user',
        CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test',
        CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'device-launch-boundary',
        CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'launch-boundary-test',
      }, {
        fetchImpl,
      });

      expect(sync.queueDelete('observation', '1')).toBe('2');
      expect(db.prepare(`
        SELECT entity_rev, deleted FROM sync_content_outbox WHERE entity_id LIKE 'observation:%'
      `).get()).toEqual({ entity_rev: '2', deleted: 1 });
      new SessionStore(db);
      expect(rowCount(db, 'sync_content_outbox')).toBe(1);
      await sync.flush();
      expect(rowCount(db, 'sync_content_outbox')).toBe(0);

      db.prepare(`
        INSERT INTO observations
          (id, memory_session_id, project, type, title, content_hash, created_at, created_at_epoch)
        VALUES (1, 'memory-sync', 'sync-project', 'discovery', 'revived after launch', 'hash-revived',
                '2026-07-20T00:00:02.000Z', 1752969602000)
      `).run();
      failNext = true;
      await sync.flush();
      expect(db.prepare(`
        SELECT entity_rev, deleted FROM sync_content_outbox
        WHERE entity_id LIKE 'observation:%' ORDER BY id DESC LIMIT 1
      `).get()).toEqual({ entity_rev: '3', deleted: 0 });

      const queuedBeforeRestart = rowCount(db, 'sync_content_outbox');
      new SessionStore(db);
      expect(rowCount(db, 'sync_content_outbox')).toBe(queuedBeforeRestart);
    } finally {
      sync?.stop();
      db.close();
    }
  });
});

describe('SessionStore prompt re-push hooks (memory id lands after first sync)', () => {
  let db: Database;
  let store: SessionStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SessionStore(db);

    const now = new Date().toISOString();
    const epoch = Date.now();
    const insertSession = db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, 'proj', ?, ?, 'active')
    `);
    insertSession.run('sess-1', 'mem-a', now, epoch);
    insertSession.run('sess-2', 'mem-b', now, epoch);

    const insertPrompt = db.prepare(`
      INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch, synced_at)
      VALUES (?, ?, ?, 'prompt', ?, ?, 1751234567890)
    `);
    insertPrompt.run(1, 'sess-1', 1, now, epoch);
    insertPrompt.run(1, 'sess-1', 2, now, epoch);
    insertPrompt.run(2, 'sess-2', 1, now, epoch);
  });

  afterEach(() => {
    db.close();
  });

  it('updateMemorySessionId requeues only that session\'s prompts', () => {
    store.updateMemorySessionId(1, 'mem-a2');
    const prompts = syncedAtById(db, 'user_prompts');
    expect(prompts.get(1)).toBeNull();
    expect(prompts.get(2)).toBeNull();
    expect(prompts.get(3)).toBe(1751234567890);
  });

  it('updateMemorySessionId(null) clears the mapping without requeueing', () => {
    store.updateMemorySessionId(1, null);
    expect(stampedCount(db, 'user_prompts')).toBe(3);
  });

  it('ensureMemorySessionIdRegistered requeues on change and no-ops when already registered', () => {
    store.ensureMemorySessionIdRegistered(1, 'mem-a');
    expect(stampedCount(db, 'user_prompts')).toBe(3);

    store.ensureMemorySessionIdRegistered(1, 'mem-a3');
    const prompts = syncedAtById(db, 'user_prompts');
    expect(prompts.get(1)).toBeNull();
    expect(prompts.get(2)).toBeNull();
    expect(prompts.get(3)).toBe(1751234567890);
  });
});
