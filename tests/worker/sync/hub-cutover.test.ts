// Phase 3 verification (plan 2026-07-17, task 5): the settings-conditional
// hub-cutover one-shot, keyed on HUB IDENTITY (sync_state 'cutover_hub_url'),
// not a burnable version number. It must fire exactly once per (DB, hub URL):
// first configuration fires it, same-URL reboots are no-ops, and a DIFFERENT
// hub URL later fires it again — otherwise a device pointed at a new hub
// would never push its corpus into the new (empty) log while every counter
// read healthy. The requeue and the identity write commit in one
// transaction; settings-less constructors stay inert.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const ISO = '2026-07-09T00:00:00.000Z';

describe('hub cutover one-shot (hub-identity keyed)', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-hub-cutover-'));
    dbPath = join(tempDir, 'claude-mem.db');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function open(hubUrl?: string): SessionStore {
    return new SessionStore(dbPath, {
      cloudSyncStatePath: join(tempDir, 'none.json'),
      ...(hubUrl !== undefined ? { cloudSyncHubUrl: hubUrl } : {}),
    });
  }

  function seed(store: SessionStore): void {
    store.db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('sess-1', 'mem-1', 'proj-x', ?, 1751234567000, 'active')
    `).run(ISO);
    // A native row already pushed through some earlier lane…
    store.db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch, synced_at)
      VALUES ('mem-1', 'proj-x', 'discovery', 'native', ?, 1751234567890, 111)
    `).run(ISO);
    // …and a replica applied from the hub (another device's corpus).
    store.db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch, synced_at, origin_device_id, origin_local_id)
      VALUES ('mem-1', 'proj-x', 'discovery', 'replica', ?, 1751234567891, 222, 'device-other', '9')
    `).run(ISO);
  }

  function syncedAt(db: Database, title: string): number | null {
    return (db.prepare('SELECT synced_at FROM observations WHERE title = ?').get(title) as { synced_at: number | null }).synced_at;
  }

  function cutoverHubUrl(db: Database): string | null {
    const row = db.prepare(`SELECT v FROM sync_state WHERE k = 'cutover_hub_url'`).get() as { v: string } | undefined;
    return row?.v ?? null;
  }

  it('stays inert while the hub URL is absent (settings-less constructors included)', () => {
    const store = open();
    seed(store);
    expect(cutoverHubUrl(store.db)).toBeNull();
    store.db.close();

    const again = open(); // e.g. a CLI-path constructor that knows no settings
    expect(cutoverHubUrl(again.db)).toBeNull();
    expect(syncedAt(again.db, 'native')).toBe(111);
    again.db.close();
  });

  it('fires when the hub URL first appears: native rows requeued, replicas untouched, identity stored', () => {
    const before = open();
    seed(before);
    before.db.close();

    const cutover = open('https://hub-one.test');
    expect(cutoverHubUrl(cutover.db)).toBe('https://hub-one.test');
    expect(syncedAt(cutover.db, 'native')).toBeNull();   // re-pushes its own corpus
    expect(syncedAt(cutover.db, 'replica')).toBe(222);   // another device's corpus — never ours to push
    // Legacy bookkeeping marker still recorded (not consulted for gating).
    expect(cutover.db.prepare('SELECT version FROM schema_versions WHERE version = 43').get()).not.toBeNull();
    cutover.db.close();
  });

  it('is a no-op on later boots with the same hub URL (trailing-slash variants included)', () => {
    const first = open('https://hub-one.test');
    seed(first);
    // Simulate the drain re-stamping after the cutover push.
    first.db.prepare(`UPDATE observations SET synced_at = 333 WHERE title = 'native'`).run();
    first.db.close();

    const same = open('https://hub-one.test');
    expect(syncedAt(same.db, 'native')).toBe(333);
    same.db.close();

    const slashed = open('https://hub-one.test///');
    expect(syncedAt(slashed.db, 'native')).toBe(333); // normalized — same identity
    slashed.db.close();
  });

  it('re-fires exactly once when the hub URL CHANGES, and clearing the URL is inert', () => {
    const first = open('https://hub-one.test');
    seed(first);
    first.db.prepare(`UPDATE observations SET synced_at = 333 WHERE title = 'native'`).run();
    first.db.close();

    // (a) URL cleared: sync is OFF; nothing fires, identity is retained.
    const cleared = open('');
    expect(syncedAt(cleared.db, 'native')).toBe(333);
    expect(cutoverHubUrl(cleared.db)).toBe('https://hub-one.test');
    cleared.db.close();

    // A DIFFERENT hub appears: its log has none of our corpus — re-fire.
    const second = open('https://hub-two.test');
    expect(cutoverHubUrl(second.db)).toBe('https://hub-two.test');
    expect(syncedAt(second.db, 'native')).toBeNull();
    expect(syncedAt(second.db, 'replica')).toBe(222);
    second.db.prepare(`UPDATE observations SET synced_at = 444 WHERE title = 'native'`).run();
    second.db.close();

    // Same second URL again: exactly-once per (DB, hub URL).
    const again = open('https://hub-two.test');
    expect(syncedAt(again.db, 'native')).toBe(444);
    again.db.close();
  });

  it('self-heals pre-fix DBs that burned v43 without a stored hub identity', () => {
    const legacy = open();
    seed(legacy);
    // Simulate the pre-fix state: v43 burned, no cutover_hub_url row.
    legacy.db.prepare(`INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (43, ?)`).run(ISO);
    legacy.db.close();

    const healed = open('https://hub-one.test');
    expect(syncedAt(healed.db, 'native')).toBeNull(); // one extra re-push; hub dedupe makes it safe
    expect(cutoverHubUrl(healed.db)).toBe('https://hub-one.test');
    healed.db.close();
  });
});
