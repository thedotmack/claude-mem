import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { storeObservations } from '../../src/services/sqlite/transactions.js';
import { createSDKSession, updateMemorySessionId } from '../../src/services/sqlite/Sessions.js';
import { __setCloudEnabledForTest, writeCloudConfig } from '../../src/services/cloud/config.js';
import { countByStatus, claimPending } from '../../src/services/cloud/outbox.js';
import { CloudSyncService } from '../../src/services/cloud/CloudSyncService.js';
import type { CloudClient, CloudPostResult, SyncStatusResult } from '../../src/services/cloud/CloudClient.js';

/**
 * A controllable fake CloudClient. We inject it so no real network is touched.
 * Each method records its calls and returns a queued response (or default 200).
 */
class FakeCloudClient {
  batchCalls: Array<{ route: string; items: unknown[]; lane: string }> = [];
  tombstoneCalls: Array<{ table: string; kind: string; items: unknown[] }> = [];
  statusCalls: string[] = [];
  // Decide a response per batch call. Default: ok 200.
  batchResponder: (route: string, items: unknown[]) => CloudPostResult = () => ({ ok: true, status: 200 });
  statusResponder: (project: string) => { result: SyncStatusResult | null; status: number } = () => ({
    result: { observations: [], summaries: [], prompts: [] },
    status: 200,
  });

  async postBatch(route: string, _key: string, items: unknown[], lane: string): Promise<CloudPostResult> {
    this.batchCalls.push({ route, items, lane });
    return this.batchResponder(route, items);
  }
  async postTombstone(table: string, kind: string, items: unknown[]): Promise<CloudPostResult> {
    this.tombstoneCalls.push({ table, kind, items });
    return { ok: true, status: 200 };
  }
  async getStatus(project: string): Promise<{ result: SyncStatusResult | null; status: number }> {
    this.statusCalls.push(project);
    return this.statusResponder(project);
  }
  async validateToken() {
    return { valid: true, status: 200, authError: false };
  }
}

function seedObs(db: Database, content: string, memory: string, project = 'proj-a', count = 1): number[] {
  const dbId = createSDKSession(db, content, project, 'initial');
  updateMemorySessionId(db, dbId, memory);
  const obs = Array.from({ length: count }, (_, i) => ({
    type: 'discovery', title: `T${i}`, subtitle: null, facts: ['f'], narrative: null,
    concepts: ['c'], files_read: [], files_modified: [],
  }));
  return storeObservations(db, memory, project, obs).observationIds;
}

// Small helper to let the event-loop drain the async drain loop.
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// Track every service so we can guarantee it is stopped + idle before its db is
// closed, even when an assertion fails mid-test (otherwise a leaked outboxEvents
// listener would fire on a closed db and contaminate later test files).
const liveServices = new Set<CloudSyncService>();
function track(svc: CloudSyncService): CloudSyncService {
  liveServices.add(svc);
  return svc;
}
async function quiesce(svc: CloudSyncService): Promise<void> {
  svc.stop();
  for (let i = 0; i < 200 && svc.isBusy(); i++) await tick(10);
  liveServices.delete(svc);
}
async function quiesceAll(): Promise<void> {
  for (const svc of liveServices) {
    svc.stop();
    for (let i = 0; i < 200 && svc.isBusy(); i++) await tick(10);
  }
  liveServices.clear();
}

