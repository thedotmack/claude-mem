import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { addWireGatewayRoute } from '../../src/services/wire-gateway/routes.js';
import {
  FileWireRecordingConsent,
  clearWireRecordings,
  setWireRecordingConsent,
} from '../../src/services/wire-gateway/privacy/recording-consent.js';
import {
  LIVE_TRACE_BODY_MAX_BYTES,
  LIVE_TRACE_KEPT_BODIES,
  LIVE_TRACE_KEPT_CALLS,
  LIVE_TRACE_LONG_POLL_MS,
  WireLiveTraceFeed,
  createLiveTraceHandlers,
  liveTraceWaitMs,
} from '../../src/services/wire-gateway/trace/live-trace-feed.js';
import type { RelayExchange, RelayExchangeResult } from '../../src/services/wire-gateway/relay/relay.js';
import type { WireRecordingConsent } from '../../src/services/wire-gateway/capture/turn-recorder.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

// Plan Phase 13 task 4: the live trace feed. Verification: the long-poll
// returns within 25 s ± slack, and immediately when new calls arrive. Plus
// the carry item from Phase 6: clearWireRecordings clears the feed's bodies.

const testRoot = join(WIRE_GATEWAY_DIR, 'ways-in-live-trace-test');
const routesFilePath = join(testRoot, 'routes.json');
const consentFilePath = join(testRoot, 'consent.json');
const recordingsDirectory = join(testRoot, 'recordings');
const ANTHROPIC_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';

let upstream: FakeUpstream;
let gateway: StartedWireGateway;

const anthropicReply = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Hello back.' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } };

async function relay(routeId: string, text: string): Promise<void> {
  const response = await fetch(`${gateway.baseUrl}/r/${routeId}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01', 'x-claude-mem-session': 'live-session' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: text }] }),
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
}

async function trace(query: string): Promise<{ seq: number; calls: any[]; now: string }> {
  const response = await fetch(`${gateway.baseUrl}/wire/trace${query}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ seq: number; calls: any[]; now: string }>;
}

async function callBodies(id: string): Promise<{ status: number; json: any }> {
  const response = await fetch(`${gateway.baseUrl}/wire/call?id=${encodeURIComponent(id)}`);
  return { status: response.status, json: await response.json() };
}

/** The bodies are ready once the exchange's end reached the feed (off the client's path). */
async function waitForDone(id: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { calls } = await trace('?after=0');
    if (calls.find(call => call.id === id)?.done) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`call ${id} never finished`);
}

async function latestCall(): Promise<any> {
  const { calls } = await trace('?after=0');
  const call = calls.at(-1);
  await waitForDone(call.id);
  return (await trace('?after=0')).calls.find(candidate => candidate.id === call.id);
}

beforeAll(async () => {
  rmSync(testRoot, { recursive: true, force: true });
  upstream = await startFakeUpstream({ kind: 'json', body: anthropicReply });
  addWireGatewayRoute({ routeId: 'live', agentId: 'opencode', upstreamBaseUrl: upstream.url }, routesFilePath);
  addWireGatewayRoute({ routeId: 'native', agentId: 'opencode', upstreamBaseUrl: upstream.url, captureSource: 'native' }, routesFilePath);
  gateway = await startWireGatewayForTest({
    routesFilePath,
    routesReloadCheckIntervalMs: 0,
    capture: { consent: new FileWireRecordingConsent({ recordingForcedOff: false, consentFilePath }), recordingsDirectory, staleSweepIntervalMs: 0 },
  });
});

afterAll(async () => {
  await gateway.stop();
  await upstream.stop();
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  setWireRecordingConsent(false, consentFilePath);
});

