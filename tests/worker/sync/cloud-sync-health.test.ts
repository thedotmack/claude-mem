// Cloud sync failure handling (2026-09-26 live sweep):
//  - 401/403 pauses the flush loop with a clear status instead of retrying forever
//  - failures are recorded in the sync-health ledger that the SessionStart banner reads
//  - #4086: an op the server rejects by name is quarantined after N rejections
//    and the rest of the queue keeps draining

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import {
  CloudSync,
  HubHttpError,
  identifyRejectedOp,
  POISON_OP_REJECTION_THRESHOLD,
  type CloudSyncOptions,
} from '../../../src/services/sync/CloudSync.js';
import {
  classifySyncAuthFailure,
  friendlySyncError,
  readSyncHealth,
  renderSyncHealthWarning,
  shouldWarnSyncHealth,
  SYNC_FAILING_WARN_AFTER_MS,
  type SyncHealthState,
} from '../../../src/shared/sync-health.js';

const ISO = '2026-09-26T00:00:00.000Z';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function ackAll(body: string, startSeq: number): { response: Response; seq: number } {
  let seq = startSeq;
  const ops: Array<{ body: string; operation_sha256: string }> = body ? JSON.parse(body).ops ?? [] : [];
  const acked = ops.map((op) => {
    const envelope = JSON.parse(op.body);
    return {
      id: envelope.id,
      kind: envelope.kind,
      origin_local_id: envelope.origin_local_id,
      entity_rev: envelope.entity_rev,
      operation_sha256: op.operation_sha256,
      seq: String(++seq),
    };
  });
  return {
    response: new Response(JSON.stringify({ acked, head_seq: String(seq), projected_seq: String(seq) })),
    seq,
  };
}

describe('sync-health helpers', () => {
  it('classifies 401/403 bodies into invalid_token vs subscription_inactive', () => {
    expect(classifySyncAuthFailure(500, '{}')).toBeNull();
    expect(classifySyncAuthFailure(429, '')).toBeNull();
    expect(classifySyncAuthFailure(401, '{"error":"invalid token"}')?.code).toBe('invalid_token');
    expect(classifySyncAuthFailure(403, '{"code":"subscription_inactive","status":"past_due"}')?.code)
      .toBe('subscription_inactive');
    expect(classifySyncAuthFailure(401, '{"error":"Subscription not active"}')?.code).toBe('subscription_inactive');
    expect(classifySyncAuthFailure(403, 'not json')?.code).toBe('invalid_token');
    expect(classifySyncAuthFailure(403, '{"code":"subscription_inactive"}')?.message).toContain('cmem.ai/pro');
  });

  it('replaces HTML error pages with a short description and scrubs tokens', () => {
    const msg = friendlySyncError('sync hub push 429: <!DOCTYPE html><html><body>error 1027</body></html>');
    expect(msg).toBe('sync hub push 429: (the sync server returned an HTML error page)');
    expect(friendlySyncError('Bearer cm_pro_abcdefghijklmnop failed')).not.toContain('abcdefghijklmnop');
  });

  it('warns immediately for auth pauses and only after a sustained streak for failures', () => {
    const now = 1_000_000_000;
    const base: SyncHealthState = {
      state: 'failing', code: '500', message: 'sync hub push 500: internal error',
      consecutiveFailures: 1, failingSinceAt: now - 60_000, lastErrorAt: now, lastSuccessAt: null, updatedAt: now,
    };
    expect(shouldWarnSyncHealth(base, now)).toBe(false);
    expect(renderSyncHealthWarning(base, now)).toBe('');
    const sustained = { ...base, failingSinceAt: now - SYNC_FAILING_WARN_AFTER_MS };
    expect(renderSyncHealthWarning(sustained, now)).toContain('Cloud sync has been failing for 15 minutes');
    const paused: SyncHealthState = { ...base, state: 'auth_paused', code: 'subscription_inactive', consecutiveFailures: 0 };
    expect(renderSyncHealthWarning(paused, now)).toContain('trial or subscription is not active');
    expect(renderSyncHealthWarning({ ...base, state: 'ok' }, now)).toBe('');
    expect(renderSyncHealthWarning(null, now)).toBe('');
  });

  it('identifies the single op a 400 invalid_ops rejection names', () => {
    const ops = [
      { body: JSON.stringify({ id: 'observation:aaa', entity_rev: '1' }), operation_sha256: 'a' },
      { body: JSON.stringify({ id: 'observation:bbb', entity_rev: '2' }), operation_sha256: 'b' },
    ];
    expect(identifyRejectedOp('{"error":"invalid_ops: revision_hash_conflict:observation:bbb:2"}', ops)).toBe(1);
    expect(identifyRejectedOp('{"error":"invalid_ops: stale_revision:observation:aaa:1<3"}', ops)).toBe(0);
    expect(identifyRejectedOp('{"error":"invalid_ops: ops[1] body must be canonical JSON"}', ops)).toBe(1);
    expect(identifyRejectedOp('{"error":"invalid_ops: ops[7] nope"}', ops)).toBeNull();
    expect(identifyRejectedOp('{"error":"invalid_ops: deviceId must be non-empty"}', ops)).toBeNull();
    expect(identifyRejectedOp('{"error":"request body requires protocol_version: 2"}', ops)).toBeNull();
  });
});

