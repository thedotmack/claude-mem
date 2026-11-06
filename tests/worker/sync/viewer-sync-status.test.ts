import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { SyncClient, keepPullingOptions } from '../../../src/services/sync/SyncClient.js';
import { CloudSync } from '../../../src/services/sync/CloudSync.js';
import { ViewerActivity, ViewerSyncService } from '../../../src/services/sync/ViewerSyncService.js';
import { composeViewerSyncStatus, type SyncDownloadStatus, type SyncUploadEvidence } from '../../../src/shared/viewer-sync-status.js';

const resources: Array<() => void> = [];
afterEach(() => { for (const close of resources.splice(0).reverse()) close(); });
const download = (overrides: Partial<SyncDownloadStatus> = {}): SyncDownloadStatus => ({
  started: true, inFlight: false, suspended: false, authPaused: false, lastAttemptAt: 1000, lastSuccessAt: 1000,
  lastError: null, nextRetryAt: 31000, epoch: '1', cursor: '9007199254740993', mode: 'polling',
  realtimeAvailable: false, socketLive: false, caughtUp: true, ...overrides,
});
const upload = (overrides: Partial<SyncUploadEvidence> = {}): SyncUploadEvidence => ({
  configured: true, pending: { observations: 0 }, lastFlushAt: 1000, lastError: null, authError: null,
  quarantine: { count: 0 }, pullQuarantine: { count: 0 },
  hub: { checkedAt: 1000, reachable: true, epoch: '1', headSeq: '9007199254740993', projectedSeq: '9007199254740993' }, ...overrides,
});

function fixture(fetchImpl: typeof fetch, options: Record<string, unknown> = {}) {
  const db = new Database(':memory:');
  new SessionStore(db);
  const apply = new SyncApply(db, { deviceId: 'viewer-test' });
  const client = new SyncClient(apply, { hubUrl: 'https://hub.test', token: 'private-test-token', userId: 'test', deviceId: 'viewer-test',
    fetchImpl, wsEnabled: false, minPullGapMs: 0, ...options });
  resources.push(() => db.close(), () => client.stop());
  return { db, apply, client };
}

