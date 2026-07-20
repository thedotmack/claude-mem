// Phase 3 verification (plan 2026-07-17): the SyncClient pull loop.
// Fetch-mocked against a scripted in-memory hub log: pull→apply wiring,
// pagination, epoch reset, the push-piggyback head_seq trigger, the
// pullOnce() timeout bound, cadence tiers (forced via small config
// injection), suspension + resume, and failure isolation. Harness style
// copied from cloud-sync.test.ts (in-temp-dir SessionStore over :memory:).

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { SyncClient, type SyncClientOptions } from '../../../src/services/sync/SyncClient.js';
import { observationChange, type TestHubChange } from './content-v2-helpers.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const SELF = 'device-fixture';
const REMOTE = 'device-a';
type HubOp = TestHubChange;

/**
 * Scripted hub: serves GET /v1/sync/changes from a mutable log with a
 * mutable epoch, recording every request. Mirrors the real wire shape
 * ({epoch, ops, head_seq, more}) including the `more` computation.
 */
function makeHub(initial: { epoch: string; ops?: HubOp[] }) {
  const state = {
    epoch: initial.epoch,
    ops: initial.ops ?? [],
    requests: [] as Array<{ since: number; limit: number; headers: Record<string, string> }>,
    failNext: 0,
    hang: false,
  };
  const impl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const since = Number(url.searchParams.get('since') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '500');
    state.requests.push({ since, limit, headers: { ...(init?.headers ?? {}) } });
    if (state.hang) {
      // Honor the abort signal like real fetch — the hang ends only on abort.
      return new Promise<Response>((_, reject) => {
        const signal: AbortSignal | undefined = init?.signal;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    if (state.failNext > 0) {
      state.failNext--;
      throw new Error('connect ECONNREFUSED');
    }
    const matching = state.ops
      .filter(op => Number(op.seq) > since)
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    const page = matching.slice(0, limit);
    const head = state.ops.reduce((m, op) => Math.max(m, Number(op.seq)), 0);
    const lastSeq = page.length > 0 ? Number(page[page.length - 1].seq) : since;
    return new Response(JSON.stringify({
      protocol_version: 2,
      epoch: state.epoch,
      ops: page,
      head_seq: String(head),
      more: page.length === limit && lastSeq < head,
    }), { status: 200 });
  }) as typeof fetch;
  return { state, impl };
}

describe('SyncClient', () => {
  let tempDir: string;
  let db: Database;
  let apply: SyncApply;
  let clients: SyncClient[];

  function makeClient(fetchImpl: typeof fetch, options: Partial<SyncClientOptions> = {}): SyncClient {
    const client = new SyncClient(apply, {
      hubUrl: 'https://hub.test',
      token: 'test-token-1234',
      userId: 'user-42',
      deviceId: SELF,
      deviceName: 'test laptop',
      fetchImpl,
      // This suite covers the HTTP lanes exactly as they behave with the
      // advisory socket absent (prime directive #2: deleting the socket path
      // leaves Phase 3 intact). Socket coverage: sync-client-ws.test.ts.
      wsEnabled: false,
      // Poll fast in tests unless a test overrides a tier.
      activePollMs: 20,
      idlePollMs: 10_000,
      suspendAfterMs: 3_600_000,
      backoffInitialMs: 10,
      backoffMaxMs: 40,
      minPullGapMs: 0,
      ...options,
    });
    clients.push(client);
    return client;
  }

  function hubOp(seq: number, originId: string): HubOp {
    return observationChange(seq, originId, REMOTE);
  }

  function count(table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-sync-client-'));
    db = new Database(':memory:');
    new SessionStore(db);
    apply = new SyncApply(db, { deviceId: SELF });
    clients = [];
  });

  afterEach(() => {
    for (const client of clients) client.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('pulls a page, applies it through SyncApply, and advances the cursor (auth headers included)', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [hubOp(1, '11'), hubOp(2, '12')] });
    const client = makeClient(impl);

    await client.pullOnce({ timeoutMs: 5_000 });

    expect(count('observations')).toBe(2);
    expect(apply.getCursor()).toBe('2');
    expect(apply.getEpoch()).toBe('1');
    expect(state.requests.length).toBe(1);
    expect(state.requests[0].since).toBe(0);
    expect(state.requests[0].headers['Authorization']).toBe('Bearer test-token-1234');
    expect(state.requests[0].headers['X-User-Id']).toBe('user-42');
    expect(state.requests[0].headers['X-Device-Id']).toBe(SELF);
    expect(state.requests[0].headers['X-Device-Name']).toBe('test laptop');
  });

  it('loops while more=true, presenting the advanced cursor each page', async () => {
    const ops: HubOp[] = [];
    for (let i = 1; i <= 5; i++) ops.push(hubOp(i, String(10 + i)));
    const { state, impl } = makeHub({ epoch: '1', ops });
    const client = makeClient(impl, { pageLimit: 2 });

    await client.pullOnce({ timeoutMs: 5_000 });

    // 2 + 2 + 1: the third page is the final partial one (more=false).
    expect(state.requests.map(r => r.since)).toEqual([0, 2, 4]);
    expect(count('observations')).toBe(5);
    expect(apply.getCursor()).toBe('5');
  });

  it('handles an epoch reset by re-pulling from 0 in the same cycle', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [hubOp(1, '11')] });
    const client = makeClient(impl);

    await client.pullOnce({ timeoutMs: 5_000 });
    expect(apply.getCursor()).toBe('1');

    // The hub is rebuilt: new epoch, re-logged history plus a new op.
    state.epoch = '2';
    state.ops = [
      hubOp(1, '11'),
      hubOp(2, '12'),
    ];

    await client.pullOnce({ timeoutMs: 5_000 });

    // First request presented the stale cursor, saw the epoch change (batch
    // discarded, cursor reset), then re-pulled from 0 in the same cycle.
    const sinces = state.requests.map(r => r.since);
    expect(sinces).toEqual([0, 1, 0]);
    expect(apply.getEpoch()).toBe('2');
    expect(apply.getCursor()).toBe('2');
    // Re-applying op 11 was an idempotent skip; op 12 landed.
    expect(count('observations')).toBe(2);
  });

  it('onHeadSeq triggers an immediate pull when head_seq is beyond the cursor', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [] });
    // Idle cadence so only the piggyback can plausibly trigger the 2nd pull.
    const client = makeClient(impl, { activePollMs: 60_000, idlePollMs: 60_000 });
    client.start();
    await sleep(50); // the start() catch-up pull
    const baseline = state.requests.length;
    expect(baseline).toBeGreaterThanOrEqual(1);

    state.ops = [hubOp(1, '11')];
    client.onHeadSeq('1'); // push response piggyback: head beyond cursor
    await sleep(50);

    expect(state.requests.length).toBeGreaterThan(baseline);
    expect(count('observations')).toBe(1);
    expect(apply.getCursor()).toBe('1');
  });

  it('onHeadSeq is a no-op when head_seq is not beyond the cursor', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [hubOp(1, '11')] });
    const client = makeClient(impl, { activePollMs: 60_000, idlePollMs: 60_000 });
    client.start();
    await sleep(50);
    const baseline = state.requests.length;

    client.onHeadSeq('1'); // cursor is already 1
    await sleep(50);
    expect(state.requests.length).toBe(baseline);
  });

  it('pullOnce is hard-bounded by timeoutMs even against a hanging network', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [] });
    state.hang = true;
    const client = makeClient(impl);

    const startedAt = Date.now();
    await client.pullOnce({ timeoutMs: 100 });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(1_000); // 100ms bound + scheduling slack
    expect(apply.getCursor()).toBe('0');   // nothing applied, nothing corrupted
  });

  it('swallows failures (pull never throws, cursor unmoved) and recovers on the next pull', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [hubOp(1, '11')] });
    state.failNext = 1;
    const client = makeClient(impl);

    await client.pullOnce({ timeoutMs: 5_000 }); // fails internally, resolves
    expect(apply.getCursor()).toBe('0');
    expect(count('observations')).toBe(0);

    await client.pullOnce({ timeoutMs: 5_000 });
    expect(apply.getCursor()).toBe('1');
    expect(count('observations')).toBe(1);
  });

  it('a malformed page fails the batch without moving the cursor, then applies once fixed', async () => {
    const bad = hubOp(1, '11');
    bad.body = 'not json{';
    const { state, impl } = makeHub({ epoch: '1', ops: [bad] });
    const client = makeClient(impl);

    await client.pullOnce({ timeoutMs: 5_000 });
    expect(apply.getCursor()).toBe('0'); // applyOps threw, batch rolled back

    state.ops = [hubOp(1, '11')];
    await client.pullOnce({ timeoutMs: 5_000 });
    expect(apply.getCursor()).toBe('1');
    expect(count('observations')).toBe(1);
  });

  it('rejects HTTP pages that do not start at cursor+1 or contain an internal sequence gap', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [hubOp(2, '12')] });
    const client = makeClient(impl);
    await client.pullOnce({ timeoutMs: 5_000 });
    expect(apply.getCursor()).toBe('0');
    expect(count('observations')).toBe(0);

    state.ops = [hubOp(1, '11'), hubOp(3, '13')];
    await client.pullOnce({ timeoutMs: 5_000 });
    expect(apply.getCursor()).toBe('0');
    expect(count('observations')).toBe(0); // seq 1 insert rolled back with the gap

    state.ops = [hubOp(1, '11'), hubOp(2, '12'), hubOp(3, '13')];
    await client.pullOnce({ timeoutMs: 5_000 });
    expect(apply.getCursor()).toBe('3');
    expect(count('observations')).toBe(3);
  });

  it('preserves a uint64 HTTP since/head/seq value without Number rounding', async () => {
    db.prepare("INSERT INTO sync_state (k, v) VALUES ('cursor', '9007199254740992')").run();
    const change = hubOp(1, '18446744073709551615');
    change.seq = '9007199254740993';
    const requests: string[] = [];
    const impl = (async (input: any) => {
      const url = new URL(String(input));
      requests.push(url.searchParams.get('since')!);
      return new Response(JSON.stringify({
        protocol_version: 2,
        epoch: '1',
        ops: [change],
        head_seq: '9007199254740993',
        more: false,
      }), { status: 200 });
    }) as typeof fetch;
    await makeClient(impl).pullOnce({ timeoutMs: 5_000 });

    expect(requests).toEqual(['9007199254740992']);
    expect(apply.getCursor()).toBe('9007199254740993');
    expect(db.prepare('SELECT origin_local_id FROM observations').get())
      .toEqual({ origin_local_id: '18446744073709551615' });
  });

  describe('cadence tiers (config-injected intervals)', () => {
    it('polls on the active tier while a session is active', async () => {
      const { state, impl } = makeHub({ epoch: '1', ops: [] });
      const client = makeClient(impl, {
        activePollMs: 20,
        idlePollMs: 60_000,
        isSessionActive: () => true,
      });
      client.start();
      await sleep(150);

      // Catch-up pull + several 20ms-tier polls; the 60s idle tier alone
      // could have produced only the catch-up pull.
      expect(state.requests.length).toBeGreaterThanOrEqual(3);
    });

    it('drops to the idle tier when no session is active', async () => {
      const { state, impl } = makeHub({ epoch: '1', ops: [] });
      const client = makeClient(impl, {
        activePollMs: 20,
        idlePollMs: 60_000,
        isSessionActive: () => false,
      });
      client.start();
      await sleep(150);

      // Only the start() catch-up pull — the next poll is 60s out.
      expect(state.requests.length).toBe(1);
    });

    it('suspends entirely after the no-session window, and pullOnce resumes the loop', async () => {
      const { state, impl } = makeHub({ epoch: '1', ops: [] });
      let now = 1_000_000;
      const client = makeClient(impl, {
        activePollMs: 10,
        idlePollMs: 10,
        suspendAfterMs: 5_000,
        isSessionActive: () => false,
        now: () => now,
      });
      client.start();
      await sleep(50); // catch-up pull, then 10ms idle polls (clock frozen)
      const beforeSuspend = state.requests.length;
      expect(beforeSuspend).toBeGreaterThanOrEqual(1);

      now += 10_000; // an hour-equivalent passes with no sessions
      await sleep(100); // next tick sees the idle window exceeded → suspends
      const suspendedAt = state.requests.length;
      await sleep(100);
      expect(state.requests.length).toBe(suspendedAt); // no timer at all

      // Session start: pullOnce pulls immediately AND re-arms the loop.
      await client.pullOnce({ timeoutMs: 5_000 });
      expect(state.requests.length).toBeGreaterThan(suspendedAt);
      await sleep(100); // resumed 10ms cadence is ticking again
      expect(state.requests.length).toBeGreaterThan(suspendedAt + 1);
    });

    it('onHeadSeq also resumes a suspended loop', async () => {
      const { state, impl } = makeHub({ epoch: '1', ops: [] });
      let now = 1_000_000;
      const client = makeClient(impl, {
        activePollMs: 10,
        idlePollMs: 10,
        suspendAfterMs: 5_000,
        isSessionActive: () => false,
        now: () => now,
      });
      client.start();
      await sleep(50);
      now += 10_000;
      await sleep(100); // suspended
      const suspendedAt = state.requests.length;
      await sleep(50);
      expect(state.requests.length).toBe(suspendedAt);

      state.ops = [hubOp(1, '11')];
      client.onHeadSeq('1');
      await sleep(50);
      expect(state.requests.length).toBeGreaterThan(suspendedAt);
      expect(count('observations')).toBe(1);
    });
  });

  it('stop() halts the loop and makes pullOnce/onHeadSeq inert', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [hubOp(1, '11')] });
    const client = makeClient(impl, { isSessionActive: () => true, activePollMs: 10 });
    client.start();
    await sleep(30);
    client.stop();
    const atStop = state.requests.length;

    client.onHeadSeq('99');
    await client.pullOnce({ timeoutMs: 1_000 });
    await sleep(60);
    expect(state.requests.length).toBe(atStop);
  });

  it('fails closed on construction without a device id or hub URL', () => {
    const { impl } = makeHub({ epoch: '1' });
    expect(() => makeClient(impl, { deviceId: '' })).toThrow(/deviceId/);
    expect(() => makeClient(impl, { hubUrl: '' })).toThrow(/hubUrl/);
  });
});