describe('CloudSync failure handling', () => {
  let tempDir: string;
  let db: Database;
  let healthPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-sync-health-'));
    healthPath = join(tempDir, 'sync-health.json');
    db = new Database(':memory:');
    new SessionStore(db);
    db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('sess-abc', 'mem-1', 'proj-x', ?, 1758844800000, 'active')
    `).run(ISO);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeSync(fetchImpl: typeof fetch, options: Partial<CloudSyncOptions> = {}): CloudSync {
    return new CloudSync(db, {
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'test-token-1234',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user-42',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'device-fixture',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'test-host',
    }, {
      fetchImpl,
      settingsPath: join(tempDir, 'settings.json'),
      debounceMs: 10,
      backoffInitialMs: 20,
      backoffMaxMs: 200,
      healthFilePath: healthPath,
      ...options,
    });
  }

  function seedObservation(title: string): void {
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, subtitle, facts, narrative,
        concepts, files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES ('mem-1', 'proj-x', 'discovery', ?, 'Sub', '[]', 'N', '[]', '[]', '[]', 1, 0, ?, 1758844800000)
    `).run(title, ISO);
  }

  function pendingObservations(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM observations WHERE synced_at IS NULL').get() as { n: number }).n;
  }

  it('stops retrying on 401, reports a clear auth status, and resumes when the server accepts again', async () => {
    let mode: 'reject' | 'accept' = 'reject';
    let seq = 0;
    const calls: string[] = [];
    const impl = (async (input: any, init?: any) => {
      const url = String(input);
      calls.push(url);
      if (mode === 'reject') {
        return new Response(JSON.stringify({ code: 'subscription_inactive', error: 'subscription inactive' }), { status: 403 });
      }
      if (url.endsWith('/v1/sync/status')) {
        return Response.json({ protocol_version: 2, epoch: '1', head_seq: String(seq), projected_seq: String(seq) });
      }
      const result = ackAll(String(init?.body ?? ''), seq);
      seq = result.seq;
      return result.response;
    }) as typeof fetch;
    const sync = makeSync(impl, { authRetryMs: 150 });
    seedObservation('one');

    await sync.flush();
    const pausedStatus = sync.status();
    expect(pausedStatus.authError?.code).toBe('subscription_inactive');
    expect(pausedStatus.health.state).toBe('auth_paused');
    expect(pausedStatus.lastError).toContain('cmem.ai/pro');
    expect(readSyncHealth(healthPath)?.state).toBe('auth_paused');
    expect(readSyncHealth(healthPath)?.code).toBe('subscription_inactive');

    // Write-site nudges during the pause must not hit the server.
    const afterFirst = calls.length;
    sync.notify();
    sync.notify();
    await sleep(60);
    expect(calls.length).toBe(afterFirst);

    // The server accepts again (plan renewed): the hourly re-check (150ms
    // here) probes status, resumes, and drains the queue.
    mode = 'accept';
    await sleep(400);
    expect(sync.status().authError).toBeNull();
    expect(pendingObservations()).toBe(0);
    expect(readSyncHealth(healthPath)?.state).toBe('ok');
    sync.stop();
  });

  it('marks invalid_token for a bare 401 "invalid token" from older servers', async () => {
    const impl = (async () => new Response('{"error":"invalid token"}', { status: 401 })) as typeof fetch;
    const sync = makeSync(impl);
    seedObservation('one');
    await sync.flush();
    expect(sync.status().authError?.code).toBe('invalid_token');
    expect(sync.status().authError?.message).toContain('Reconnect at https://cmem.ai');
    sync.stop();
  });

  it('records a failure streak in the ledger and clears it on success', async () => {
    let fail = true;
    let seq = 0;
    const impl = (async (_input: any, init?: any) => {
      if (fail) return new Response('<!DOCTYPE html><html>1027</html>', { status: 500 });
      const result = ackAll(String(init?.body ?? ''), seq);
      seq = result.seq;
      return result.response;
    }) as typeof fetch;
    const sync = makeSync(impl, { backoffInitialMs: 10_000 });
    seedObservation('one');
    await sync.flush();
    const status = sync.status();
    expect(status.health.state).toBe('failing');
    expect(status.health.consecutiveFailures).toBe(1);
    expect(status.lastError).toBe('sync hub push 500: (the sync server returned an HTML error page)');
    const ledger = readSyncHealth(healthPath);
    expect(ledger?.state).toBe('failing');
    expect(ledger?.failingSinceAt).toBeNumber();

    fail = false;
    await sync.flush();
    expect(sync.status().health.state).toBe('ok');
    expect(readSyncHealth(healthPath)?.state).toBe('ok');
    sync.stop();
  });

  it('quarantines a poison op after repeated named rejections and drains the rest (#4086)', async () => {
    seedObservation('poison');
    seedObservation('healthy');
    const poisonId = (db.prepare("SELECT id FROM observations WHERE title = 'poison'").get() as { id: number }).id;
    let seq = 0;
    let rejections = 0;
    const impl = (async (_input: any, init?: any) => {
      const body = String(init?.body ?? '');
      const ops: Array<{ body: string }> = JSON.parse(body).ops;
      const poison = ops.map(op => JSON.parse(op.body)).find(env => env.origin_local_id === String(poisonId));
      if (poison) {
        rejections++;
        return new Response(JSON.stringify({
          error: `invalid_ops: revision_hash_conflict:${poison.id}:${poison.entity_rev}`,
        }), { status: 400 });
      }
      const result = ackAll(body, seq);
      seq = result.seq;
      return result.response;
    }) as typeof fetch;
    const sync = makeSync(impl, { backoffInitialMs: 10_000 });

    for (let i = 1; i < POISON_OP_REJECTION_THRESHOLD; i++) {
      await sync.flush();
      expect(pendingObservations()).toBe(2); // below the threshold: normal backoff, nothing dropped
      expect(sync.status().quarantine.count).toBe(0);
    }
    await sync.flush();
    expect(rejections).toBe(POISON_OP_REJECTION_THRESHOLD);
    const status = sync.status();
    expect(status.quarantine.count).toBe(1);
    expect(status.quarantine.latestReason).toContain('revision_hash_conflict');
    expect(status.lastError).toBeNull();
    expect(pendingObservations()).toBe(0);
    const poisonRow = db.prepare('SELECT synced_at FROM observations WHERE id = ?').get(poisonId) as { synced_at: number };
    expect(poisonRow.synced_at).toBe(-1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM sync_content_outbox').get() as { n: number }).n).toBe(0);
    sync.stop();
  });

  it('does not quarantine anything for a batch-level 400', async () => {
    seedObservation('one');
    const impl = (async () => new Response('{"error":"request body requires protocol_version: 2"}', { status: 400 })) as typeof fetch;
    const sync = makeSync(impl, { backoffInitialMs: 10_000 });
    for (let i = 0; i < POISON_OP_REJECTION_THRESHOLD + 1; i++) await sync.flush();
    expect(sync.status().quarantine.count).toBe(0);
    expect(pendingObservations()).toBe(1);
    sync.stop();
  });

  it('HubHttpError carries the auth classification from the untruncated body', () => {
    const long = JSON.stringify({ error: 'x'.repeat(300), code: 'subscription_inactive' });
    const err = new HubHttpError('sync hub push', 403, long.slice(0, 200), null, long);
    expect(err.authFailure?.code).toBe('subscription_inactive');
  });
});
