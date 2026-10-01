// Phase 4 verification (plan 2026-07-17): SyncClient's advisory WebSocket.
// The socket is mocked via the injected constructor (the fetchImpl idiom);
// the HTTP hub is the same scripted fetch mock the Phase 3 suite uses.
//
// Covered protocol behavior:
//   - gate: connects only when enabled, with the exact auth header trio
//   - contiguous {type:'op'} frames apply through SyncApply (cursor advances
//     transactionally; NO extra HTTP request)
//   - overlap tolerated, fully-stale frames ignored (pull/fan-out race)
//   - gap / parse anomaly / unknown type / epoch mismatch → self-heal: close
//     the socket + one forced HTTP pullOnce
//   - {type:'advance'} → HTTP pull (no-op when at/below the cursor)
//   - reconnect backoff bounds (full jitter, base·2^n capped)
//   - poll cadence stretches to the idle tier while connected; restores on
//     disconnect
//   - onSocketLiveChange (the CloudSync fast-debounce coupling) flips
//   - keepalive pings on the configured cadence; stop() tears everything down
//   - kill-switch poll mode (plan Phase 5 task 2): X-Sync-Mode: poll on a
//     pull (or via onSyncModeHint from CloudSync's push surface) closes the
//     socket + suppresses reconnects while HTTP polling continues; the
//     header disappearing resumes the socket

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import {
  SyncClient,
  type SyncClientOptions,
  type SyncSocketLike,
  type SyncWebSocketConstructor,
} from '../../../src/services/sync/SyncClient.js';
import { observationChange, type TestHubChange } from './content-v2-helpers.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const SELF = 'device-fixture';
const REMOTE = 'device-a';
type HubOp = TestHubChange;

/** Scripted HTTP hub (same wire shape as the Phase 3 suite). */
function makeHub(initial: { epoch: string; ops?: HubOp[] }) {
  const state = {
    epoch: initial.epoch,
    ops: initial.ops ?? [],
    requests: [] as Array<{ since: number; limit: number }>,
    /** Kill switch: when set, every response carries X-Sync-Mode (Phase 5). */
    mode: null as string | null,
    /** When set, every response is this error status (header rules still apply). */
    failStatus: null as number | null,
  };
  const impl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const since = Number(url.searchParams.get('since') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '500');
    state.requests.push({ since, limit });
    if (state.failStatus !== null) {
      const headers: Record<string, string> = {};
      if (state.mode !== null) headers['X-Sync-Mode'] = state.mode;
      return new Response('hub error', { status: state.failStatus, headers });
    }
    const matching = state.ops
      .filter(op => Number(op.seq) > since)
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    const page = matching.slice(0, limit);
    const head = state.ops.reduce((m, op) => Math.max(m, Number(op.seq)), 0);
    const lastSeq = page.length > 0 ? Number(page[page.length - 1].seq) : since;
    const headers: Record<string, string> = {};
    if (state.mode !== null) headers['X-Sync-Mode'] = state.mode;
    return new Response(JSON.stringify({
      protocol_version: 2,
      epoch: state.epoch,
      ops: page,
      head_seq: String(head),
      more: page.length === limit && lastSeq < head,
    }), { status: 200, headers });
  }) as typeof fetch;
  return { state, impl };
}

/** Test double for Bun's WebSocket — driven by the tests, records everything. */
class MockSocket implements SyncSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pings = 0;
  closeCalls = 0;

  constructor(
    readonly url: string,
    readonly options?: { headers?: Record<string, string> },
  ) {}

  close(): void { this.closeCalls++; }
  ping(): void { this.pings++; }
  terminate(): void { this.closeCalls++; }

  // ---- test drivers -------------------------------------------------------
  open(): void { this.onopen?.(); }
  message(data: unknown): void { this.onmessage?.({ data }); }
  /** Simulate the peer (or network) dropping the connection. */
  drop(): void { this.onclose?.(); }
}

function makeWsFactory(behavior: { failConstruct?: () => boolean } = {}) {
  const sockets: MockSocket[] = [];
  const attempts: number[] = [];
  const ctor = class {
    constructor(url: string, options?: { headers?: Record<string, string> }) {
      attempts.push(Date.now());
      if (behavior.failConstruct?.()) {
        throw new Error('mock connect refused');
      }
      const socket = new MockSocket(url, options);
      sockets.push(socket);
      return socket; // constructor return-override: the instance IS the mock
    }
  } as unknown as SyncWebSocketConstructor;
  return { ctor, sockets, attempts };
}

