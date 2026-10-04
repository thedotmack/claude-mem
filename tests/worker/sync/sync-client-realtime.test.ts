// Phase 11 verification (plan 2026-10-03 liveness-over-deadlines): SyncClient
// live updates over Supabase Realtime (Phoenix protocol vsn 1.0.0).
//
// The Realtime endpoint is a real local WebSocket server (Bun.serve) that
// speaks just enough Phoenix: it acks joins (or refuses them), answers
// heartbeats, and lets the test push `advance` broadcasts. The hub's HTTP
// surface (/v1/sync/realtime-token and /v1/sync/changes) is a scripted fetch
// mock. The client uses Bun's real global WebSocket.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SyncApply } from '../../../src/services/sync/SyncApply.js';
import { REALTIME_JOIN_REPLY_TIMEOUT_MS, SyncClient, type SyncClientOptions } from '../../../src/services/sync/SyncClient.js';
import { observationChange, type TestHubChange } from './content-v2-helpers.js';
import { buildContentOperation } from '../../../src/services/sync/CanonicalContent.js';
import { ContextCacheService } from '../../../src/services/worker/ContextCacheService.js';
import { contextCacheFilePath, contextCacheKeys, readContextCache } from '../../../src/shared/context-cache.js';
import { existsSync, rmSync } from 'fs';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await sleep(5);
  }
}

const SELF = 'device-fixture';
const REMOTE = 'device-a';
const USER_ID = 'user-42';
const CHANNEL = `realtime:user:${USER_ID}`;

interface PhoenixFrame {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref: string | null;
  join_ref?: string | null;
}

/** Minimal Supabase Realtime (Phoenix vsn 1.0.0) endpoint. */
function startRealtimeServer() {
  const state = {
    upgradeUrls: [] as string[],
    frames: [] as PhoenixFrame[],
    open: new Set<ServerWebSocket<unknown>>(),
    closes: 0,
    joinStatus: 'ok' as 'ok' | 'error',
    answerHeartbeats: true,
    /** false ⇒ joins are recorded but never get a phx_reply. */
    answerJoins: true,
  };
  const server: Server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      state.upgradeUrls.push(req.url);
      if (srv.upgrade(req)) return undefined;
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      open(ws) { state.open.add(ws); },
      close(ws) { state.open.delete(ws); state.closes++; },
      message(ws, message) {
        const frame = JSON.parse(String(message)) as PhoenixFrame;
        state.frames.push(frame);
        if (frame.event === 'phx_join' && state.answerJoins) {
          ws.send(JSON.stringify({
            topic: frame.topic,
            event: 'phx_reply',
            payload: state.joinStatus === 'ok'
              ? { status: 'ok', response: { postgres_changes: [] } }
              : { status: 'error', response: { reason: 'Unauthorized: You do not have permissions to read from this Channel topic' } },
            ref: frame.ref,
            join_ref: frame.join_ref,
          }));
        } else if (frame.event === 'heartbeat' && state.answerHeartbeats) {
          ws.send(JSON.stringify({
            topic: 'phoenix', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: frame.ref,
          }));
        }
      },
    },
  });
  const url = `ws://127.0.0.1:${server.port}/realtime/v1/websocket`;
  return {
    state,
    url,
    framesOf: (event: string) => state.frames.filter(f => f.event === event),
    /** What realtime.send(payload, 'advance', 'user:<id>', true) delivers. */
    broadcastAdvance(epoch: unknown, headSeq: unknown) {
      const frame = JSON.stringify({
        topic: CHANNEL,
        event: 'broadcast',
        payload: { type: 'broadcast', event: 'advance', meta: { id: 'm1' }, payload: { type: 'advance', epoch, head_seq: headSeq } },
        ref: null,
      });
      for (const ws of state.open) ws.send(frame);
    },
    dropAll() { for (const ws of state.open) ws.close(1011, 'test drop'); },
    stop() { server.stop(true); },
  };
}

type RealtimeServer = ReturnType<typeof startRealtimeServer>;