describe('live trace feed over the gateway', () => {
  it('lists calls without bodies when recording consent is off; /wire/call says why', async () => {
    await relay('live', 'hello without consent');
    const call = await latestCall();
    expect(call).toMatchObject({ agentId: 'opencode', routeId: 'live', protocol: 'anthropic', method: 'POST', path: '/v1/messages', sessionId: 'live-session', done: true, status: 200, outcome: 'complete', hasBodies: false, model: 'claude-sonnet-5', inputTokens: 12, outputTokens: 3 });
    const bodies = await callBodies(call.id);
    expect(bodies.status).toBe(404);
    expect(bodies.json.error.message).toContain('recording consent');
    expect((await callBodies('no-such-call')).json.error.message).toContain('no longer in the live trace');
  });

  it('keeps scrubbed bodies with consent; clearWireRecordings clears them (the Phase 6 carry item)', async () => {
    setWireRecordingConsent(true, consentFilePath);
    await relay('live', `my key is ${ANTHROPIC_KEY}`);
    const call = await latestCall();
    expect(call.hasBodies).toBe(true);
    const bodies = await callBodies(call.id);
    expect(bodies.status).toBe(200);
    expect(bodies.json.requestTruncated).toBe(false);
    expect(bodies.json.responseTruncated).toBe(false);
    expect(bodies.json.requestBody).not.toContain(ANTHROPIC_KEY);
    expect(bodies.json.requestBody).toContain('[REDACTED');
    expect(JSON.parse(bodies.json.responseBody)).toEqual(anthropicReply);

    clearWireRecordings({ consentFilePath, recordingsDirectory });
    expect((await callBodies(call.id)).status).toBe(404);
    const after = (await trace('?after=0')).calls.find(candidate => candidate.id === call.id);
    expect(after.hasBodies).toBe(false);
  });

  it('turning recording off drops the bodies kept under it', async () => {
    setWireRecordingConsent(true, consentFilePath);
    await relay('live', 'kept for a moment');
    const call = await latestCall();
    expect((await callBodies(call.id)).status).toBe(200);
    setWireRecordingConsent(false, consentFilePath);
    expect((await callBodies(call.id)).status).toBe(404);
  });

  it('marks a body over 256 KiB truncated and cuts it there', async () => {
    setWireRecordingConsent(true, consentFilePath);
    await relay('live', 'y'.repeat(LIVE_TRACE_BODY_MAX_BYTES + 1000));
    const call = await latestCall();
    const bodies = await callBodies(call.id);
    expect(bodies.json.requestTruncated).toBe(true);
    expect(Buffer.byteLength(bodies.json.requestBody)).toBeLessThanOrEqual(LIVE_TRACE_BODY_MAX_BYTES);
    expect(bodies.json.responseTruncated).toBe(false);
  });

  it('keeps no bodies for a native route, even with consent (native-first, D6)', async () => {
    setWireRecordingConsent(true, consentFilePath);
    await relay('native', 'native route');
    const call = await latestCall();
    expect(call.routeId).toBe('native');
    expect(call.hasBodies).toBe(false);
  });

  it('a cursor ahead of the feed (a restarted gateway) reads as 0', async () => {
    const answer = await trace('?after=999999999&wait=1');
    expect(answer.calls.length).toBeGreaterThan(0);
    expect(answer.seq).toBeLessThan(999999999);
  });

  it('the long-poll returns immediately when a new call arrives', async () => {
    const { seq } = await trace('?after=0');
    const startedAt = Date.now();
    const longPoll = trace(`?after=${seq}&wait=1`);
    await new Promise(resolve => setTimeout(resolve, 300));
    await relay('live', 'wake the long-poll');
    const answer = await longPoll;
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(5_000);
    expect(answer.calls.length).toBeGreaterThan(0);
    expect(answer.calls.every(call => call.seq > seq)).toBe(true);
    expect(answer.seq).toBeGreaterThan(seq);
  });

  it(`the long-poll returns within ${LIVE_TRACE_LONG_POLL_MS / 1000} s ± slack when nothing changes`, async () => {
    const { seq } = await trace('?after=0');
    const startedAt = Date.now();
    const answer = await trace(`?after=${seq}&wait=1`);
    const elapsedMs = Date.now() - startedAt;
    expect(answer.calls).toEqual([]);
    expect(answer.seq).toBe(seq);
    expect(elapsedMs).toBeGreaterThanOrEqual(LIVE_TRACE_LONG_POLL_MS - 100);
    expect(elapsedMs).toBeLessThan(LIVE_TRACE_LONG_POLL_MS + 2_000);
  }, LIVE_TRACE_LONG_POLL_MS + 10_000);

  it('without wait it answers at once', async () => {
    const { seq } = await trace('?after=0');
    const startedAt = Date.now();
    expect((await trace(`?after=${seq}`)).calls).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(liveTraceWaitMs('1')).toBe(LIVE_TRACE_LONG_POLL_MS);
    expect(liveTraceWaitMs(null)).toBe(0);
    expect(liveTraceWaitMs('0')).toBe(0);
  });
});