describe('viewer sync evidence', () => {
  it('does not mistake upload health, an open socket or unrelated epochs for convergence', () => {
    expect(composeViewerSyncStatus(upload(), download({ lastError: 'offline' }), 0, 1000).state).toBe('offline');
    expect(composeViewerSyncStatus(upload(), download({ epoch: '2', socketLive: true }), 0, 1000).state).toBe('unknown');
    expect(composeViewerSyncStatus(upload(), download({ lastSuccessAt: null }), 0, 1000).state).toBe('unknown');
    expect(composeViewerSyncStatus(upload(), download(), 0, 61001).state).toBe('stale');
    expect(composeViewerSyncStatus(upload(), download(), 0, 999).state).toBe('stale');
  });

  it('computes uint64 lag without rounding and distinguishes quarantine and historical scope', () => {
    const value = composeViewerSyncStatus(upload({ hub: { checkedAt: 1000, reachable: true, epoch: '1', headSeq: '9007199254740995', projectedSeq: '9007199254740995' } }), download(), 0, 1000);
    expect(value.projection.remaining).toBe('2');
    expect(value.state).toBe('catching-up');
    expect(composeViewerSyncStatus(upload({ pullQuarantine: { count: 2 } }), download(), 0, 1000).state).toBe('partial');
    expect(composeViewerSyncStatus(upload(), download(), 3, 1000).completeness.scope).toBe('local-history-excluded');
    expect(composeViewerSyncStatus(upload(), download(), 0, 1000).state).toBe('current');
    expect(composeViewerSyncStatus(null, null, null, 1000).state).toBe('unconfigured');
  });

  it('explains an observed mutation prerequisite without claiming a stalled upload is current', () => {
    const value = composeViewerSyncStatus(upload({ queue: { blockedMutation: { pendingPrerequisites: 6 } } }), download(), 0, 1000);
    expect(value.state).toBe('catching-up');
    expect(value.message).toBe('Some updates are waiting for earlier changes to upload.');
  });

  it('reports read-only pull state and classifies HTML failures without false authentication pause', async () => {
    for (const status of [401, 403]) {
      const { client, apply } = fixture((async () => new Response('<!--'.padEnd(300, ' ') + '--><html>blocked</html>', { status })) as typeof fetch);
      const before = apply.getCursor();
      await client.pullOnce();
      expect(client.status().authPaused).toBe(false);
      expect(client.status().lastError).toContain('HTML');
      expect(client.status().lastAttemptAt).not.toBeNull();
      const snapshot = client.status();
      expect(client.status()).toEqual(snapshot);
      expect(apply.getCursor()).toBe(before);
    }
    const { client } = fixture((async () => Response.json({ code: 'invalid_token' }, { status: 401 })) as typeof fetch);
    await client.pullOnce();
    expect(client.status().authPaused).toBe(true);
    expect(client.status().lastError).toContain('Reconnect');
  });

  it('wakes a viewed idle replica but does not bypass a failed pull retry deadline', async () => {
    let calls = 0;
    const { client } = fixture((async () => { calls++; return new Response('unavailable', { status: 503 }); }) as typeof fetch,
      { idlePollMs: 10000, backoffInitialMs: 1000, backoffMaxMs: 1000 });
    client.start();
    await Bun.sleep(30);
    expect(calls).toBe(1);
    const retryAt = client.status().nextRetryAt;
    client.setViewerActive(true);
    client.setViewerActive(true);
    await Bun.sleep(30);
    expect(calls).toBe(1);
    expect(client.status().nextRetryAt).toBeGreaterThanOrEqual(client.status().lastAttemptAt! + 1000);
    expect(client.status().nextRetryAt).toBeLessThanOrEqual(retryAt!);
  });

  it('keeps status probes observational even for real auth failures and paused uploads', async () => {
    const { db } = fixture((async () => Response.json({})) as typeof fetch);
    let mode = 'reject';
    const methods: string[] = [];
    const cloud = new CloudSync(db, {
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'private-test-token', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'test',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test', CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'viewer-test', CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'test',
    }, { fetchImpl: (async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      return mode === 'reject' ? Response.json({ code: 'invalid_token' }, { status: 401 })
        : Response.json({ protocol_version: 2, epoch: '1', head_seq: '0', projected_seq: '0' });
    }) as typeof fetch });
    resources.push(() => cloud.stop());
    await cloud.statusWithHubProbe();
    expect(cloud.status().authError).toBeNull();
    expect(cloud.status().health.state).toBe('ok');
    (cloud as any).enterAuthPause({ code: 'invalid_token', status: 401, message: 'paused' });
    const prior = cloud.status();
    const flush = mock(() => Promise.resolve());
    cloud.flush = flush;
    mode = 'accept';
    await cloud.statusWithHubProbe();
    await Bun.sleep(10);
    expect(cloud.status().authError).toEqual(prior.authError);
    expect(flush).not.toHaveBeenCalled();
    expect(methods).toEqual(['GET', 'GET']);
  });

  it('coalesces bounded status probes instead of querying once per heartbeat', async () => {
    let now = 1000;
    let probes = 0;
    const status = { ...upload(), deviceId: 'test', health: { state: 'ok', message: null, consecutiveFailures: 0, failingSinceAt: null } } as any;
    const cloud = { status: () => status, historicalExcludedCount: async () => 0, statusWithHubProbe: async () => { probes++; return status; } };
    const service = new ViewerSyncService({ cloud: () => cloud, pull: () => ({ status: () => download() }), now: () => now });
    resources.push(() => service.close());
    for (let i = 0; i < 10; i++) service.getSnapshot();
    await service.statusWithProbe();
    expect(probes).toBe(1);
    for (let i = 0; i < 10; i++) service.getSnapshot();
    expect(probes).toBe(1);
    now += 30001;
    service.getSnapshot();
    await service.statusWithProbe();
    expect(probes).toBe(2);
  });

  it('orders visibility transitions and bounds per-tab lease state', () => {
    const changed: boolean[] = [];
    const activity = new ViewerActivity(active => changed.push(active));
    resources.push(() => activity.close());
    expect(activity.update('one', true, 1)).toBe(true);
    activity.update('one', false, 3);
    activity.update('one', true, 2);
    expect(changed).toEqual([true, false]);
    for (let i = 0; i < 255; i++) expect(activity.update(`tab${i}`, false, 0)).toBe(true);
    expect(activity.update('overflow', true, 1)).toBe(false);
  });
  it('requires completed catch-up but does not expire a quiet realtime replica with a fresh matching hub check', () => {
    expect(composeViewerSyncStatus(upload(), download({ caughtUp: false }), 0, 1000).state).toBe('catching-up');
    const fresh = upload({ hub: { checkedAt: 200000, reachable: true, epoch: '1', headSeq: '9007199254740993', projectedSeq: '9007199254740993' } });
    expect(composeViewerSyncStatus(fresh, download({ mode: 'realtime', socketLive: true }), 0, 200000).state).toBe('current');
  });

  it('wakes the existing idle timer promptly and polls actively only while viewed', async () => {
    let calls = 0;
    const { client } = fixture((async () => { calls++; return Response.json({ protocol_version: 2, epoch: '1', ops: [], head_seq: '0', more: false }); }) as typeof fetch,
      { idlePollMs: 10000, activePollMs: 20 });
    client.start();
    await Bun.sleep(30);
    const before = calls;
    client.setViewerActive(true);
    await Bun.sleep(70);
    expect(calls).toBeGreaterThan(before + 1);
    client.setViewerActive(false);
    const stopped = calls;
    await Bun.sleep(50);
    expect(calls).toBe(stopped);
  });

  it('expires visible leases without another request and does not let an old renewal undo hiding', async () => {
    const changes: boolean[] = [];
    const activity = new ViewerActivity(value => changes.push(value), Date.now, 20);
    resources.push(() => activity.close());
    activity.update('a', true, 1);
    await Bun.sleep(50);
    expect(changes).toEqual([true, false]);
    activity.update('a', true, 3);
    activity.update('a', false, 5);
    activity.update('a', true, 4);
    expect(changes).toEqual([true, false, true, false]);
  });

  it('keeps HTTP available on HTML grant rejection while genuine grant credentials pause it', async () => {
    for (const html of [true, false]) {
      let pulls = 0;
      const { client } = fixture((async input => {
        if (String(input).endsWith('/realtime-token')) return new Response(html ? '<html>blocked</html>' : '{"code":"invalid_token"}', { status: 403 });
        pulls++;
        return Response.json({ protocol_version: 2, epoch: '1', ops: [], head_seq: '0', more: false });
      }) as typeof fetch, { wsEnabled: true, webSocketImpl: class {} as any, wsBackoffBaseMs: 10000, wsBackoffMaxMs: 10000, random: () => 1 });
      client.start();
      await Bun.sleep(30);
      expect(client.status().authPaused).toBe(!html);
      if (html) expect(pulls).toBeGreaterThan(0);
      else expect(pulls).toBe(0);
      client.stop();
    }
  });

  it('observes new local pending work without another network probe', async () => {
    let pending = 0;
    let probes = 0;
    const status = () => ({ ...upload({ pending: { observations: pending } }), deviceId: 'test', health: { state: 'ok', message: null, consecutiveFailures: 0, failingSinceAt: null } } as any);
    const cloud = { status, historicalExcludedCount: async () => 0, statusWithHubProbe: async () => { probes++; return status(); } };
    const service = new ViewerSyncService({ cloud: () => cloud, pull: () => ({ status: () => download() }), now: () => 1000 });
    resources.push(() => service.close());
    await service.statusWithProbe();
    pending = 2;
    const { emitContextInvalidation } = await import('../../../src/shared/context-invalidation.js');
    emitContextInvalidation('all', 'storeObservation');
    expect(service.getSnapshot().state).toBe('catching-up');
    expect(service.getSnapshot().upload.pending).toBe(2);
    expect(probes).toBe(1);
  });

  it('counts only current native revisions in the cached historical exclusion scope off-thread', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sync-scope-'));
    resources.push(() => rmSync(directory, { recursive: true, force: true }));
    const db = new Database(join(directory, 'source.db'));
    resources.push(() => db.close());
    const store = new SessionStore(db);
    const id = store.appendWorkStateEntry({ project: 'test', listName: 'work', fields: { task: 'old' } });
    const row = db.prepare('SELECT CAST(sync_rev AS TEXT) AS rev FROM work_state_entries WHERE id = ?').get(id) as { rev: string };
    db.prepare('INSERT INTO sync_launch_exclusions(kind, origin_local_id, through_rev) VALUES(?,?,?)').run('work_state', String(id), row.rev);
    const cloud = new CloudSync(db, { CLAUDE_MEM_CLOUD_SYNC_TOKEN: 't', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'u', CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test', CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'viewer-test', CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'test' });
    resources.push(() => cloud.stop());
    expect(await cloud.historicalExcludedCount(1000)).toBe(1);
    db.prepare('UPDATE work_state_entries SET sync_rev = ? WHERE id = ?').run('2', id);
    expect(await cloud.historicalExcludedCount(2000)).toBe(1);
    expect(await cloud.historicalExcludedCount(301001)).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM sync_launch_exclusions').get() as { n: number }).n).toBe(1);
  });

  it('default activity expiry is unaffected by a backwards wall clock jump', async () => {
    const changes: boolean[] = [];
    const activity = new ViewerActivity(value => changes.push(value), undefined, 20);
    resources.push(() => activity.close());
    activity.update('tab', true, 1);
    const clock = spyOn(Date, 'now').mockReturnValue(0);
    try { await Bun.sleep(50); } finally { clock.mockRestore(); }
    expect(changes).toEqual([true, false]);
  });

  it('resumes a paused download after an accepted push even when its head does not advance', async () => {
    let allowed = false;
    const { client } = fixture((async () => allowed
      ? Response.json({ protocol_version: 2, epoch: '1', ops: [], head_seq: '0', more: false })
      : Response.json({ code: 'invalid_token' }, { status: 401 })) as typeof fetch);
    client.start();
    await Bun.sleep(30);
    expect(client.status().authPaused).toBe(true);
    allowed = true;
    client.onHeadSeq('0');
    await Bun.sleep(30);
    expect(client.status().authPaused).toBe(false);
    expect(client.status().lastError).toBeNull();
    expect(client.status().lastSuccessAt).not.toBeNull();
  });

  it('returns coherent legacy and nested pending counts when a commit arrives around a stalled probe', async () => {
    const { emitContextInvalidation } = await import('../../../src/shared/context-invalidation.js');
    let pending = 0;
    let release!: (value: any) => void;
    let committed = false;
    const status = () => ({ ...upload({ pending: { observations: pending } }), deviceId: 'test', health: { state: 'ok', message: null, consecutiveFailures: 0, failingSinceAt: null } } as any);
    const beforeCommit = status();
    const cloud = { status, historicalExcludedCount: async () => 0, statusWithHubProbe: () => new Promise<any>(resolve => { release = resolve; }) };
    const service = new ViewerSyncService({ cloud: () => cloud, pull: () => ({ status: () => download() }), now: () => 1000,
      onChange: () => {
        // A completed probe notification can race a local commit before its
        // waiting HTTP status consumer assembles the response.
        if (committed) return;
        committed = true;
        pending = 3;
        emitContextInvalidation('all', 'storeObservation');
      },
    });
    resources.push(() => service.close());
    const response = service.statusWithProbe();
    pending = 2;
    emitContextInvalidation('all', 'storeObservation');
    release(beforeCommit);
    const result = await response;
    expect(result.configured).toBe(true);
    if (!('sync' in result)) throw new Error('Expected configured sync response');
    expect(result.pending.observations).toBe(3);
    expect(result.sync.upload.pending).toBe(3);
    expect(result.sync.state).toBe('catching-up');
  });

  it('keeps local pending work after its invalidation was consumed during an older hub probe', async () => {
    const { emitContextInvalidation } = await import('../../../src/shared/context-invalidation.js');
    let pending = 0;
    let release!: (value: any) => void;
    const status = () => ({ ...upload({ pending: { observations: pending } }), deviceId: 'test', health: { state: 'ok', message: null, consecutiveFailures: 0, failingSinceAt: null } } as any);
    const beforeCommit = status();
    const cloud = { status, historicalExcludedCount: async () => 0, statusWithHubProbe: () => new Promise<any>(resolve => { release = resolve; }) };
    const service = new ViewerSyncService({ cloud: () => cloud, pull: () => ({ status: () => download() }), now: () => 1000 });
    resources.push(() => service.close());
    const response = service.statusWithProbe();
    pending = 2;
    emitContextInvalidation('all', 'storeObservation');
    const during = service.getSnapshot(); // Consumes the dirty flag before the old network response settles.
    expect(during.upload.pending).toBe(2);
    expect(during.state).toBe('catching-up');
    release(beforeCommit);
    const result = await response;
    if (!('sync' in result)) throw new Error('Expected configured sync response');
    expect(result.pending.observations).toBe(2);
    expect(result.sync.upload.pending).toBe(2);
    expect(service.getSnapshot().state).toBe('catching-up');
  });

  it('gives sessionless keep-pulling replicas the active HTTP cadence', async () => {
    expect(keepPullingOptions(false)).toEqual({});
    expect(keepPullingOptions(true)).toEqual({ idlePollMs: 30_000, suspendAfterMs: Infinity });
    let calls = 0;
    const { client } = fixture((async () => { calls++; return Response.json({ protocol_version: 2, epoch: '1', ops: [], head_seq: '0', more: false }); }) as typeof fetch,
      { ...keepPullingOptions(true), idlePollMs: 20, isSessionActive: () => false });
    client.start();
    await Bun.sleep(85);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(client.status().suspended).toBe(false);
  });

});