/** Scripted hub HTTP surface: /changes + /realtime-token. */
function makeHub(realtime: RealtimeServer, initial: { epoch: string; ops?: TestHubChange[] }) {
  const state = {
    epoch: initial.epoch,
    ops: initial.ops ?? [],
    pulls: 0,
    tokenRequests: [] as Array<{ method: string; headers: Record<string, string> }>,
    tokenStatus: 200,
    tokenLifetimeSeconds: 900,
    /** Header stamped on every response (the Supabase server sends poll). */
    syncMode: 'poll' as string | null,
    /** When set, every /changes request waits on it (a catch-up pull still in flight). */
    changesGate: null as Promise<void> | null,
    /** Non-200 ⇒ /changes fails with this status. */
    changesStatus: 200,
  };
  const impl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    if (state.syncMode !== null) headers['X-Sync-Mode'] = state.syncMode;
    if (url.pathname === '/v1/sync/realtime-token') {
      state.tokenRequests.push({ method: init?.method, headers: { ...(init?.headers ?? {}) } });
      if (state.tokenStatus !== 200) {
        return new Response(JSON.stringify({ error: 'nope' }), { status: state.tokenStatus, headers });
      }
      const n = state.tokenRequests.length;
      return new Response(JSON.stringify({
        access_token: `jwt-${n}`,
        expires_at: Math.ceil(Date.now() / 1000) + state.tokenLifetimeSeconds,
        realtime_url: realtime.url,
        apikey: 'anon-key',
        topic: `user:${USER_ID}`,
      }), { status: 200, headers });
    }
    state.pulls++;
    if (state.changesGate) await state.changesGate;
    if (state.changesStatus !== 200) {
      return new Response('hub down', { status: state.changesStatus, headers });
    }
    const since = Number(url.searchParams.get('since') ?? '0');
    const page = state.ops.filter(op => Number(op.seq) > since).sort((a, b) => Number(a.seq) - Number(b.seq));
    const head = state.ops.reduce((m, op) => Math.max(m, Number(op.seq)), 0);
    return new Response(JSON.stringify({
      protocol_version: 2, epoch: state.epoch, ops: page, head_seq: String(head), more: false,
    }), { status: 200, headers });
  }) as typeof fetch;
  return { state, impl };
}