describe('live trace feed rings', () => {
  const recordingOn: WireRecordingConsent = { isRecordingOn: () => true, recordingGeneration: () => 1 };

  function fakeExchange(index: number): RelayExchange {
    return {
      exchangeId: `exchange-${index}`, routeId: 'r', agentId: 'a', protocol: 'anthropic', captured: true, metered: true, method: 'POST',
      suffixPath: '/v1/messages', startedAt: Date.now(), decodedRequestBody: new TextEncoder().encode(`{"n":${index}}`),
      request: null, identity: { agentId: 'a', sessionId: 's', sessionSource: 'named', kind: 'turn', userWords: '', userTurnOrdinal: 1, turnStart: true },
      rewrite: { appliedStageNames: [], injectedTokensEst: 0, culledTokensEst: 0, forwardedRequest: null },
    };
  }
  const finished: RelayExchangeResult = { outcome: 'complete', recordedStatus: 200, captureOverflowed: false, responseBytes: 2, durationMs: 1, firstResponseChunkAt: null };

  it('names its feed, and reads a cursor from another feed (a restarted gateway) as 0', async () => {
    const feed = new WireLiveTraceFeed({ consent: recordingOn });
    for (let index = 0; index < 5; index++) {
      const exchange = fakeExchange(index);
      feed.relayObserver.onExchangeStarted!(exchange);
      feed.relayObserver.onExchangeFinished!(exchange, finished);
    }
    const everything = await feed.trace(0, 0);
    expect(everything.feedId).toBe(feed.feedId);
    expect(everything.calls).toHaveLength(5);
    expect(new WireLiveTraceFeed({ consent: recordingOn }).feedId).not.toBe(feed.feedId);
    // A cursor of this feed, below its seq: only the calls changed after it.
    const cursor = everything.calls[1].seq;
    expect((await feed.trace(cursor, 0, undefined, feed.feedId)).calls.map(call => call.id)).toEqual(['exchange-2', 'exchange-3', 'exchange-4']);
    // The same cursor from the feed before a restart: every call (the new feed may already be past the old cursor).
    expect((await feed.trace(cursor, 0, undefined, 'feed-before-restart')).calls).toHaveLength(5);
    const handlers = createLiveTraceHandlers(feed);
    const ownFeed = await (await handlers.trace(new Request(`http://gateway/wire/trace?after=${cursor}&feed=${feed.feedId}`))).json() as { feedId: string; calls: unknown[] };
    expect(ownFeed).toMatchObject({ feedId: feed.feedId });
    expect(ownFeed.calls).toHaveLength(3);
    const otherFeed = await (await handlers.trace(new Request(`http://gateway/wire/trace?after=${cursor}&feed=feed-before-restart`))).json() as { calls: unknown[] };
    expect(otherFeed.calls).toHaveLength(5);
  });

  it(`keeps the last ${LIVE_TRACE_KEPT_CALLS} calls and ${LIVE_TRACE_KEPT_BODIES} bodies`, async () => {
    const feed = new WireLiveTraceFeed({ consent: recordingOn });
    for (let index = 0; index < 100; index++) {
      const exchange = fakeExchange(index);
      feed.relayObserver.onExchangeStarted!(exchange);
      feed.relayObserver.onResponseChunk!(exchange, new TextEncoder().encode('{}'));
      feed.relayObserver.onExchangeFinished!(exchange, finished);
    }
    const { calls } = await feed.trace(0, 0);
    expect(calls).toHaveLength(LIVE_TRACE_KEPT_CALLS);
    expect(calls[0].id).toBe('exchange-40');
    expect(calls.filter(call => call.hasBodies)).toHaveLength(LIVE_TRACE_KEPT_BODIES);
    expect(feed.callBodies('exchange-99')).toEqual({ kind: 'found', bodies: { requestBody: '{"n":99}', responseBody: '{}', requestTruncated: false, responseTruncated: false } });
    expect(feed.callBodies('exchange-50').kind).toBe('no_bodies');
  });

  it('keeps a call still going over finished ones, up to twice the ring', async () => {
    const feed = new WireLiveTraceFeed({ consent: recordingOn });
    const going = fakeExchange(0);
    feed.relayObserver.onExchangeStarted!(going);
    for (let index = 1; index <= 80; index++) {
      const exchange = fakeExchange(index);
      feed.relayObserver.onExchangeStarted!(exchange);
      feed.relayObserver.onExchangeFinished!(exchange, finished);
    }
    const { calls } = await feed.trace(0, 0);
    expect(calls).toHaveLength(LIVE_TRACE_KEPT_CALLS);
    expect(calls[0]).toMatchObject({ id: 'exchange-0', done: false });
    // Its body went with the 40 newer ones; a call still going has none to read yet.
    expect(feed.callBodies('exchange-0').kind).toBe('no_bodies');
    const fresh = new WireLiveTraceFeed({ consent: recordingOn });
    fresh.relayObserver.onExchangeStarted!(going);
    expect(fresh.callBodies('exchange-0').kind).toBe('still_going');
  });

  it('keeps no body of a call that started without consent, even when consent is on by its end (consent is read at call start)', async () => {
    let recording = false;
    const toggled: WireRecordingConsent = { isRecordingOn: () => recording, recordingGeneration: () => 1 };
    const feed = new WireLiveTraceFeed({ consent: toggled });
    const exchange = fakeExchange(1);
    feed.relayObserver.onExchangeStarted!(exchange);
    recording = true;
    feed.relayObserver.onResponseChunk!(exchange, new TextEncoder().encode('{"reply":"secret-ish"}'));
    feed.relayObserver.onExchangeFinished!(exchange, finished);
    expect(feed.callBodies('exchange-1').kind).toBe('no_bodies');
    expect((await feed.trace(0, 0)).calls[0].hasBodies).toBe(false);
  });

  it('keeps no body of an exchange the gateway does not capture, even with consent', async () => {
    const feed = new WireLiveTraceFeed({ consent: recordingOn });
    const exchange = { ...fakeExchange(2), captured: false };
    feed.relayObserver.onExchangeStarted!(exchange);
    feed.relayObserver.onResponseChunk!(exchange, new TextEncoder().encode('{}'));
    feed.relayObserver.onExchangeFinished!(exchange, finished);
    expect(feed.callBodies('exchange-2').kind).toBe('no_bodies');
    expect((await feed.trace(0, 0)).calls[0].hasBodies).toBe(false);
  });

  it('a long-poll ends when its client leaves', async () => {
    const feed = new WireLiveTraceFeed({ consent: recordingOn });
    const controller = new AbortController();
    const startedAt = Date.now();
    const answer = feed.trace(0, LIVE_TRACE_LONG_POLL_MS, controller.signal);
    setTimeout(() => controller.abort(), 50);
    expect((await answer).calls).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe('live trace and the drain', () => {
  it('a waiting long-poll is answered at once when the gateway stops, so it never holds the drain', async () => {
    const stopping = await startWireGatewayForTest();
    const longPoll = fetch(`${stopping.baseUrl}/wire/trace?after=0&wait=1`).then(response => response.json());
    await new Promise(resolve => setTimeout(resolve, 100));
    const startedAt = Date.now();
    await stopping.stop();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect((await longPoll).calls).toEqual([]);
  });
});