function opFrame(epoch: string, ops: HubOp[]): string {
  return JSON.stringify({ type: 'op', epoch, ops });
}

function advanceFrame(epoch: string, headSeq: number): string {
  return JSON.stringify({ type: 'advance', epoch, head_seq: String(headSeq) });
}

describe('SyncClient advisory WebSocket', () => {
  let tempDir: string;
  let db: Database;
  let apply: SyncApply;
  let clients: SyncClient[];

  function makeClient(
    fetchImpl: typeof fetch,
    ws: SyncWebSocketConstructor,
    options: Partial<SyncClientOptions> = {},
  ): SyncClient {
    const client = new SyncClient(apply, {
      hubUrl: 'https://hub.test',
      token: 'test-token-1234',
      userId: 'user-42',
      deviceId: SELF,
      deviceName: 'test laptop',
      fetchImpl,
      webSocketImpl: ws,
      // Slow poll tiers by default: WS behavior must not hide behind polls.
      activePollMs: 60_000,
      idlePollMs: 60_000,
      suspendAfterMs: 3_600_000,
      backoffInitialMs: 10,
      backoffMaxMs: 40,
      minPullGapMs: 0,
      wsPingIntervalMs: 60_000,
      wsBackoffBaseMs: 10,
      wsBackoffMaxMs: 40,
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
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-sync-ws-'));
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

  it('connects to the ws URL with auth and device metadata headers', async () => {
    const { impl } = makeHub({ epoch: '1' });
    const { ctor, sockets } = makeWsFactory();
    makeClient(impl, ctor).start();
    await sleep(20);

    expect(sockets.length).toBe(1);
    expect(sockets[0].url).toBe('wss://hub.test/v1/sync/ws');
    expect(sockets[0].options?.headers).toEqual({
      'Authorization': 'Bearer test-token-1234',
      'X-User-Id': 'user-42',
      'X-Device-Id': SELF,
      'X-Device-Name': 'test laptop',
    });
  });

  it('wsEnabled=false never touches the socket implementation (Phase 3 behavior intact)', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [hubOp(1, '11')] });
    const { ctor, attempts } = makeWsFactory();
    const client = makeClient(impl, ctor, { wsEnabled: false });
    client.start();
    await sleep(50);

    expect(attempts.length).toBe(0);
    expect(client.isSocketLive()).toBe(false);
    // HTTP lane fully functional without it.
    expect(state.requests.length).toBeGreaterThanOrEqual(1);
    expect(apply.getCursor()).toBe('1');
  });

  it('applies a contiguous op frame through SyncApply with NO extra HTTP request', async () => {
    const { state, impl } = makeHub({ epoch: '1' });
    const { ctor, sockets } = makeWsFactory();
    const client = makeClient(impl, ctor);
    client.start();
    await sleep(30); // start() catch-up pull
    sockets[0].open();
    await sleep(30); // reconnect catch-up pull (forced)
    const baseline = state.requests.length;

    // The hub committed 1..2 and fanned them out.
    state.ops = [hubOp(1, '11'), hubOp(2, '12')];
    sockets[0].message(opFrame('1', state.ops));

    expect(count('observations')).toBe(2);
    expect(apply.getCursor()).toBe('2');
    expect(apply.getEpoch()).toBe('1');
    expect(state.requests.length).toBe(baseline); // pure socket application
    expect(sockets[0].closeCalls).toBe(0);
    expect(client.isSocketLive()).toBe(true);
  });

  it('ignores a fully-stale frame (pull/fan-out race) without closing the socket', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [hubOp(1, '11')] });
    const { ctor, sockets } = makeWsFactory();
    makeClient(impl, ctor).start();
    await sleep(30); // HTTP catch-up already applied seq 1
    expect(apply.getCursor()).toBe('1');
    sockets[0].open();
    await sleep(30);
    const baseline = state.requests.length;

    sockets[0].message(opFrame('1', [hubOp(1, '11')])); // late echo of seq 1

    expect(apply.getCursor()).toBe('1');
    expect(count('observations')).toBe(1);
    expect(sockets[0].closeCalls).toBe(0);
    expect(state.requests.length).toBe(baseline);
  });

  it('applies the new suffix of an overlapping frame', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [hubOp(1, '11')] });
    const { ctor, sockets } = makeWsFactory();
    makeClient(impl, ctor).start();
    await sleep(30);
    expect(apply.getCursor()).toBe('1');
    sockets[0].open();
    await sleep(30);

    state.ops = [hubOp(1, '11'), hubOp(2, '12')];
    sockets[0].message(opFrame('1', state.ops)); // [1,2] with cursor at 1

    expect(apply.getCursor()).toBe('2');
    expect(count('observations')).toBe(2);
    expect(sockets[0].closeCalls).toBe(0);
  });

  it('self-heals on a gap frame: closes the socket and converges via one HTTP pull', async () => {
    const { state, impl } = makeHub({ epoch: '1' });
    const { ctor, sockets } = makeWsFactory();
    const client = makeClient(impl, ctor);
    client.start();
    await sleep(30);
    sockets[0].open();
    await sleep(30);

    // The hub is at seq 3 but the frame skips 1-2 (e.g. dropped frames).
    state.ops = [hubOp(1, '11'), hubOp(2, '12'), hubOp(3, '13')];
    sockets[0].message(opFrame('1', [hubOp(3, '13')]));
    await sleep(50);

    expect(sockets[0].closeCalls).toBeGreaterThanOrEqual(1);
    expect(client.isSocketLive()).toBe(false);
    // The lane-2 self-heal pulled everything over HTTP.
    expect(apply.getCursor()).toBe('3');
    expect(count('observations')).toBe(3);
  });

  it('self-heals on an unparseable frame', async () => {
    const { state, impl } = makeHub({ epoch: '1' });
    const { ctor, sockets } = makeWsFactory();
    const client = makeClient(impl, ctor);
    client.start();
    await sleep(30);
    sockets[0].open();
    await sleep(30);

    state.ops = [hubOp(1, '11')];
    sockets[0].message('garbage{');
    await sleep(50);

    expect(sockets[0].closeCalls).toBeGreaterThanOrEqual(1);
    expect(client.isSocketLive()).toBe(false);
    expect(apply.getCursor()).toBe('1'); // healed over HTTP
  });

  it('self-heals on an unknown frame type', async () => {
    const { impl } = makeHub({ epoch: '1' });
    const { ctor, sockets } = makeWsFactory();
    const client = makeClient(impl, ctor);
    client.start();
    await sleep(30);
    sockets[0].open();
    await sleep(30);

    sockets[0].message(JSON.stringify({ type: 'surprise' }));
    await sleep(30);

    expect(sockets[0].closeCalls).toBeGreaterThanOrEqual(1);
    expect(client.isSocketLive()).toBe(false);
  });

  it('self-heals on an epoch mismatch and re-bootstraps from 0', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [hubOp(1, '11'), hubOp(2, '12')] });
    const { ctor, sockets } = makeWsFactory();
    const client = makeClient(impl, ctor);
    client.start();
    await sleep(30);
    expect(apply.getCursor()).toBe('2');
    sockets[0].open();
    await sleep(30);

    // Hub rebuilt: new epoch, re-logged history + one new op.
    state.epoch = '2';
    state.ops = [hubOp(1, '11'), hubOp(2, '12'), hubOp(3, '13')];
    sockets[0].message(opFrame('2', [hubOp(3, '13')]));
    await sleep(80);

    expect(sockets[0].closeCalls).toBeGreaterThanOrEqual(1);
    expect(apply.getEpoch()).toBe('2');
    expect(apply.getCursor()).toBe('3'); // full re-pull converged
  });

  it('detects a rebuilt hub even when the new-epoch frame LOOKS fully stale (epoch checked before the stale skip)', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [hubOp(1, '11'), hubOp(2, '12')] });
    const { ctor, sockets } = makeWsFactory();
    const client = makeClient(impl, ctor);
    client.start();
    await sleep(30);
    expect(apply.getCursor()).toBe('2'); // caught up under e1
    sockets[0].open();
    await sleep(30);

    // Hub rebuilt: seqs restart LOW — under the old ordering this frame
    // (last seq 1 <= cursor 2) would be silently stale-skipped and detection
    // would wait for the stretched poll tier.
    state.epoch = '2';
    state.ops = [hubOp(1, '31')];
    sockets[0].message(opFrame('2', [hubOp(1, '31')]));
    await sleep(80);

    expect(sockets[0].closeCalls).toBeGreaterThanOrEqual(1); // self-heal, not skip
    expect(client.isSocketLive()).toBe(false);
    expect(apply.getEpoch()).toBe('2');
    expect(apply.getCursor()).toBe('1'); // re-bootstrapped from 0 under e2
  });

  it('detects a rebuilt hub on an advance frame below the cursor too', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [hubOp(1, '11'), hubOp(2, '12')] });
    const { ctor, sockets } = makeWsFactory();
    const client = makeClient(impl, ctor);
    client.start();
    await sleep(30);
    expect(apply.getCursor()).toBe('2');
    sockets[0].open();
    await sleep(30);

    // Rebuilt hub announcing a head BELOW our stale cursor: the old
    // head<=cursor short-circuit would have ignored it.
    state.epoch = '2';
    state.ops = [hubOp(1, '31')];
    sockets[0].message(advanceFrame('2', 1));
    await sleep(80);

    expect(sockets[0].closeCalls).toBeGreaterThanOrEqual(1);
    expect(apply.getEpoch()).toBe('2');
    expect(apply.getCursor()).toBe('1');
  });

  it('an advance frame triggers an HTTP pull; at/below the cursor it is a no-op', async () => {
    const { state, impl } = makeHub({ epoch: '1' });
    const { ctor, sockets } = makeWsFactory();
    makeClient(impl, ctor).start();
    await sleep(30);
    sockets[0].open();
    await sleep(30);

    state.ops = [1, 2, 3, 4, 5].map(i => hubOp(i, String(10 + i)));
    sockets[0].message(advanceFrame('1', 5));
    await sleep(50);
    expect(apply.getCursor()).toBe('5');
    expect(count('observations')).toBe(5);
    expect(sockets[0].closeCalls).toBe(0); // advance is not an anomaly

    const baseline = state.requests.length;
    sockets[0].message(advanceFrame('1', 5)); // nothing new
    await sleep(50);
    expect(state.requests.length).toBe(baseline);
  });

  it('reconnects with bounded full-jitter backoff and keeps HTTP polling alive', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [hubOp(1, '11')] });
    const { ctor, attempts } = makeWsFactory({ failConstruct: () => true });
    // random()=1 pins each delay at the ceiling: 10, 20, 40, 40 (cap)...
    makeClient(impl, ctor, { random: () => 1 }).start();
    await sleep(120);

    // Ceiling schedule reaches attempt 4 by ~70 ms; attempt 6 not before
    // 190 ms. Anything in [3, 6] proves growth without a busy-loop.
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    expect(attempts.length).toBeLessThanOrEqual(6);
    // The advisory lane failing did not touch lane 1.
    expect(state.requests.length).toBeGreaterThanOrEqual(1);
    expect(apply.getCursor()).toBe('1');
  });

  it('stretches the active poll tier to idle while connected; restores it on disconnect', async () => {
    const { state, impl } = makeHub({ epoch: '1' });
    const { ctor, sockets } = makeWsFactory();
    makeClient(impl, ctor, {
      activePollMs: 20,
      idlePollMs: 100_000,
      isSessionActive: () => true,
    }).start();
    sockets[0].open(); // connected before the first tick
    await sleep(200);

    // Catch-up pull + the socket-open forced pull; the 20 ms active tier is
    // stretched to the 100 s idle tier, so nothing else polls.
    const whileConnected = state.requests.length;
    expect(whileConnected).toBeLessThanOrEqual(3);

    sockets[0].drop(); // disconnect → normal cadence restored
    await sleep(200);
    expect(state.requests.length).toBeGreaterThanOrEqual(whileConnected + 3);
  });

  it('flips onSocketLiveChange true on open, false on disconnect (CloudSync fast-debounce coupling)', async () => {
    const { impl } = makeHub({ epoch: '1' });
    const { ctor, sockets } = makeWsFactory();
    const events: boolean[] = [];
    makeClient(impl, ctor, { onSocketLiveChange: (live) => events.push(live) }).start();
    await sleep(20);
    sockets[0].open();
    expect(events).toEqual([true]);

    sockets[0].drop();
    expect(events).toEqual([true, false]);
  });

  it('flips the liveness flag off on self-heal too', async () => {
    const { impl } = makeHub({ epoch: '1' });
    const { ctor, sockets } = makeWsFactory();
    const events: boolean[] = [];
    makeClient(impl, ctor, { onSocketLiveChange: (live) => events.push(live) }).start();
    await sleep(20);
    sockets[0].open();
    sockets[0].message('garbage{'); // anomaly → self-heal
    await sleep(30);
    expect(events).toEqual([true, false]);
  });

  it('a throwing liveness listener is swallowed (socket stays functional)', async () => {
    const { state, impl } = makeHub({ epoch: '1' });
    const { ctor, sockets } = makeWsFactory();
    makeClient(impl, ctor, {
      onSocketLiveChange: () => { throw new Error('listener bug'); },
    }).start();
    await sleep(20);
    sockets[0].open();
    await sleep(30);

    state.ops = [hubOp(1, '11')];
    sockets[0].message(opFrame('1', state.ops));
    expect(apply.getCursor()).toBe('1');
    expect(sockets[0].closeCalls).toBe(0);
  });

  it('sends protocol pings on the configured cadence and stops them on stop()', async () => {
    const { impl } = makeHub({ epoch: '1' });
    const { ctor, sockets } = makeWsFactory();
    const client = makeClient(impl, ctor, { wsPingIntervalMs: 15 });
    client.start();
    await sleep(20);
    sockets[0].open();
    await sleep(100);
    expect(sockets[0].pings).toBeGreaterThanOrEqual(3);

    client.stop();
    const atStop = sockets[0].pings;
    await sleep(60);
    expect(sockets[0].pings).toBe(atStop);
  });

  it('stop() closes the socket and prevents reconnects', async () => {
    const { impl } = makeHub({ epoch: '1' });
    const { ctor, sockets, attempts } = makeWsFactory();
    const client = makeClient(impl, ctor);
    client.start();
    await sleep(20);
    sockets[0].open();

    client.stop();
    expect(sockets[0].closeCalls).toBeGreaterThanOrEqual(1);
    expect(client.isSocketLive()).toBe(false);

    const attemptsAtStop = attempts.length;
    await sleep(100);
    expect(attempts.length).toBe(attemptsAtStop); // no zombie reconnect
  });

  // -------------------------------------------------------------------------
  // Kill-switch poll mode (plan Phase 5 task 2)
  // -------------------------------------------------------------------------

  it('X-Sync-Mode: poll on a pull closes the socket, suppresses reconnects, keeps polling; header gone resumes the socket', async () => {
    const { state, impl } = makeHub({ epoch: '1' });
    const { ctor, sockets, attempts } = makeWsFactory();
    const client = makeClient(impl, ctor, {
      activePollMs: 20,
      idlePollMs: 20,
      isSessionActive: () => true,
    });
    client.start();
    await sleep(20);
    sockets[0].open();
    await sleep(20);
    expect(client.isSocketLive()).toBe(true);

    // Kill switch trips: the hub stamps every response.
    state.mode = 'poll';
    state.ops = [hubOp(1, '11')];
    await sleep(80); // next poll carries the header
    expect(client.isPollModeOnly()).toBe(true);
    expect(client.isSocketLive()).toBe(false);
    expect(sockets[0].closeCalls).toBeGreaterThanOrEqual(1);
    expect(attempts.length).toBe(1); // no reconnect attempts while tripped

    // The structural guarantee: HTTP sync is untouched — the pull loop
    // keeps running (which IS the re-probe) and data still converges.
    expect(apply.getCursor()).toBe('1');
    const requestsInPollMode = state.requests.length;
    await sleep(80);
    expect(state.requests.length).toBeGreaterThan(requestsInPollMode);
    expect(attempts.length).toBe(1);

    // Kill switch cleared: the header disappears from the next response
    // and the socket resumes with a fresh backoff ladder.
    state.mode = null;
    await sleep(80);
    expect(client.isPollModeOnly()).toBe(false);
    expect(attempts.length).toBe(2); // one fresh connect, not a stampede
    sockets[1].open();
    expect(client.isSocketLive()).toBe(true);
  });

  it('poll mode present from the very first pull suppresses the initial socket before it ever opens', async () => {
    const { state, impl } = makeHub({ epoch: '1', ops: [hubOp(1, '11')] });
    state.mode = 'poll';
    const { ctor, sockets, attempts } = makeWsFactory();
    const client = makeClient(impl, ctor, {
      activePollMs: 20,
      idlePollMs: 20,
      isSessionActive: () => true,
    });
    client.start(); // constructs the socket, then the catch-up pull sees poll
    await sleep(60);

    expect(client.isPollModeOnly()).toBe(true);
    expect(sockets[0].closeCalls).toBeGreaterThanOrEqual(1); // torn down unopened
    expect(apply.getCursor()).toBe('1'); // pull path unaffected
    const attemptsInPollMode = attempts.length;
    await sleep(100);
    expect(attempts.length).toBe(attemptsInPollMode); // no reconnect churn
    expect(attemptsInPollMode).toBe(1);
  });

  it('onSyncModeHint (the CloudSync push-surface wiring) drops and resumes the socket without any pull', async () => {
    const { impl } = makeHub({ epoch: '1' });
    const { ctor, sockets, attempts } = makeWsFactory();
    const events: boolean[] = [];
    const client = makeClient(impl, ctor, {
      onSocketLiveChange: (live) => events.push(live),
    });
    client.start();
    await sleep(20);
    sockets[0].open();
    expect(events).toEqual([true]);
    // Let the socket-open forced pull settle first: a response from a
    // request that was ALREADY in flight when the switch trips carries no
    // header and would briefly flap the mode back (self-correcting — the
    // next stamped response re-enters poll mode — but not what this test
    // is about).
    await sleep(30);

    client.onSyncModeHint('poll'); // a push response carried the header
    expect(client.isPollModeOnly()).toBe(true);
    expect(client.isSocketLive()).toBe(false);
    expect(sockets[0].closeCalls).toBeGreaterThanOrEqual(1);
    expect(events).toEqual([true, false]); // fast-debounce coupling restored

    // A dropped-socket event during poll mode schedules nothing.
    await sleep(60);
    expect(attempts.length).toBe(1);

    client.onSyncModeHint(null); // header disappeared from a push response
    expect(client.isPollModeOnly()).toBe(false);
    await sleep(10);
    expect(attempts.length).toBe(2); // socket resumed
    sockets[1].open();
    expect(client.isSocketLive()).toBe(true);
    expect(events).toEqual([true, false, true]);
  });

  it('an ERROR response without the header does NOT exit poll mode; a later OK response does', async () => {
    const { state, impl } = makeHub({ epoch: '1' });
    const { ctor, sockets, attempts } = makeWsFactory();
    const client = makeClient(impl, ctor, {
      activePollMs: 20,
      idlePollMs: 20,
      isSessionActive: () => true,
    });
    client.start();
    await sleep(20);
    sockets[0].open();
    await sleep(20);

    state.mode = 'poll';
    await sleep(60);
    expect(client.isPollModeOnly()).toBe(true);
    expect(attempts.length).toBe(1);

    // Correlated incident: the hub starts erroring WITHOUT the header (a
    // degraded auth upstream during the same incident that tripped the
    // switch). Header absence on an error response is ambiguous — the
    // client must stay in poll mode instead of resuming socket churn for
    // the whole outage.
    state.mode = null;
    state.failStatus = 503;
    await sleep(120);
    expect(client.isPollModeOnly()).toBe(true);
    expect(attempts.length).toBe(1); // reconnects still suppressed

    // Recovery: an OK response without the header is authoritative.
    state.failStatus = null;
    await sleep(120);
    expect(client.isPollModeOnly()).toBe(false);
    expect(attempts.length).toBe(2);
    sockets[1].open();
    expect(client.isSocketLive()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Suspension × socket (plan Phase 5 review: an idle client must not hold
  // the advisory socket — a held socket pins the hub DO while never seeing
  // a stamped HTTP response, the exact hibernation-defeat case)
  // -------------------------------------------------------------------------

  it('suspension tears the advisory socket down (pings stop); pullOnce resume reconnects it', async () => {
    const { impl } = makeHub({ epoch: '1' });
    const { ctor, sockets, attempts } = makeWsFactory();
    const client = makeClient(impl, ctor, {
      activePollMs: 20,
      idlePollMs: 20,
      suspendAfterMs: 50, // no isSessionActive callback ⇒ idles, then suspends
      wsPingIntervalMs: 15,
    });
    client.start();
    await sleep(20);
    sockets[0].open();
    expect(client.isSocketLive()).toBe(true);

    // 50 ms with no activity ⇒ the loop suspends AND the socket goes with it.
    await sleep(200);
    expect(client.isSocketLive()).toBe(false);
    expect(sockets[0].closeCalls).toBeGreaterThanOrEqual(1);
    const pingsAtSuspend = sockets[0].pings;
    await sleep(60);
    expect(sockets[0].pings).toBe(pingsAtSuspend); // keepalive stopped too
    expect(attempts.length).toBe(1); // and no reconnect churn while suspended

    // Session activity (the session-start pull) resumes loop AND socket.
    await client.pullOnce({ force: true });
    expect(attempts.length).toBe(2);
    sockets[1].open();
    expect(client.isSocketLive()).toBe(true);
  });
});