describe('SyncClient Supabase Realtime live updates', () => {
  let db: Database;
  let apply: SyncApply;
  let clients: SyncClient[];
  let realtime: RealtimeServer;

  function makeClient(fetchImpl: typeof fetch, options: Partial<SyncClientOptions> = {}): SyncClient {
    const client = new SyncClient(apply, {
      hubUrl: 'https://hub.test',
      token: 'test-token-1234',
      userId: USER_ID,
      deviceId: SELF,
      deviceName: 'test laptop',
      fetchImpl,
      // Slow poll tiers: live behavior must not hide behind polls.
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

  const hubOp = (seq: number, originId: string) => observationChange(seq, originId, REMOTE);

  beforeEach(() => {
    db = new Database(':memory:');
    new SessionStore(db);
    apply = new SyncApply(db, { deviceId: SELF });
    clients = [];
    realtime = startRealtimeServer();
  });

  afterEach(() => {
    for (const client of clients) client.stop();
    realtime.stop();
    db.close();
  });

  it('mints a token with the hub credentials, connects with apikey+vsn, and sends the exact private-channel join', async () => {
    const { state, impl } = makeHub(realtime, { epoch: '1' });
    const client = makeClient(impl);
    client.start();
    await waitFor(() => client.isSocketLive(), 'channel joined');

    expect(state.tokenRequests[0]).toEqual({
      method: 'POST',
      headers: {
        'Authorization': 'Bearer test-token-1234',
        'X-User-Id': USER_ID,
        'X-Device-Id': SELF,
        'X-Device-Name': 'test laptop',
      },
    });
    const upgrade = new URL(realtime.state.upgradeUrls[0]);
    expect(upgrade.pathname).toBe('/realtime/v1/websocket');
    expect(upgrade.searchParams.get('apikey')).toBe('anon-key');
    expect(upgrade.searchParams.get('vsn')).toBe('1.0.0');
    expect(realtime.state.frames[0]).toEqual({
      topic: CHANNEL,
      event: 'phx_join',
      payload: {
        config: { broadcast: { self: false, ack: false }, presence: { enabled: false }, private: true },
        access_token: 'jwt-1',
      },
      ref: '1',
      join_ref: '1',
    });
  });

  it('an advance broadcast triggers the HTTP pull; at/below the cursor it is a no-op', async () => {
    const { state, impl } = makeHub(realtime, { epoch: '1' });
    const client = makeClient(impl);
    client.start();
    await waitFor(() => client.isSocketLive(), 'channel joined');
    await sleep(30); // join catch-up pull settles
    const baseline = state.pulls;

    state.ops = [1, 2, 3].map(i => hubOp(i, String(10 + i)));
    realtime.broadcastAdvance('1', '3');
    await waitFor(() => apply.getCursor() === '3', 'pulled to head 3');
    expect(state.pulls).toBe(baseline + 1);

    realtime.broadcastAdvance('1', '3'); // nothing new
    await sleep(50);
    expect(state.pulls).toBe(baseline + 1);
    expect(client.isSocketLive()).toBe(true);
  });

  it('an epoch mismatch on the channel is an anomaly: drop the socket, re-bootstrap over HTTP, reconnect', async () => {
    const { state, impl } = makeHub(realtime, { epoch: '1', ops: [hubOp(1, '11'), hubOp(2, '12')] });
    const client = makeClient(impl);
    client.start();
    await waitFor(() => client.isSocketLive() && apply.getCursor() === '2', 'joined and caught up');

    // Rebuilt log: new epoch, seqs restart low — head 1 is BELOW the cursor,
    // so only the epoch check (done first) can notice.
    state.epoch = '2';
    state.ops = [hubOp(1, '31')];
    realtime.broadcastAdvance('2', '1');

    await waitFor(() => apply.getEpoch() === '2' && apply.getCursor() === '1', 're-bootstrapped under epoch 2');
    expect(realtime.state.closes).toBeGreaterThanOrEqual(1);
    await waitFor(() => realtime.framesOf('phx_join').length >= 2, 'reconnected and re-joined');
  });

  it('a malformed advance (numeric epoch) is an anomaly too', async () => {
    const { impl } = makeHub(realtime, { epoch: '1' });
    const client = makeClient(impl);
    client.start();
    await waitFor(() => client.isSocketLive(), 'channel joined');

    realtime.broadcastAdvance(1, 3);
    await waitFor(() => realtime.state.closes >= 1, 'socket dropped');
  });

  it('sends Phoenix heartbeats on the configured cadence with fresh refs', async () => {
    const { impl } = makeHub(realtime, { epoch: '1' });
    const client = makeClient(impl, { wsPingIntervalMs: 30 });
    client.start();
    await waitFor(() => client.isSocketLive(), 'channel joined');
    await sleep(200);

    const beats = realtime.framesOf('heartbeat');
    expect(beats.length).toBeGreaterThanOrEqual(4);
    expect(beats.length).toBeLessThanOrEqual(8);
    expect(beats[0]).toEqual({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: beats[0].ref });
    expect(new Set(beats.map(b => b.ref)).size).toBe(beats.length);
    expect(realtime.state.closes).toBe(0);
  });

  it('caps the heartbeat interval at 25 s even when configured higher', async () => {
    // Indirect: a 60 s setting must not survive — exposed via no throw and
    // the constructor clamp; behavior is covered by the cadence test above.
    const { impl } = makeHub(realtime, { epoch: '1' });
    const client = makeClient(impl, { wsPingIntervalMs: 120_000 });
    expect((client as unknown as { wsPingIntervalMs: number }).wsPingIntervalMs).toBe(25_000);
  });

  it('an unanswered heartbeat declares the socket dead and reconnects', async () => {
    const { impl } = makeHub(realtime, { epoch: '1' });
    const client = makeClient(impl, { wsPingIntervalMs: 30 });
    realtime.state.answerHeartbeats = false;
    client.start();
    await waitFor(() => client.isSocketLive(), 'channel joined');

    await waitFor(() => realtime.state.closes >= 1, 'dead socket dropped');
    realtime.state.answerHeartbeats = true;
    await waitFor(() => realtime.framesOf('phx_join').length >= 2 && client.isSocketLive(), 'reconnected');
  });

  it('a join that gets no phx_reply within the deadline drops the socket and reconnects with backoff', async () => {
    expect(REALTIME_JOIN_REPLY_TIMEOUT_MS).toBe(10_000);
    const { state, impl } = makeHub(realtime, { epoch: '1' });
    realtime.state.answerJoins = false;
    const client = makeClient(impl, { wsJoinReplyTimeoutMs: 40 });
    client.start();

    await waitFor(() => realtime.framesOf('phx_join').length >= 1, 'first join sent');
    await waitFor(() => realtime.state.closes >= 1, 'unanswered join dropped');
    expect(client.isSocketLive()).toBe(false);
    await waitFor(() => realtime.framesOf('phx_join').length >= 2, 'reconnected and re-joined');
    // Each reconnect mints fresh credentials.
    expect(state.tokenRequests.length).toBeGreaterThanOrEqual(2);

    realtime.state.answerJoins = true;
    await waitFor(() => client.isSocketLive(), 'joined once the server answers');
    const closesWhenLive = realtime.state.closes;
    await sleep(120); // the answered join's deadline must not fire later
    expect(client.isSocketLive()).toBe(true);
    expect(realtime.state.closes).toBe(closesWhenLive);
  });

  it('re-mints the access token before expiry and hands it to the open channel', async () => {
    const { state, impl } = makeHub(realtime, { epoch: '1' });
    state.tokenLifetimeSeconds = 1; // refresh at ~80 % (≥ 1 s floor)
    const client = makeClient(impl);
    client.start();
    await waitFor(() => client.isSocketLive(), 'channel joined');

    await waitFor(() => realtime.framesOf('access_token').length >= 1, 'token refresh frame', 4_000);
    const refresh = realtime.framesOf('access_token')[0];
    expect(refresh.topic).toBe(CHANNEL);
    expect(refresh.payload).toEqual({ access_token: 'jwt-2' });
    expect(refresh.join_ref).toBe('1');
    expect(typeof refresh.ref).toBe('string');
    // Same socket — refresh never reconnects.
    expect(realtime.state.closes).toBe(0);
    expect(realtime.framesOf('phx_join')).toHaveLength(1);
  }, 10_000);

  it('a refused join backs off with full jitter and recovers once the server allows it', async () => {
    const { impl } = makeHub(realtime, { epoch: '1' });
    realtime.state.joinStatus = 'error';
    // random()=1 pins each delay at the ceiling: 20, 40, 80, 80 ...
    const client = makeClient(impl, { wsBackoffBaseMs: 20, wsBackoffMaxMs: 80, random: () => 1 });
    client.start();
    await sleep(300);

    const attempts = realtime.framesOf('phx_join').length;
    expect(client.isSocketLive()).toBe(false);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(attempts).toBeLessThanOrEqual(7); // bounded — no busy loop

    realtime.state.joinStatus = 'ok';
    await waitFor(() => client.isSocketLive(), 'joined after the server allowed it');
  });

  it('realtime-token 404 ⇒ no Realtime on the server: poll mode, HTTP continues, re-probes later', async () => {
    const { state, impl } = makeHub(realtime, { epoch: '1', ops: [hubOp(1, '11')] });
    state.tokenStatus = 404;
    const client = makeClient(impl, { realtimeUnavailableRetryMs: 150 });
    client.start();
    await waitFor(() => client.isPollModeOnly(), 'poll mode');

    expect(apply.getCursor()).toBe('1'); // HTTP lane unaffected
    expect(realtime.state.upgradeUrls).toHaveLength(0);
    await sleep(50);
    expect(state.tokenRequests).toHaveLength(1); // no hammering before the re-probe

    state.tokenStatus = 200; // server gains Realtime
    await waitFor(() => client.isSocketLive(), 're-probe connected');
    expect(client.isPollModeOnly()).toBe(false);
    expect(state.tokenRequests).toHaveLength(2);
  });

  it('realtime-token 401 enters the auth pause: no socket, no retry churn', async () => {
    const { state, impl } = makeHub(realtime, { epoch: '1' });
    state.tokenStatus = 401;
    const client = makeClient(impl);
    client.start();
    await sleep(150);

    expect(state.tokenRequests).toHaveLength(1);
    expect(realtime.state.upgradeUrls).toHaveLength(0);
    expect(client.isSocketLive()).toBe(false);
  });

  it('X-Sync-Mode: poll (aimed at old clients) never disables Realtime', async () => {
    const { state, impl } = makeHub(realtime, { epoch: '1' });
    state.syncMode = 'poll'; // stamped on every response, like the Supabase server
    const client = makeClient(impl, { activePollMs: 20, idlePollMs: 20, isSessionActive: () => true });
    client.start();
    await waitFor(() => client.isSocketLive(), 'channel joined despite poll header');

    client.onSyncModeHint('poll'); // CloudSync push-surface wiring
    await sleep(80); // several pulls carrying the header
    expect(client.isSocketLive()).toBe(true);
    expect(client.isPollModeOnly()).toBe(false);
    expect(realtime.state.closes).toBe(0);
  });

  it('wsEnabled=false never mints a token or opens a socket', async () => {
    const { state, impl } = makeHub(realtime, { epoch: '1', ops: [hubOp(1, '11')] });
    const client = makeClient(impl, { wsEnabled: false });
    client.start();
    await sleep(60);

    expect(state.tokenRequests).toHaveLength(0);
    expect(realtime.state.upgradeUrls).toHaveLength(0);
    expect(client.isPollModeOnly()).toBe(true);
    expect(apply.getCursor()).toBe('1');
  });

  it('stretches the active poll tier while joined; restores it when the socket drops', async () => {
    const { state, impl } = makeHub(realtime, { epoch: '1' });
    const client = makeClient(impl, {
      activePollMs: 20,
      idlePollMs: 100_000,
      isSessionActive: () => true,
      wsBackoffBaseMs: 5_000, // keep the socket down after the drop
      wsBackoffMaxMs: 5_000,
      random: () => 1,
    });
    client.start();
    await waitFor(() => client.isSocketLive(), 'channel joined');
    await sleep(30);
    const whileJoined = state.pulls;
    await sleep(150);
    expect(state.pulls).toBe(whileJoined);

    realtime.dropAll();
    await waitFor(() => !client.isSocketLive(), 'socket dropped');
    await sleep(150);
    expect(state.pulls).toBeGreaterThanOrEqual(whileJoined + 3);
  });

  it('flips onSocketLiveChange on join and on drop; stop() closes without reconnecting', async () => {
    const { impl } = makeHub(realtime, { epoch: '1' });
    const events: boolean[] = [];
    const client = makeClient(impl, { onSocketLiveChange: live => events.push(live) });
    client.start();
    await waitFor(() => client.isSocketLive(), 'channel joined');
    expect(events).toEqual([true]);

    realtime.dropAll();
    // The reconnect may already have re-joined by the time we look.
    await waitFor(() => events.length >= 2, 'drop observed');
    expect(events.slice(0, 2)).toEqual([true, false]);
    await waitFor(() => client.isSocketLive(), 'reconnected');
    expect(events).toEqual([true, false, true]);

    client.stop();
    expect(client.isSocketLive()).toBe(false);
    const joinsAtStop = realtime.framesOf('phx_join').length;
    await sleep(100);
    expect(realtime.framesOf('phx_join')).toHaveLength(joinsAtStop);
  });

  describe('SessionStart context cache servability (worker wiring)', () => {
    const cacheKeys = contextCacheKeys(['proj-remote'], 'claude', false);
    let cache: ContextCacheService;
    /** Every body the hook could have read from the cache file, sampled throughout. */
    let published: string[];
    let sampler: ReturnType<typeof setInterval> | null;
    const publishedNow = () => readContextCache(cacheKeys, Date.now())?.body ?? null;

    const tombstoneChange = (seq: number, originId: string): TestHubChange => ({
      ...buildContentOperation({
        kind: 'observation', originDeviceId: REMOTE, originLocalId: originId, entityRev: '2',
        payload: null, deleted: true, deletedAt: new Date(1_751_328_100_000).toISOString(),
      }),
      seq: String(seq),
      server_ts: String(1_751_328_100_000),
    });
    const liveTitles = () =>
      (db.prepare('SELECT title FROM observations ORDER BY id').all() as Array<{ title: string }>).map(r => r.title);

    beforeEach(async () => {
      published = [];
      cache = new ContextCacheService({
        debounceMs: 5,
        initiallyServable: false,
        expandProjectReadKeys: projects => projects,
        renderVariant: async () => ({ body: `titles: ${liveTitles().join('|')}`, cacheable: true }),
      });
      cache.start();
      cache.recordLiveRender(cacheKeys, { body: 'live render', cacheable: true }, Date.now());
      await cache.flushPendingRenders();
      sampler = setInterval(() => {
        const body = publishedNow();
        if (body !== null) published.push(body);
      }, 1);
    });

    afterEach(async () => {
      if (sampler) clearInterval(sampler);
      await cache.flushPendingRenders();
      cache.stop();
      rmSync(contextCacheFilePath(cacheKeys), { force: true });
    });

    /** Exactly the worker-service wiring: down ⇒ unservable now; servable only once caught up. */
    function makeWiredClient(fetchImpl: typeof fetch, options: Partial<SyncClientOptions> = {}): SyncClient {
      return makeClient(fetchImpl, {
        onSocketLiveChange: live => { if (!live) cache.setServable(false); },
        onRealtimeCaughtUp: () => cache.setServable(true),
        ...options,
      });
    }

    it('a join with a pending remote tombstone stays unservable until the catch-up pull applied it', async () => {
      // The observation reached this device before; its deletion is still on the hub.
      const { state, impl } = makeHub(realtime, { epoch: '1', ops: [hubOp(1, '7')] });
      await makeClient(impl, { wsEnabled: false }).pullOnce({ force: true });
      expect(liveTitles()).toEqual(['obs 7']);
      state.ops.push(tombstoneChange(2, '7'));
      let releaseChanges!: () => void;
      state.changesGate = new Promise<void>(resolve => { releaseChanges = resolve; });

      const caughtUp: number[] = [];
      const client = makeWiredClient(impl, { onRealtimeCaughtUp: () => { caughtUp.push(Date.now()); cache.setServable(true); } });
      client.start();
      await waitFor(() => client.isSocketLive(), 'channel joined');
      await sleep(50); // ample time for a (wrong) servable flip to render

      expect(liveTitles()).toEqual(['obs 7']); // the deletion is not applied yet
      expect(client.isRealtimeCaughtUp()).toBe(false);
      expect(caughtUp).toEqual([]);
      await cache.flushPendingRenders();
      expect(existsSync(contextCacheFilePath(cacheKeys))).toBe(false);
      expect(published).toEqual([]);

      state.changesGate = null;
      releaseChanges();
      await waitFor(() => client.isRealtimeCaughtUp(), 'caught up after join');
      await cache.flushPendingRenders();

      expect(liveTitles()).toEqual([]);
      expect(caughtUp).toHaveLength(1);
      expect(publishedNow()).toBe('titles: ');
      await sleep(5);
      // No sample of the cache file, at any point, ever showed the deleted memory.
      expect(published.length).toBeGreaterThan(0);
      expect(published.every(body => !body.includes('obs 7'))).toBe(true);
    });

    it('a failed catch-up pull stays unservable; the next successful pull while live makes it servable', async () => {
      const { state, impl } = makeHub(realtime, { epoch: '1', ops: [hubOp(1, '7')] });
      state.changesStatus = 503;
      // Short poll tiers: the loop's backoff retry is what eventually succeeds.
      const client = makeWiredClient(impl, { activePollMs: 20, idlePollMs: 20, backoffInitialMs: 20, backoffMaxMs: 20 });
      client.start();
      await waitFor(() => client.isSocketLive(), 'channel joined');
      await waitFor(() => state.pulls >= 3, 'catch-up pulls retried');
      expect(client.isRealtimeCaughtUp()).toBe(false);
      await cache.flushPendingRenders();
      expect(published).toEqual([]);
      expect(existsSync(contextCacheFilePath(cacheKeys))).toBe(false);

      state.changesStatus = 200;
      await waitFor(() => client.isRealtimeCaughtUp(), 'caught up after recovery');
      await cache.flushPendingRenders();
      expect(publishedNow()).toBe('titles: obs 7');
    });

    it('a socket drop removes the files at once and the next join must catch up again', async () => {
      const { state, impl } = makeHub(realtime, { epoch: '1' });
      const client = makeWiredClient(impl, { wsBackoffBaseMs: 200, wsBackoffMaxMs: 200, random: () => 1 });
      client.start();
      await waitFor(() => client.isRealtimeCaughtUp(), 'first catch-up');
      await cache.flushPendingRenders();
      expect(existsSync(contextCacheFilePath(cacheKeys))).toBe(true);

      let releaseChanges!: () => void;
      state.changesGate = new Promise<void>(resolve => { releaseChanges = resolve; });
      realtime.dropAll();
      await waitFor(() => !client.isSocketLive(), 'socket dropped');
      expect(existsSync(contextCacheFilePath(cacheKeys))).toBe(false);

      await waitFor(() => client.isSocketLive(), 'rejoined', 3_000);
      await sleep(30);
      expect(client.isRealtimeCaughtUp()).toBe(false);
      expect(existsSync(contextCacheFilePath(cacheKeys))).toBe(false);
      state.changesGate = null;
      releaseChanges();
      await waitFor(() => client.isRealtimeCaughtUp(), 'caught up after rejoin');
    });
  });

  it('suspension tears the socket down; the session-start pull resumes it', async () => {
    const { impl } = makeHub(realtime, { epoch: '1' });
    const client = makeClient(impl, { activePollMs: 20, idlePollMs: 20, suspendAfterMs: 80 });
    client.start();
    await waitFor(() => client.isSocketLive(), 'channel joined');

    await waitFor(() => !client.isSocketLive() && realtime.state.closes >= 1, 'suspended', 1_000);
    const joins = realtime.framesOf('phx_join').length;
    await sleep(60);
    expect(realtime.framesOf('phx_join')).toHaveLength(joins); // no churn while suspended

    await client.pullOnce({ force: true });
    await waitFor(() => client.isSocketLive(), 'resumed');
  });
});
