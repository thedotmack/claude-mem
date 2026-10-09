// Phase 2 verification (plan 2026-07-17): migration v41 + the SyncApply
// apply path. Harness style copied from cloud-sync.test.ts — in-temp-dir
// SessionStore over an in-memory database, real CloudSync with an injected
// fetch mock for the echo-guard drain assertions.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { CloudSync, type CloudSyncSettingKeys } from '../../../src/services/sync/CloudSync.js';
import { SyncApply, type SyncOp, type ChromaSyncLike } from '../../../src/services/sync/SyncApply.js';

const ISO = '2026-07-09T00:00:00.000Z';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** This device's id — matches the CloudSync fixture id so the echo-guard test
 * uses ONE identity for both apply and drain (the fail-closed contract). */
const SELF = 'device-fixture';
const REMOTE = 'device-a';
const FIXED_NOW = 1752000000000;

const REMOTE_EPOCH = 1751328000000;
const REMOTE_ISO = new Date(REMOTE_EPOCH).toISOString();

function obsBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memory_session_id: 'mem-remote-1',
    project: 'proj-remote',
    text: null,
    type: 'discovery',
    title: 'Remote observation',
    subtitle: 'Remote sub',
    facts: '["remote fact"]',
    narrative: 'remote narrative body',
    concepts: '["concept-r"]',
    files_read: '["/remote.ts"]',
    files_modified: '[]',
    prompt_number: 1,
    discovery_tokens: 7,
    content_hash: 'hash-r1',
    generated_by_model: null,
    agent_type: null,
    agent_id: null,
    metadata: null,
    merged_into_project: null,
    created_at: REMOTE_ISO,
    created_at_epoch: REMOTE_EPOCH,
    ...overrides,
  };
}

function sumBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memory_session_id: 'mem-remote-1',
    project: 'proj-remote',
    request: 'Remote request',
    investigated: 'Remote investigated',
    learned: 'Remote learned',
    completed: 'Remote completed',
    next_steps: 'Remote next',
    files_read: null,
    files_edited: null,
    notes: null,
    prompt_number: 1,
    discovery_tokens: 0,
    merged_into_project: null,
    created_at: REMOTE_ISO,
    created_at_epoch: REMOTE_EPOCH + 1,
    ...overrides,
  };
}

function promptBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content_session_id: 'sess-remote-1',
    prompt_number: 1,
    prompt_text: 'remote prompt text',
    created_at: REMOTE_ISO,
    created_at_epoch: REMOTE_EPOCH + 2,
    memory_session_id: 'mem-remote-1',
    project: 'proj-remote',
    platform_source: 'claude',
    ...overrides,
  };
}

function op(
  seq: number | string,
  kind: SyncOp['kind'],
  originId: string,
  body: Record<string, unknown> | string,
  opts: { device?: string; rev?: number | string } = {}
): SyncOp {
  return {
    seq: String(seq),
    kind,
    origin_device: opts.device ?? REMOTE,
    origin_id: originId,
    rev: String(opts.rev ?? 1),
    body: typeof body === 'string' ? body : JSON.stringify(body),
    server_ts: REMOTE_EPOCH + (typeof seq === 'number' ? seq : 0),
  };
}