describe('CloudSyncService pusher', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    __setCloudEnabledForTest(true);
    // Provide identity so any non-injected path could read it (not used here).
    writeCloudConfig({ enabled: true, userId: 'u1', deviceId: 'd1', setupToken: 'tok' });
  });
  afterEach(async () => {
    __setCloudEnabledForTest(null);
    writeCloudConfig({ enabled: false, userId: undefined, deviceId: undefined, setupToken: undefined, backfillDone: undefined, backfillCursor: undefined });
    await quiesceAll();
    db.close();
  });

  it('claims live rows, posts ONE batch per kind, and markDone removes them on 2xx', async () => {
    seedObs(db, 'c1', 'm1', 'proj-a', 3);
    expect(countByStatus(db).pending).toBe(3);

    const fake = new FakeCloudClient();
    const svc = track(new CloudSyncService(() => db, undefined, fake as unknown as CloudClient, false));
    svc.start();
    await tick();

    // One coalesced batch for the single kind, carrying all 3 observations.
    const obsBatches = fake.batchCalls.filter((c) => c.route === 'observations');
    expect(obsBatches.length).toBeGreaterThanOrEqual(1);
    expect(obsBatches[0].lane).toBe('live');
    expect(obsBatches[0].items.length).toBe(3);

    // markDone deleted the rows.
    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM cloud_outbox').get() as { n: number }).n;
    expect(remaining).toBe(0);
    await quiesce(svc);
  });

  it('401 -> authError set and lane paused (no further posts)', async () => {
    seedObs(db, 'c1', 'm1', 'proj-a', 2);
    const fake = new FakeCloudClient();
    fake.batchResponder = () => ({ ok: false, status: 401 });
    const svc = track(new CloudSyncService(() => db, undefined, fake as unknown as CloudClient, false));
    svc.start();
    await tick();

    expect(svc.isAuthError()).toBe(true);
    const callsAfterAuth = fake.batchCalls.length;
    // A further wake should NOT push while paused.
    seedObs(db, 'c2', 'm2', 'proj-a', 1);
    await tick();
    expect(fake.batchCalls.length).toBe(callsAfterAuth);

    // Rows reverted to pending (not lost).
    const counts = countByStatus(db);
    expect((counts.pending ?? 0)).toBeGreaterThan(0);
    await quiesce(svc);
  });

  it('batch bisect isolates a poison row on repeated failure', async () => {
    const ids = seedObs(db, 'c1', 'm1', 'proj-a', 4);
    const poison = ids[2];
    const fake = new FakeCloudClient();
    // Any batch CONTAINING the poison localId fails; batches without it succeed.
    fake.batchResponder = (_route, items) => {
      const hasPoison = (items as Array<{ localId: number }>).some((i) => i.localId === poison);
      return hasPoison ? { ok: false, status: 500 } : { ok: true, status: 200 };
    };
    const svc = track(new CloudSyncService(() => db, undefined, fake as unknown as CloudClient, false));
    svc.start();
    // Bisect drives several retries with backoff; give it time.
    await tick(3000);

    const counts = countByStatus(db);
    // The 3 clean rows are gone; the poison row ends up quarantined.
    expect(counts.quarantined).toBe(1);
    const q = db.prepare("SELECT local_id FROM cloud_outbox WHERE status='quarantined'").get() as { local_id: number };
    expect(q.local_id).toBe(poison);
    await quiesce(svc);
  }, 15000);
});

describe('CloudSyncService default-off', () => {
  let db: Database;
  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    __setCloudEnabledForTest(false);
  });
  afterEach(async () => {
    __setCloudEnabledForTest(null);
    await quiesceAll();
    db.close();
  });

  it('start() is a no-op: no fetch, no claim, nothing drained', async () => {
    // Pre-seed a pending row directly (simulating leftover queue).
    db.prepare(
      "INSERT INTO cloud_outbox (kind, local_id, target_table, status, attempts, lane, created_at_epoch) VALUES ('observation', 1, NULL, 'pending', 0, 'live', ?)"
    ).run(Date.now());

    let postCalled = false;
    const fake = new FakeCloudClient();
    const origPost = fake.postBatch.bind(fake);
    fake.postBatch = async (...args: Parameters<typeof origPost>) => {
      postCalled = true;
      return origPost(...args);
    };
    const svc = track(new CloudSyncService(() => db, undefined, fake as unknown as CloudClient, false));
    svc.start();
    await tick();

    expect(postCalled).toBe(false);
    // Row untouched (still pending, never claimed).
    const row = db.prepare("SELECT status FROM cloud_outbox WHERE local_id=1").get() as { status: string };
    expect(row.status).toBe('pending');
  });
});

describe('CloudSyncService backfill reconciliation', () => {
  let db: Database;
  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    __setCloudEnabledForTest(true);
    writeCloudConfig({ enabled: true, userId: 'u1', deviceId: 'd1', setupToken: 'tok', backfillDone: undefined, backfillCursor: undefined });
  });
  afterEach(async () => {
    __setCloudEnabledForTest(null);
    writeCloudConfig({ enabled: false, userId: undefined, deviceId: undefined, setupToken: undefined, backfillDone: undefined, backfillCursor: undefined });
    await quiesceAll();
    db.close();
  });

  it('marks backfill_done when /status counts match local counts', async () => {
    // Seed history with cloud DISABLED so no live outbox rows are created.
    __setCloudEnabledForTest(false);
    const ids = seedObs(db, 'c1', 'm1', 'proj-a', 3);
    __setCloudEnabledForTest(true);

    const fake = new FakeCloudClient();
    // Cloud already has all 3 observations for proj-a (and 0 summaries; we made 0).
    fake.statusResponder = (project) => ({
      result: project === 'proj-a'
        ? { observations: ids, summaries: [], prompts: [] }
        : { observations: [], summaries: [], prompts: [] },
      status: 200,
    });

    const svc = track(new CloudSyncService(() => db, undefined, fake as unknown as CloudClient));
    await svc.startBackfill();
    await tick(50);

    // The backfill drained (rows pushed) and reconciliation marked done.
    const { readCloudConfig } = await import('../../src/services/cloud/config.js');
    expect(readCloudConfig().backfillDone).toBe(true);
    await quiesce(svc);
  }, 10000);
});
