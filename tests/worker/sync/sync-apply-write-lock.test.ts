// A pulled page must wait for another connection's write lock instead of failing at once.
//
// The cloud viewer's first pull of a large account stalled again and again on
// "database is locked" (Phase 8 staging, SyncClient's "Pull wedged" warning)
// while the worker's shared-work-sync thread, which has its own connection,
// took the write lock for its reconcile pass. applyOps opened a deferred
// transaction whose first statement is a read. SQLite never runs the busy
// handler when a connection that already holds a read snapshot asks for the
// write lock, so busy_timeout did not apply and the page failed the moment it
// met any other writer.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SyncApply, type SyncOp } from '../../../src/services/sync/SyncApply.js';
import { SQLITE_BUSY_TIMEOUT_MS } from '../../../src/services/sqlite/connection.js';

const REMOTE = 'device-remote';
const REMOTE_EPOCH = 1751328000000;

function observationOp(seq: number): SyncOp {
  return {
    seq: String(seq),
    kind: 'observation',
    origin_device: REMOTE,
    origin_id: String(100 + seq),
    rev: '1',
    body: JSON.stringify({
      memory_session_id: 'mem-remote-1', project: 'proj-remote', text: null, type: 'discovery',
      title: `Remote observation ${seq}`, subtitle: null, facts: '[]', narrative: 'pulled', concepts: '[]',
      files_read: '[]', files_modified: '[]', prompt_number: 1, discovery_tokens: 0, content_hash: `hash-${seq}`,
      generated_by_model: null, agent_type: null, agent_id: null, metadata: null, merged_into_project: null,
      created_at: new Date(REMOTE_EPOCH).toISOString(), created_at_epoch: REMOTE_EPOCH + seq,
    }),
    server_ts: REMOTE_EPOCH + seq,
  };
}

/** Another connection, on its own thread, that holds the write lock for holdMs and then commits. */
function holdWriteLock(path: string, holdMs: number): Promise<{ released: Promise<void>; worker: Worker }> {
  const worker = new Worker(`
    const { Database } = require('bun:sqlite');
    const { parentPort, workerData } = require('node:worker_threads');
    const db = new Database(workerData.path);
    db.exec('PRAGMA busy_timeout = 1000');
    db.exec('BEGIN IMMEDIATE');
    db.exec("INSERT INTO sync_state (k, v) VALUES ('other_writer', 'held') ON CONFLICT(k) DO UPDATE SET v = excluded.v");
    parentPort.postMessage('held');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
    db.exec('COMMIT');
    db.close();
    parentPort.postMessage('released');
  `, { eval: true, workerData: { path, holdMs } });
  return new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', () => {
      const released = new Promise<void>(done => worker.once('message', () => done()));
      resolve({ released, worker });
    });
  });
}

describe('SyncApply.applyOps and another connection holding the write lock', () => {
  let dir: string;
  let path: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sync-apply-write-lock-'));
    path = join(dir, 'claude-mem.db');
    db = new Database(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    new SessionStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('waits for the lock within busy_timeout and applies the page', async () => {
    const apply = new SyncApply(db, { deviceId: 'device-self', now: () => REMOTE_EPOCH });
    const holdMs = 400;
    const { released, worker } = await holdWriteLock(path, holdMs);
    // No elapsed-time check: the hold starts before 'held' reaches this thread, so a late
    // message would shorten it. Applying at all is the proof: a deferred transaction failed
    // here at once with "database is locked".
    try {
      const result = apply.applyOps([observationOp(1), observationOp(2)]);
      expect(result.applied).toBe(2);
      expect(result.cursor).toBe('2');
    } finally {
      await released;
      await worker.terminate();
    }
    expect(apply.getCursor()).toBe('2');
    expect((db.prepare("SELECT v FROM sync_state WHERE k = 'other_writer'").get() as { v: string }).v).toBe('held');
  });

  it('still fails the page, leaving the cursor unmoved, when the lock outlasts busy_timeout', async () => {
    db.exec('PRAGMA busy_timeout = 100');
    const apply = new SyncApply(db, { deviceId: 'device-self', now: () => REMOTE_EPOCH });
    const { released, worker } = await holdWriteLock(path, 600);
    try {
      expect(() => apply.applyOps([observationOp(1)])).toThrow(/database is locked/);
    } finally {
      await released;
      await worker.terminate();
    }
    expect(apply.getCursor()).toBe('0');
    expect(apply.applyOps([observationOp(1)]).applied).toBe(1);
  });
});