describe('SyncApply', () => {
  let tempDir: string;
  let db: Database;
  let settingsPath: string;

  function makeApply(options: { deviceId?: string; chromaSync?: ChromaSyncLike | null } = {}): SyncApply {
    return new SyncApply(db, {
      deviceId: options.deviceId ?? SELF,
      chromaSync: options.chromaSync,
      now: () => FIXED_NOW,
    });
  }

  function makeSettings(): CloudSyncSettingKeys {
    return {
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'test-token-1234',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user-42',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: SELF,
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'test-host',
    };
  }

  /** Batch of one observation + one summary + one prompt from REMOTE. */
  function remoteBatch(): SyncOp[] {
    return [
      op(1, 'observation', '11', obsBody()),
      op(2, 'summary', '21', sumBody()),
      op(3, 'prompt', '31', promptBody()),
    ];
  }

  function count(table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  function snapshot(table: string): unknown[] {
    return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  }

  function isFts5Available(): boolean {
    try {
      db.run('CREATE VIRTUAL TABLE _fts5_probe USING fts5(test_column)');
      db.run('DROP TABLE _fts5_probe');
      return true;
    } catch {
      return false;
    }
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-sync-apply-'));
    settingsPath = join(tempDir, 'settings.json');
    db = new Database(':memory:');
    new SessionStore(db);
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('sess-abc', 'mem-1', 'proj-x', ?, 1751234567000, 'active')
    `).run(ISO);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Migration v41
  // ---------------------------------------------------------------------------

  describe('migration v41', () => {
    it('adds origin columns, sync_rev, the partial unique index, and sync_state', () => {
      for (const table of ['observations', 'session_summaries', 'user_prompts']) {
        const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
        const names = new Set(cols.map(c => c.name));
        expect(names.has('origin_device_id')).toBe(true);
        expect(names.has('origin_local_id')).toBe(true);
        const syncRev = cols.find(c => c.name === 'sync_rev')!;
        expect(syncRev.type).toBe('TEXT');
        expect(syncRev.notnull).toBe(1);
        expect(syncRev.dflt_value).toBe("'1'");

        const indexes = db.query(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number; partial: number }>;
        const originIndex = indexes.find(i => i.name === `ux_${table}_origin`)!;
        expect(originIndex.unique).toBe(1);
        expect(originIndex.partial).toBe(1);
      }

      const syncState = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='sync_state'`).all();
      expect(syncState.length).toBe(1);
      const version = db.prepare('SELECT version FROM schema_versions WHERE version = 41').get();
      expect(version).not.toBeNull();
    });

    it('is idempotent — re-running the constructor changes nothing', () => {
      new SessionStore(db);
      const cols = db.query('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
      expect(cols.filter(c => c.name === 'origin_device_id').length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Row application
  // ---------------------------------------------------------------------------

  it('applies remote row ops: origin identity, preserved timestamps, pre-stamped synced_at, stub session', () => {
    const apply = makeApply();
    const result = apply.applyOps(remoteBatch(), { epoch: 'epoch-1' });

    expect(result).toEqual({
      applied: 3,
      skippedOwn: 0,
      skippedStale: 0,
      skippedCursor: 0,
      quarantined: 0,
      cursor: '3',
      epochReset: false,
    });
    expect(apply.getCursor()).toBe('3');
    expect(apply.getEpoch()).toBe('epoch-1');

    const obs = db.prepare(`SELECT * FROM observations WHERE origin_device_id = ? AND origin_local_id = '11'`).get(REMOTE) as any;
    expect(obs.title).toBe('Remote observation');
    expect(obs.created_at_epoch).toBe(REMOTE_EPOCH);   // remote timestamp preserved
    expect(obs.created_at).toBe(REMOTE_ISO);
    expect(obs.synced_at).toBe(FIXED_NOW);             // NEVER NULL on an applied row
    expect(obs.sync_rev).toBe('1');

    const sum = db.prepare(`SELECT * FROM session_summaries WHERE origin_device_id = ? AND origin_local_id = '21'`).get(REMOTE) as any;
    expect(sum.request).toBe('Remote request');
    expect(sum.synced_at).toBe(FIXED_NOW);

    // FK is enforced, sessions do not sync → a stub session must exist and
    // the prompt must link to it.
    const stub = db.prepare(`SELECT * FROM sdk_sessions WHERE memory_session_id = 'mem-remote-1'`).get() as any;
    expect(stub).not.toBeNull();
    expect(stub.project).toBe('proj-remote');
    const prompt = db.prepare(`SELECT * FROM user_prompts WHERE origin_device_id = ? AND origin_local_id = '31'`).get(REMOTE) as any;
    expect(prompt.prompt_text).toBe('remote prompt text');
    expect(prompt.session_db_id).toBe(stub.id);
    expect(prompt.synced_at).toBe(FIXED_NOW);
  });

  it('uses the memory_session_id as stub content id when only observations arrive, and later prompts adopt the stub', () => {
    const apply = makeApply();
    apply.applyOps([op(1, 'observation', '11', obsBody())]);
    const stub = db.prepare(`SELECT * FROM sdk_sessions WHERE memory_session_id = 'mem-remote-1'`).get() as any;
    expect(stub.content_session_id).toBe('mem-remote-1'); // fallback — obs bodies carry no content id
    expect(stub.status).toBe('completed');

    apply.applyOps([op(2, 'prompt', '31', promptBody())]);
    const prompt = db.prepare(`SELECT session_db_id FROM user_prompts WHERE origin_local_id = '31'`).get() as any;
    expect(prompt.session_db_id).toBe(stub.id); // linked via memory_session_id, no second stub
    expect(count('sdk_sessions')).toBe(2); // native seed + one stub
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------

  it('is idempotent: same batch twice → identical DB state (cursor layer + upsert layer)', () => {
    const apply = makeApply();
    const batch = remoteBatch();

    apply.applyOps(batch, { epoch: 'epoch-1' });
    const tables = ['observations', 'session_summaries', 'user_prompts', 'sdk_sessions'];
    const first = tables.map(snapshot);

    // Layer 1: cursor skip.
    const again = apply.applyOps(batch, { epoch: 'epoch-1' });
    expect(again.skippedCursor).toBe(3);
    expect(again.applied).toBe(0);
    expect(tables.map(snapshot)).toEqual(first);

    // Layer 2: true upsert idempotency — epoch reset forces a full re-pull
    // from seq 0 over rows that already exist.
    const reset = apply.applyOps(batch, { epoch: 'epoch-2' });
    expect(reset.epochReset).toBe(true);
    expect(apply.getCursor()).toBe('0');

    const replay = apply.applyOps(batch, { epoch: 'epoch-2' });
    expect(replay.epochReset).toBe(false);
    expect(replay.applied).toBe(0);
    expect(replay.skippedStale).toBe(3); // same rev = same content = skip
    expect(replay.cursor).toBe('3');
    expect(tables.map(snapshot)).toEqual(first);
    expect(apply.getCursor()).toBe('3');
    expect(apply.getEpoch()).toBe('epoch-2');
  });

  // ---------------------------------------------------------------------------
  // Atomicity: cursor moves with the rows or not at all
  // ---------------------------------------------------------------------------

  function quarantined(): Array<{ seq: string; kind: string | null; origin_local_id: string | null; reason: string; raw_body: string }> {
    return db.prepare(`
      SELECT seq, kind, origin_local_id, reason, raw_body FROM sync_pull_quarantine ORDER BY id
    `).all() as Array<{ seq: string; kind: string | null; origin_local_id: string | null; reason: string; raw_body: string }>;
  }

  it('sets aside an op that can never apply and moves the cursor past it, keeping the rest of the batch', () => {
    const apply = makeApply();
    const poisoned = [
      op(1, 'observation', '11', obsBody()),
      op(2, 'prompt', '31', 'not json{'),
      op(3, 'summary', '21', sumBody()),
    ];

    const result = apply.applyOps(poisoned);

    expect(result.applied).toBe(2);
    expect(result.quarantined).toBe(1);
    expect(apply.getCursor()).toBe('3');
    expect(count('observations')).toBe(1);
    expect(count('session_summaries')).toBe(1);
    expect(count('user_prompts')).toBe(0);
    expect(quarantined()).toEqual([{
      seq: '2',
      kind: 'prompt',
      origin_local_id: '31',
      reason: expect.stringMatching(/not parseable JSON/),
      raw_body: 'not json{',
    }]);
  });

  it('rolls back only the failing op: its partial writes (stub session) do not survive the set-aside', () => {
    const apply = makeApply();
    // Valid enough to create a stub session, then fails on a typed field.
    const result = apply.applyOps([
      op(1, 'summary', '21', sumBody({ memory_session_id: 'mem-only-from-bad-op', prompt_number: 'three' })),
    ]);
    expect(result.quarantined).toBe(1);
    expect(apply.getCursor()).toBe('1');
    expect(db.prepare("SELECT COUNT(*) AS n FROM sdk_sessions WHERE memory_session_id = 'mem-only-from-bad-op'").get())
      .toEqual({ n: 0 });
  });

  it('still rolls back the whole batch (rows AND cursor) on a transient error, so the page is retried', () => {
    const apply = makeApply();
    // A missing table is a database fault, not a property of the op — it
    // must never be set aside (that would drop good ops on a broken disk).
    db.run('ALTER TABLE session_summaries RENAME TO session_summaries_away');

    expect(() => apply.applyOps(remoteBatch())).toThrow(/no such table/);

    expect(count('observations')).toBe(0);
    expect(count('sdk_sessions')).toBe(1); // stub session rolled back too
    expect(count('sync_pull_quarantine')).toBe(0);
    expect(apply.getCursor()).toBe('0');

    db.run('ALTER TABLE session_summaries_away RENAME TO session_summaries');
    const retried = apply.applyOps(remoteBatch());
    expect(retried.applied).toBe(3);
    expect(apply.getCursor()).toBe('3');
  });

  it('sets aside an op that violates a constraint instead of wedging on it', () => {
    const apply = makeApply();
    db.run('CREATE UNIQUE INDEX test_one_request ON session_summaries(request)');
    const result = apply.applyOps([
      op(1, 'summary', '21', sumBody({ request: 'same request' })),
      op(2, 'summary', '22', sumBody({ request: 'same request' })),
      op(3, 'observation', '11', obsBody()),
    ]);
    expect(result.applied).toBe(2);
    expect(result.quarantined).toBe(1);
    expect(apply.getCursor()).toBe('3');
    expect(quarantined().map(row => [row.seq, row.reason])).toEqual([
      ['2', expect.stringMatching(/UNIQUE constraint failed/)],
    ]);
  });

  it('retries a constraint-blocked update once the blocking row is gone (no permanently stale row)', () => {
    const apply = makeApply();
    const canonical = (seq: number, originId: string, rev: string, body: Record<string, unknown> | string, extra: Partial<SyncOp> = {}): SyncOp => ({
      ...op(seq, 'observation', originId, body, { rev }),
      entity_id: `observation:${originId}`, entity_rev: rev, operation_sha256: `sha-${originId}-${rev}`, ...extra,
    });

    // A rev 2 carries the content hash B already holds in the same session.
    const first = apply.applyOps([
      canonical(1, 'A', '1', obsBody({ title: 'A one', content_hash: 'h-a1' })),
      canonical(2, 'B', '1', obsBody({ title: 'B one', content_hash: 'h-shared' })),
      canonical(3, 'A', '2', obsBody({ title: 'A two', content_hash: 'h-shared' })),
    ]);
    expect(first.quarantined).toBe(1);
    expect(apply.getCursor()).toBe('3');
    expect(db.prepare("SELECT seq, retryable FROM sync_pull_quarantine").all()).toEqual([{ seq: '3', retryable: 1 }]);
    expect(db.prepare("SELECT title, sync_rev FROM observations WHERE origin_local_id = 'A'").get())
      .toEqual({ title: 'A one', sync_rev: '1' });

    // An unrelated batch: B still holds the hash, so A rev 2 stays set aside.
    apply.applyOps([canonical(4, 'C', '1', obsBody({ title: 'C one', content_hash: 'h-c1' }))]);
    expect(count('sync_pull_quarantine')).toBe(1);

    // B is deleted: the end-of-batch retry applies A rev 2 and clears the record.
    apply.applyOps([canonical(5, 'B', '2', '{}', { deleted: true })]);
    expect(db.prepare("SELECT title, sync_rev FROM observations WHERE origin_local_id = 'A'").get())
      .toEqual({ title: 'A two', sync_rev: '2' });
    expect(db.prepare("SELECT entity_rev FROM sync_entity_heads WHERE entity_id = 'observation:A'").get())
      .toEqual({ entity_rev: '2' });
    expect(count('sync_pull_quarantine')).toBe(0);
  });

  it('resolves a set-aside retry as stale once a newer revision of the entity applied', () => {
    const apply = makeApply();
    const canonical = (seq: number, originId: string, rev: string, body: Record<string, unknown>): SyncOp => ({
      ...op(seq, 'observation', originId, body, { rev }),
      entity_id: `observation:${originId}`, entity_rev: rev, operation_sha256: `sha-${originId}-${rev}`,
    });
    apply.applyOps([
      canonical(1, 'A', '1', obsBody({ title: 'A one', content_hash: 'h-a1' })),
      canonical(2, 'B', '1', obsBody({ title: 'B one', content_hash: 'h-shared' })),
      canonical(3, 'A', '2', obsBody({ title: 'A two', content_hash: 'h-shared' })), // set aside
      canonical(4, 'A', '3', obsBody({ title: 'A three', content_hash: 'h-a3' })),
    ]);
    // Rev 3 applied after rev 2 was set aside; the retry must not roll A back.
    expect(db.prepare("SELECT title, sync_rev FROM observations WHERE origin_local_id = 'A'").get())
      .toEqual({ title: 'A three', sync_rev: '3' });
    expect(count('sync_pull_quarantine')).toBe(0);
  });

  it('sets aside an undecodable change by seq and keeps applying the page', () => {
    const apply = makeApply();
    const result = apply.applyOps([
      op(1, 'observation', '11', obsBody()),
      { seq: '2', undecodable: 'operation_sha256 does not match body', raw: '{"seq":"2"}' },
      op(3, 'summary', '21', sumBody()),
    ], { requireContiguous: true });
    expect(result.applied).toBe(2);
    expect(result.quarantined).toBe(1);
    expect(apply.getCursor()).toBe('3');
    expect(quarantined()).toEqual([{
      seq: '2',
      kind: null,
      origin_local_id: null,
      reason: 'operation_sha256 does not match body',
      raw_body: '{"seq":"2"}',
    }]);
  });

  it('keeps the local copy when the hub sends a different body for an entity revision it already holds', () => {
    // The Oct 2026 wedge: device fe1d376d reused local id 11749 after a
    // restore, so the rebuilt hub served a different observation at the same
    // entity/rev than this device applied before the cutover.
    const apply = makeApply();
    const first = {
      ...op(1, 'observation', '11749', obsBody({ title: 'first copy', content_hash: 'hash-first' })),
      entity_id: 'observation:collided', entity_rev: '1', operation_sha256: 'sha-first',
    };
    apply.applyOps([first], { epoch: 'epoch-old' });

    const collided = {
      ...op(1, 'observation', '11749', obsBody({ title: 'second copy', content_hash: 'hash-second' })),
      entity_id: 'observation:collided', entity_rev: '1', operation_sha256: 'sha-second',
    };
    const next = { ...op(2, 'observation', '11750', obsBody({ content_hash: 'hash-next' })), entity_id: 'observation:next', entity_rev: '1', operation_sha256: 'sha-next' };
    const result = apply.applyOps([collided, next], { epoch: 'epoch-new' });
    expect(result.epochReset).toBe(true); // page discarded, cursor back to 0

    const replay = apply.applyOps([collided, next], { epoch: 'epoch-new', requireContiguous: true });
    expect(replay.quarantined).toBe(1);
    expect(replay.applied).toBe(1);
    expect(apply.getCursor()).toBe('2');
    expect(db.prepare("SELECT title FROM observations WHERE origin_local_id = '11749'").get())
      .toEqual({ title: 'first copy' });
    expect(db.prepare("SELECT operation_sha256 FROM sync_entity_heads WHERE entity_id = 'observation:collided'").get())
      .toEqual({ operation_sha256: 'sha-first' });
    expect(quarantined().map(row => row.reason)).toEqual([
      expect.stringMatching(/different canonical operation hash \(kept local sha-first, hub sent sha-second\)/),
    ]);
  });

  it('rolls back rows and cursor when an HTTP page has a first-seq or internal gap', () => {
    const apply = makeApply();
    expect(() => apply.applyOps([
      op(1, 'observation', 'gap-1', obsBody()),
      op(3, 'observation', 'gap-3', obsBody({ title: 'must roll back' })),
    ], { requireContiguous: true })).toThrow(/sequence gap.*expected 2, got 3/);
    expect(apply.getCursor()).toBe('0');
    expect(db.prepare("SELECT COUNT(*) AS n FROM observations WHERE origin_local_id IN ('gap-1','gap-3')").get())
      .toEqual({ n: 0 });

    expect(() => apply.applyOps([
      op(2, 'observation', 'first-gap', obsBody()),
    ], { requireContiguous: true })).toThrow(/sequence gap.*expected 1, got 2/);
    expect(apply.getCursor()).toBe('0');
  });

  it('rejects stale-prefixed HTTP pages before cursor skipping and preserves the transaction', () => {
    const apply = makeApply();
    apply.applyOps([
      op(1, 'observation', 'seed-1', obsBody({ content_hash: 'seed-1' })),
      op(2, 'observation', 'seed-2', obsBody({ content_hash: 'seed-2' })),
    ]);
    expect(apply.getCursor()).toBe('2');

    // Exact [cursor, cursor+1] regression: strict pages must begin at 3,
    // rather than skipping 2 and accepting the fresh suffix.
    expect(() => apply.applyOps([
      op(2, 'observation', 'cursor-prefix', obsBody({ content_hash: 'cursor-prefix' })),
      op(3, 'observation', 'fresh-after-cursor', obsBody({ content_hash: 'fresh-after-cursor' })),
    ], { requireContiguous: true })).toThrow(/sequence gap.*expected 3, got 2/);
    expect(apply.getCursor()).toBe('2');
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM observations
      WHERE origin_local_id IN ('cursor-prefix', 'fresh-after-cursor')
    `).get()).toEqual({ n: 0 });

    // An out-of-order stale prefix was also previously skipped wholesale,
    // allowing seq 3 to commit. The raw supplied order is now rejected.
    expect(() => apply.applyOps([
      op(2, 'observation', 'stale-prefix-2', obsBody({ content_hash: 'stale-prefix-2' })),
      op(1, 'observation', 'stale-prefix-1', obsBody({ content_hash: 'stale-prefix-1' })),
      op(3, 'observation', 'fresh-after-disorder', obsBody({ content_hash: 'fresh-after-disorder' })),
    ], { requireContiguous: true })).toThrow(/sequence gap.*expected 3, got 2/);
    expect(apply.getCursor()).toBe('2');
    expect(db.prepare(`
      SELECT COUNT(*) AS n FROM observations
      WHERE origin_local_id IN ('stale-prefix-2', 'stale-prefix-1', 'fresh-after-disorder')
    `).get()).toEqual({ n: 0 });
    expect(count('observations')).toBe(2);
  });

  it('keeps uint64 cursors and entity revisions as exact decimal TEXT beyond Number.MAX_SAFE_INTEGER', () => {
    const apply = makeApply();
    db.prepare("INSERT INTO sync_state (k, v) VALUES ('cursor', '9007199254740992')").run();
    apply.applyOps([
      op('9007199254740993', 'observation', '18446744073709551615', obsBody(), {
        rev: '9007199254740993',
      }),
    ], { requireContiguous: true });

    expect(apply.getCursor()).toBe('9007199254740993');
    const row = db.prepare(`
      SELECT origin_local_id, CAST(sync_rev AS TEXT) AS sync_rev
      FROM observations WHERE origin_local_id = '18446744073709551615'
    `).get();
    expect(row).toEqual({
      origin_local_id: '18446744073709551615',
      sync_rev: '9007199254740993',
    });
  });

  it('round-trips uint64-max entity revisions as TEXT and rejects a later stale revision exactly', () => {
    const apply = makeApply();
    const uint64Max = '18446744073709551615';
    const oneBelow = '18446744073709551614';

    apply.applyOps([
      op(1, 'observation', '41', obsBody({
        title: 'uint64 max',
        content_hash: 'hash-uint64-max',
      }), { rev: uint64Max }),
    ]);
    expect(db.prepare(`
      SELECT sync_rev, typeof(sync_rev) AS storage_type, title
      FROM observations WHERE origin_local_id = '41'
    `).get()).toEqual({
      sync_rev: uint64Max,
      storage_type: 'text',
      title: 'uint64 max',
    });

    const stale = apply.applyOps([
      op(2, 'observation', '41', obsBody({
        title: 'must remain stale',
        content_hash: 'hash-uint64-max-stale',
      }), { rev: oneBelow }),
    ]);
    expect(stale.skippedStale).toBe(1);
    expect(db.prepare(`
      SELECT sync_rev, typeof(sync_rev) AS storage_type, title
      FROM observations WHERE origin_local_id = '41'
    `).get()).toEqual({
      sync_rev: uint64Max,
      storage_type: 'text',
      title: 'uint64 max',
    });
  });

  it('sets aside (loud, not lossy) an op whose present field has the wrong type; missing optional fields stay tolerated', () => {
    const apply = makeApply();

    // Wrong type for a PRESENT field = malformed body = never written as
    // NULL; the op is set aside with its reason and raw body.
    const malformed = apply.applyOps([
      op(1, 'observation', '11', obsBody({ title: 42 })),
      op(2, 'observation', '12', obsBody({ prompt_number: 'three' })),
    ]);
    expect(malformed.quarantined).toBe(2);
    expect(count('observations')).toBe(0);
    expect(apply.getCursor()).toBe('2');
    expect(quarantined().map(row => row.reason)).toEqual([
      expect.stringMatching(/field title must be a string/),
      expect.stringMatching(/field prompt_number must be a finite number/),
    ]);

    // MISSING (or null) optional fields are fine — null lands in the column.
    const body = obsBody();
    delete body.title;
    delete body.subtitle;
    body.narrative = null;
    const result = apply.applyOps([op(3, 'observation', '11', body)]);
    expect(result.applied).toBe(1);
    const row = db.prepare(`SELECT title, subtitle, narrative FROM observations WHERE origin_local_id = '11'`).get() as any;
    expect(row.title).toBeNull();
    expect(row.subtitle).toBeNull();
    expect(row.narrative).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Echo guard
  // ---------------------------------------------------------------------------

  it('never re-pushes applied rows: the REAL CloudSync drain selects only native rows', async () => {
    makeApply().applyOps(remoteBatch());

    // One native, unsynced observation — the only thing the drain may find.
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, subtitle, facts, narrative,
        concepts, files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES ('mem-1', 'proj-x', 'discovery', 'Native title', NULL, NULL, 'native narrative',
        NULL, NULL, NULL, 1, 0, ?, 1751234567890)
    `).run(ISO);

    const calls: Array<{ url: string; parsed: any }> = [];
    let seq = 0;
    const fetchImpl = (async (input: any, init?: any) => {
      const parsed = JSON.parse(String(init?.body));
      calls.push({ url: String(input), parsed });
      const acked = (parsed.ops as any[]).map((op) => {
        const body = JSON.parse(op.body);
        return {
          id: body.id,
          kind: body.kind,
          origin_local_id: body.origin_local_id,
          entity_rev: body.entity_rev,
          seq: String(++seq),
        };
      });
      return new Response(JSON.stringify({
        acked,
        head_seq: String(seq),
        projected_seq: String(seq),
      }), { status: 200 });
    }) as typeof fetch;

    const sync = new CloudSync(db, makeSettings(), {
      fetchImpl,
      settingsPath,
      debounceMs: 25,
      backoffInitialMs: 20,
      backoffMaxMs: 200,
    });
    await sync.flush();

    // Exactly one POST: the native observation. The applied remote
    // observation/summary/prompt are pre-stamped synced_at (and carry origin
    // columns) — structurally invisible to the drain's
    // WHERE synced_at IS NULL AND origin_device_id IS NULL.
    expect(calls.length).toBe(1);
    expect(calls[0].url).toEndWith('/v1/sync/ops');
    expect(calls[0].parsed.ops.length).toBe(1);
    const envelope = JSON.parse(calls[0].parsed.ops[0].body);
    expect(envelope.kind).toBe('observation');
    expect(envelope.payload.title).toBe('Native title');
  });

  it('skips ops originated by this device (echo of our own pushes) while advancing the cursor', () => {
    const apply = makeApply();
    const result = apply.applyOps([
      op(1, 'observation', '11', obsBody(), { device: SELF }),
      op(2, 'observation', '12', obsBody({ content_hash: 'hash-r2', title: 'Other device' }), { device: REMOTE }),
    ]);

    expect(result.skippedOwn).toBe(1);
    expect(result.applied).toBe(1);
    expect(result.cursor).toBe('2');
    expect(count('observations')).toBe(1);
    const row = db.prepare('SELECT origin_device_id FROM observations').get() as any;
    expect(row.origin_device_id).toBe(REMOTE);
  });

  // ---------------------------------------------------------------------------
  // Rev guard
  // ---------------------------------------------------------------------------

  it('row ops: higher rev updates in place, stale rev is ignored', () => {
    const apply = makeApply();
    apply.applyOps([op(1, 'observation', '11', obsBody())]);

    // rev 2 supersedes.
    apply.applyOps([op(2, 'observation', '11', obsBody({ title: 'Rev two', content_hash: 'hash-r1v2' }), { rev: 2 })]);
    let row = db.prepare(`SELECT title, sync_rev FROM observations WHERE origin_local_id = '11'`).get() as any;
    expect(row.title).toBe('Rev two');
    expect(row.sync_rev).toBe('2');
    expect(count('observations')).toBe(1); // updated, not duplicated

    // A stale rev-1 body arriving later is silently ignored.
    const stale = apply.applyOps([op(3, 'observation', '11', obsBody({ title: 'Stale rev one' }))]);
    expect(stale.skippedStale).toBe(1);
    row = db.prepare(`SELECT title, sync_rev FROM observations WHERE origin_local_id = '11'`).get() as any;
    expect(row.title).toBe('Rev two');
    expect(row.sync_rev).toBe('2');
  });

  it('mutations: rev >= sync_rev applies, stale mutation is silently skipped', () => {
    const apply = makeApply();
    // Orphan remote prompt (origin session not registered yet).
    apply.applyOps([op(1, 'prompt', '31', promptBody({ memory_session_id: null, project: null }))]);
    let prompt = db.prepare(`SELECT id, session_db_id, sync_rev FROM user_prompts WHERE origin_local_id = '31'`).get() as any;
    expect(prompt.session_db_id).toBeNull();

    // The origin registers its memory session and emits the repair op (rev 2).
    apply.applyOps([op(2, 'mutation', 'uuid-repair-1', {
      op: 'set_prompt_session',
      target: { origin_device_id: REMOTE, origin_local_id: '31' },
      fields: { memory_session_id: 'mem-remote-1', project: 'proj-remote', content_session_id: 'sess-remote-1' },
    }, { rev: 2 })]);
    prompt = db.prepare(`SELECT session_db_id, sync_rev FROM user_prompts WHERE origin_local_id = '31'`).get() as any;
    const stub = db.prepare(`SELECT id FROM sdk_sessions WHERE memory_session_id = 'mem-remote-1'`).get() as any;
    expect(prompt.session_db_id).toBe(stub.id);
    expect(prompt.sync_rev).toBe('2');

    // A stale rev-1 mutation pointing somewhere else is ignored.
    const stale = apply.applyOps([op(3, 'mutation', 'uuid-repair-0', {
      op: 'set_prompt_session',
      target: { origin_device_id: REMOTE, origin_local_id: '31' },
      fields: { memory_session_id: 'mem-1' },
    }, { rev: 1 })]);
    expect(stale.skippedStale).toBe(1);
    prompt = db.prepare(`SELECT session_db_id, sync_rev FROM user_prompts WHERE origin_local_id = '31'`).get() as any;
    expect(prompt.session_db_id).toBe(stub.id); // unchanged
    expect(prompt.sync_rev).toBe('2');
  });

  it('links a prompt whose origin session has no memory id to a content-keyed session, which a later memory id adopts', () => {
    const apply = makeApply();
    // The origin's session has a project but no memory id (its memory agent
    // never started), so no set_prompt_session repair may ever come.
    apply.applyOps([op(1, 'prompt', '31', promptBody({ memory_session_id: null }))]);
    const session = db.prepare(`SELECT * FROM sdk_sessions WHERE content_session_id = 'sess-remote-1'`).get() as any;
    expect(session.project).toBe('proj-remote');
    expect(session.memory_session_id).toBeNull();
    // Linked, so the Chroma backfill finds the prompt's project through its session.
    let prompt = db.prepare(`SELECT session_db_id FROM user_prompts WHERE origin_local_id = '31'`).get() as any;
    expect(prompt.session_db_id).toBe(session.id);

    // The origin sends project 'unknown' when it has no session at all: still an orphan.
    apply.applyOps([op(3, 'prompt', '33', promptBody({
      memory_session_id: null, project: 'unknown', content_session_id: 'sess-remote-9',
    }))]);
    const unknownPrompt = db.prepare(`SELECT session_db_id FROM user_prompts WHERE origin_local_id = '33'`).get() as any;
    expect(unknownPrompt.session_db_id).toBeNull();

    // If the origin does register later, its repair op adopts the same session.
    apply.applyOps([op(4, 'mutation', 'uuid-repair-1', {
      op: 'set_prompt_session',
      target: { origin_device_id: REMOTE, origin_local_id: '31' },
      fields: { memory_session_id: 'mem-remote-1', project: 'proj-remote', content_session_id: 'sess-remote-1' },
    }, { rev: 2 })]);
    const adopted = db.prepare(`SELECT id FROM sdk_sessions WHERE memory_session_id = 'mem-remote-1'`).get() as any;
    expect(adopted.id).toBe(session.id);
    expect(count('sdk_sessions')).toBe(2); // native seed + the one content-keyed session
    prompt = db.prepare(`SELECT session_db_id FROM user_prompts WHERE origin_local_id = '31'`).get() as any;
    expect(prompt.session_db_id).toBe(session.id);
  });

  it('adopting a session by content id keeps the memory id it already has', () => {
    const apply = makeApply();
    apply.applyOps([op(1, 'prompt', '31', promptBody())]); // session sess-remote-1 ↔ mem-remote-1
    // Another memory id claims the same content id: adopt, but do not overwrite.
    apply.applyOps([op(2, 'prompt', '32', promptBody({ memory_session_id: 'mem-remote-2', prompt_number: 2 }))]);
    const sessions = db.prepare(`SELECT memory_session_id FROM sdk_sessions WHERE content_session_id = 'sess-remote-1'`).all() as any[];
    expect(sessions.map((s) => s.memory_session_id)).toEqual(['mem-remote-1']);
  });

  it('merges the content-keyed session into the memory session when an observation arrives before the repair', () => {
    const apply = makeApply();
    // The prompt arrives before its memory id, then the title (content target).
    apply.applyOps([
      op(1, 'prompt', '31', promptBody({ memory_session_id: null })),
      op(2, 'mutation', 'uuid-title-1', {
        op: 'set_title',
        target: { content_session_id: 'sess-remote-1', platform_source: 'claude' },
        fields: { custom_title: 'Early title' },
      }),
    ]);
    // The origin registers; an observation overtakes the repair op.
    apply.applyOps([op(3, 'observation', '11', obsBody())]);
    apply.applyOps([op(4, 'mutation', 'uuid-repair-1', {
      op: 'set_prompt_session',
      target: { origin_device_id: REMOTE, origin_local_id: '31' },
      fields: { memory_session_id: 'mem-remote-1', project: 'proj-remote', content_session_id: 'sess-remote-1' },
    }, { rev: 2 })]);

    const sessions = db.prepare(`
      SELECT id, content_session_id, memory_session_id, custom_title FROM sdk_sessions
      WHERE memory_session_id = 'mem-remote-1' OR content_session_id = 'sess-remote-1'
    `).all() as any[];
    expect(sessions).toHaveLength(1); // one logical session, one row
    expect(sessions[0].content_session_id).toBe('sess-remote-1');
    expect(sessions[0].custom_title).toBe('Early title');
    const prompt = db.prepare(`SELECT session_db_id FROM user_prompts WHERE origin_local_id = '31'`).get() as any;
    expect(prompt.session_db_id).toBe(sessions[0].id);
  });

  it('the merge moves tool_uses rows, which reference the session without a foreign key', () => {
    const apply = makeApply();
    apply.applyOps([op(1, 'prompt', '31', promptBody({ memory_session_id: null }))]);
    const contentKeyed = db.prepare(`SELECT id FROM sdk_sessions WHERE content_session_id = 'sess-remote-1'`).get() as any;
    db.prepare(`
      INSERT INTO tool_uses (tool_use_id, content_session_id, session_db_id, project, tool_name, created_at, created_at_epoch)
      VALUES ('tu-1', 'sess-remote-1', ?, 'proj-remote', 'Bash', ?, 1751234567892)
    `).run(contentKeyed.id, ISO);

    apply.applyOps([op(2, 'observation', '11', obsBody())]);
    apply.applyOps([op(3, 'mutation', 'uuid-repair-1', {
      op: 'set_prompt_session',
      target: { origin_device_id: REMOTE, origin_local_id: '31' },
      fields: { memory_session_id: 'mem-remote-1', project: 'proj-remote', content_session_id: 'sess-remote-1' },
    }, { rev: 2 })]);

    const merged = db.prepare(`SELECT id FROM sdk_sessions WHERE memory_session_id = 'mem-remote-1'`).get() as any;
    const tool = db.prepare(`SELECT session_db_id FROM tool_uses WHERE tool_use_id = 'tu-1'`).get() as any;
    expect(tool.session_db_id).toBe(merged.id);
  });

  it('the merge keeps the platform of the content-keyed session, so later prompts find it', () => {
    const apply = makeApply();
    const codex = { platform_source: 'codex', memory_session_id: null };
    apply.applyOps([op(1, 'prompt', '31', promptBody(codex))]);
    apply.applyOps([op(2, 'observation', '11', obsBody())]); // memory-keyed stub, default platform
    apply.applyOps([op(3, 'mutation', 'uuid-repair-1', {
      op: 'set_prompt_session',
      target: { origin_device_id: REMOTE, origin_local_id: '31' },
      fields: { memory_session_id: 'mem-remote-1', project: 'proj-remote', content_session_id: 'sess-remote-1', platform_source: 'codex' },
    }, { rev: 2 })]);
    // A later prompt of the same session, again without a memory id.
    apply.applyOps([op(4, 'prompt', '32', promptBody({ ...codex, prompt_number: 2 }))]);

    const sessions = db.prepare(`
      SELECT id, platform_source FROM sdk_sessions
      WHERE memory_session_id = 'mem-remote-1' OR content_session_id = 'sess-remote-1'
    `).all() as any[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].platform_source).toBe('codex');
    const prompts = db.prepare(`SELECT DISTINCT session_db_id FROM user_prompts WHERE origin_local_id IN ('31','32')`).all() as any[];
    expect(prompts.map((p) => p.session_db_id)).toEqual([sessions[0].id]);
  });

  it('mutations from another device apply to NATIVE rows via the self-origin identity', () => {
    // A native prompt (origin columns NULL — NULL = this device).
    db.prepare(`
      INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (NULL, 'sess-abc', 1, 'native prompt', ?, 1751234567892)
    `).run(ISO);
    const nativeId = (db.prepare('SELECT id FROM user_prompts').get() as any).id as number;

    const apply = makeApply();
    apply.applyOps([op(1, 'mutation', 'uuid-x1', {
      op: 'set_prompt_session',
      target: { origin_device_id: SELF, origin_local_id: String(nativeId) },
      fields: { memory_session_id: 'mem-1' },
    }, { rev: 2 })]);

    const row = db.prepare('SELECT session_db_id, sync_rev, synced_at FROM user_prompts WHERE id = ?').get(nativeId) as any;
    expect(row.session_db_id).toBe(1); // linked to the native session mem-1
    expect(row.sync_rev).toBe('2');
    expect(row.synced_at).toBeNull(); // apply never flips push state on native rows
  });

  it('set_title in genuine hub-log order (title BEFORE the row ops) parks, then lands on claim', () => {
    const apply = makeApply();
    // Emit-time reality: custom_title is written at session creation, before
    // memory_session_id registers — the op targets the content identity and
    // precedes every row op for that session in the log.
    apply.applyOps([
      op(1, 'mutation', 'uuid-title-1', {
        op: 'set_title',
        target: { content_session_id: 'sess-remote-1', platform_source: 'claude' },
        fields: { custom_title: 'Hub-order title' },
      }),
      op(2, 'observation', '11', obsBody()),
      op(3, 'prompt', '31', promptBody()),
    ], { epoch: 'epoch-1' });

    const session = db.prepare(`SELECT custom_title FROM sdk_sessions WHERE memory_session_id = 'mem-remote-1'`).get() as any;
    expect(session.custom_title).toBe('Hub-order title');
    // The parking entry was consumed.
    const parked = db.prepare(`SELECT COUNT(*) AS n FROM sync_state WHERE k LIKE 'parked_title:%'`).get() as any;
    expect(parked.n).toBe(0);

    // Epoch-reset replay converges to the same state.
    const before = snapshot('sdk_sessions');
    apply.applyOps([], { epoch: 'epoch-2' }); // reset
    apply.applyOps([
      op(1, 'mutation', 'uuid-title-1', {
        op: 'set_title',
        target: { content_session_id: 'sess-remote-1', platform_source: 'claude' },
        fields: { custom_title: 'Hub-order title' },
      }),
      op(2, 'observation', '11', obsBody()),
      op(3, 'prompt', '31', promptBody()),
    ], { epoch: 'epoch-2' });
    expect(snapshot('sdk_sessions')).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_state WHERE k LIKE 'parked_title:%'`).get() as any).toEqual({ n: 0 });
  });

  it('set_title in reverse order (row ops first) lands via the replicated prompt fallback', () => {
    const apply = makeApply();
    apply.applyOps([
      op(1, 'observation', '11', obsBody()),
      op(2, 'prompt', '31', promptBody()),
      op(3, 'mutation', 'uuid-title-2', {
        op: 'set_title',
        target: { content_session_id: 'sess-remote-1', platform_source: 'claude' },
        fields: { custom_title: 'Late title' },
      }),
    ]);

    // The obs-created stub carries a synthetic content id (mem-remote-1), so
    // the direct content match misses — the replicated prompt resolves it.
    const session = db.prepare(`SELECT custom_title, content_session_id FROM sdk_sessions WHERE memory_session_id = 'mem-remote-1'`).get() as any;
    expect(session.content_session_id).toBe('mem-remote-1');
    expect(session.custom_title).toBe('Late title');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_state WHERE k LIKE 'parked_title:%'`).get() as any).toEqual({ n: 0 });
  });

  it('a mem-targeted set_title for a not-yet-known session parks and lands when the session materializes', () => {
    const apply = makeApply();
    apply.applyOps([
      op(1, 'mutation', 'uuid-title-3', {
        op: 'set_title',
        target: { memory_session_id: 'mem-remote-1' },
        fields: { custom_title: 'Parked by mem' },
      }),
    ]);
    expect((db.prepare(`SELECT v FROM sync_state WHERE k = 'parked_title:mem:mem-remote-1'`).get() as any).v).toBe('Parked by mem');

    apply.applyOps([op(2, 'observation', '11', obsBody())]);
    const session = db.prepare(`SELECT custom_title FROM sdk_sessions WHERE memory_session_id = 'mem-remote-1'`).get() as any;
    expect(session.custom_title).toBe('Parked by mem');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sync_state WHERE k LIKE 'parked_title:%'`).get() as any).toEqual({ n: 0 });
  });

  it('set_title applies to sdk_sessions in log order', () => {
    const apply = makeApply();
    apply.applyOps([
      op(1, 'mutation', 'uuid-t1', {
        op: 'set_title',
        target: { memory_session_id: 'mem-1' },
        fields: { custom_title: 'First title' },
      }),
      op(2, 'mutation', 'uuid-t2', {
        op: 'set_title',
        target: { content_session_id: 'sess-abc', platform_source: 'claude' },
        fields: { custom_title: 'Last title wins' },
      }),
    ]);
    const session = db.prepare(`SELECT custom_title FROM sdk_sessions WHERE memory_session_id = 'mem-1'`).get() as any;
    expect(session.custom_title).toBe('Last title wins');
  });

  it('remap_project: worktree shape (merged_into_project) and cwd shape (project + session)', () => {
    const apply = makeApply();
    apply.applyOps([
      op(1, 'observation', '11', obsBody()),
      op(2, 'observation', '12', obsBody({ content_hash: 'hash-r2', title: 'Second' })),
      op(3, 'summary', '21', sumBody()),
    ], { epoch: 'epoch-1' });

    // WorktreeAdoption.ts:210-215 shape.
    apply.applyOps([op(4, 'mutation', 'uuid-m1', {
      op: 'remap_project',
      where: { project: 'proj-remote', merged_into_project_is_null: true },
      fields: { merged_into_project: 'proj-parent' },
    })]);
    const merged = db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE merged_into_project = 'proj-parent'`).get() as any;
    expect(merged.n).toBe(2);
    const mergedSum = db.prepare(`SELECT merged_into_project FROM session_summaries WHERE origin_local_id = '21'`).get() as any;
    expect(mergedSum.merged_into_project).toBe('proj-parent');

    // A genuine epoch-reset replay of the same remap is a no-op: the
    // merged_into_project IS NULL predicate no longer matches anything.
    apply.handleEpoch('epoch-replay');
    expect(apply.getCursor()).toBe('0');
    const beforeReplay = snapshot('observations');
    const replay = apply.applyOps([op(4, 'mutation', 'uuid-m1', {
      op: 'remap_project',
      where: { project: 'proj-remote', merged_into_project_is_null: true },
      fields: { merged_into_project: 'proj-parent' },
    })]);
    expect(replay.skippedStale).toBe(1);
    expect(snapshot('observations')).toEqual(beforeReplay);

    // ProcessManager.ts:312-314 shape — also retargets the session row.
    apply.applyOps([op(5, 'mutation', 'uuid-m2', {
      op: 'remap_project',
      where: { memory_session_id: 'mem-remote-1' },
      fields: { project: 'proj-new' },
    })]);
    const remappedObs = db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE project = 'proj-new'`).get() as any;
    expect(remappedObs.n).toBe(2);
    const remappedSession = db.prepare(`SELECT project FROM sdk_sessions WHERE memory_session_id = 'mem-remote-1'`).get() as any;
    expect(remappedSession.project).toBe('proj-new');
  });

  // ---------------------------------------------------------------------------
  // Epoch guard
  // ---------------------------------------------------------------------------

  it('resets the cursor (and applies nothing) when the pull epoch changes', () => {
    const apply = makeApply();
    apply.applyOps(remoteBatch(), { epoch: 'epoch-1' });
    expect(apply.getCursor()).toBe('3');

    const result = apply.applyOps([op(4, 'observation', '99', obsBody({ content_hash: 'hash-99' }))], { epoch: 'epoch-2' });
    expect(result.epochReset).toBe(true);
    expect(result.applied).toBe(0);
    expect(apply.getCursor()).toBe('0');
    expect(apply.getEpoch()).toBe('epoch-2');
    // Nothing from the stale-cursor page was applied.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE origin_local_id = '99'`).get() as any).toEqual({ n: 0 });
  });

  it('adopts the first-ever epoch without a reset', () => {
    const apply = makeApply();
    expect(apply.getEpoch()).toBeNull();
    const result = apply.applyOps(remoteBatch(), { epoch: 'epoch-initial' });
    expect(result.epochReset).toBe(false);
    expect(result.applied).toBe(3);
    expect(apply.getEpoch()).toBe('epoch-initial');
  });

  // ---------------------------------------------------------------------------
  // FTS
  // ---------------------------------------------------------------------------

  it('applied rows land in FTS via the existing triggers (when FTS5 is available)', () => {
    if (!isFts5Available()) return; // graceful-absence platforms skip (search uses Chroma)

    // observations/summaries FTS + triggers live in SessionSearch — create
    // them BEFORE applying, exactly like a running worker does.
    const search = new SessionSearch(db);

    makeApply().applyOps(remoteBatch());

    const obsHits = db.prepare(
      `SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'narrative'`
    ).all();
    expect(obsHits.length).toBe(1);

    const summaryHits = db.prepare(
      `SELECT rowid FROM session_summaries_fts WHERE session_summaries_fts MATCH 'investigated'`
    ).all();
    expect(summaryHits.length).toBe(1);

    // Prompts have no FTS index (it was write-only, schema v54); they are searched by substring.
    expect(search.searchUserPrompts('remote', {})).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Chroma (fire-and-forget, after commit)
  // ---------------------------------------------------------------------------

  it('forwards applied rows to Chroma after commit, fire-and-forget', async () => {
    const calls: Array<{ kind: string; id: number; mem: string; project: string }> = [];
    const chroma: ChromaSyncLike = {
      async syncObservation(id, mem, project) { calls.push({ kind: 'obs', id, mem, project }); },
      async syncSummary(id, mem, project) { calls.push({ kind: 'sum', id, mem, project }); },
      async syncUserPrompt(id, mem, project) { calls.push({ kind: 'prompt', id, mem, project }); },
    };

    makeApply({ chromaSync: chroma }).applyOps(remoteBatch());
    await sleep(10);

    expect(calls.map(c => c.kind).sort()).toEqual(['obs', 'prompt', 'sum']);
    for (const call of calls) {
      expect(call.mem).toBe('mem-remote-1');
      expect(call.project).toBe('proj-remote');
    }
  });

  it('a failing Chroma forward never fails or unwinds durable application', async () => {
    const chroma: ChromaSyncLike = {
      syncObservation: () => Promise.reject(new Error('chroma down')),
      syncSummary: () => Promise.reject(new Error('chroma down')),
      syncUserPrompt: () => Promise.reject(new Error('chroma down')),
    };

    const apply = makeApply({ chromaSync: chroma });
    const result = apply.applyOps(remoteBatch());
    await sleep(10);

    expect(result.applied).toBe(3);
    expect(count('observations')).toBe(1);
    expect(count('user_prompts')).toBe(1);
    expect(apply.getCursor()).toBe('3');
  });

  // ---------------------------------------------------------------------------
  // Epoch rebuild requeue: a MISMATCH means the hub's log was lost/rebuilt —
  // this device's corpus is not in the new log, so native rows must re-enter
  // the push queue. Pull-side self-healing alone would leave every counter
  // healthy while other devices converge on empty history.
  // ---------------------------------------------------------------------------
  describe('epoch rebuild requeue', () => {
    function seedNativeAndReplica(apply: SyncApply): void {
      // Replica rows arrive via apply (pre-stamped synced_at) under epoch-1.
      apply.applyOps(remoteBatch(), { epoch: 'epoch-1' });
      // A native row already pushed and stamped.
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch, synced_at)
        VALUES ('mem-remote-1', 'proj-remote', 'discovery', 'native-row', ?, 1751234567890, 111)
      `).run(REMOTE_ISO);
    }

    it('epoch MISMATCH re-nulls native rows (re-push) and leaves replicas stamped', () => {
      const apply = makeApply();
      seedNativeAndReplica(apply);

      const result = apply.applyOps([], { epoch: 'epoch-2' });
      expect(result.epochReset).toBe(true);
      expect(apply.getCursor()).toBe('0');

      const native = db.prepare(`SELECT synced_at FROM observations WHERE title = 'native-row'`).get() as any;
      expect(native.synced_at).toBeNull(); // corpus re-enters the rebuilt log
      const replicas = db.prepare(`
        SELECT COUNT(*) AS n FROM observations WHERE origin_device_id IS NOT NULL AND synced_at IS NULL
      `).get() as any;
      expect(replicas.n).toBe(0); // replicas must never re-push under our identity
      const replicaPrompt = db.prepare(`
        SELECT synced_at FROM user_prompts WHERE origin_device_id IS NOT NULL
      `).get() as any;
      expect(replicaPrompt.synced_at).not.toBeNull();
    });

    it('first-epoch ADOPTION does not requeue anything', () => {
      const apply = makeApply();
      db.prepare(`
        INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
        VALUES ('sess-n', 'mem-n', 'proj-n', ?, 1751234567000, 'active')
      `).run(ISO);
      db.prepare(`
        INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch, synced_at)
        VALUES ('mem-n', 'proj-n', 'discovery', 'native-row', ?, 1751234567890, 111)
      `).run(REMOTE_ISO);

      const result = apply.applyOps([], { epoch: 'epoch-1' }); // first epoch ever
      expect(result.epochReset).toBe(false);

      const native = db.prepare(`SELECT synced_at FROM observations WHERE title = 'native-row'`).get() as any;
      expect(native.synced_at).toBe(111); // adoption is not a rebuild
    });
  });
});
