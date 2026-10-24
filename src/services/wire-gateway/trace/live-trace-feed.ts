// SPDX-License-Identifier: Apache-2.0
//
// The live call feed behind the viewer (plan Phase 13 task 4): the last
// calls the relay made, as they start and as they end, and a few of their
// bodies. Ported from magpie's trace (internal/gateway/trace.go:28-105,
// 429-556), its recent calls (gateway.go:393-421) and their API
// (gui/trace.go:270-284, gui/providers.go:930-946); MIT, Copyright (c)
// 2026 yetone.
//
// - 60 calls are kept without bodies (magpie `traceKeep`); the oldest
//   finished one goes first, and one still going is kept unless more than
//   120 are going at once (magpie `trim`).
// - 40 calls keep their bodies (magpie's recent-calls ring), each side at
//   most 256 KiB (magpie `callBodyLimit`), marked truncated when cut, and
//   scrubbed of secrets. Bodies are kept only with recording consent, only
//   for exchanges the gateway captures (a `captureSource:'wire'` route, D6),
//   and only while the consent generation they were kept under is the
//   current one: turning recording off or `claude-mem wire clear` (which
//   bumps the generation, privacy/recording-consent.ts) clears them.
// - `trace(after, wait)` answers the calls changed after `after`, waiting
//   up to 25 s for one (magpie gui/trace.go:276-277); a cursor ahead of the
//   feed (the gateway restarted) is read as 0 (magpie trace.go:521-523).
// - Every answer names its feed (`feedId`, new each time the gateway
//   starts). A cursor sent with another feed's id is read as 0 too: a
//   restarted gateway can be past the old cursor already, and its first
//   calls would otherwise never be sent.

import { randomUUID } from 'crypto';
import { logger } from '../../../utils/logger.js';
import type { RelayExchange, RelayExchangeResult, RelayObserver, RelayResponseStart } from '../relay/relay.js';
import type { CompletedRelayExchange, RelayReplyConsumer } from '../ir/relay-reply-collection.js';
import type { WireRecordingConsent } from '../capture/turn-recorder.js';
import { scrubWireText } from '../privacy/secret-scrub.js';

/** Calls kept without bodies (plan Phase 13 task 4; magpie trace.go:25 `traceKeep`). */
export const LIVE_TRACE_KEPT_CALLS = 60;
/** Calls that keep their bodies (plan Phase 13 task 4; magpie gateway.go:418-420). */
export const LIVE_TRACE_KEPT_BODIES = 40;
/** Each side of a kept body, at most (plan Phase 13 task 4; magpie capture.go:17 `callBodyLimit`). */
export const LIVE_TRACE_BODY_MAX_BYTES = 256 * 1024;
/** The longest a long-poll waits for a change (plan Phase 13 task 4; magpie gui/trace.go:276-277). */
export const LIVE_TRACE_LONG_POLL_MS = 25_000;
/**
 * Bytes kept past the body limit until the body is scrubbed, then cut: a
 * secret that straddles the limit is still whole when the scrub looks. 16
 * KiB holds the longest secret the scrub knows, a PEM private key (a
 * 4096-bit RSA key is about 3.3 KB).
 */
const SCRUB_MARGIN_BYTES = 16 * 1024;

export interface LiveTraceCall {
  id: string;
  /** The feed's count when this call last changed. */
  seq: number;
  time: string;
  agentId: string;
  routeId: string;
  protocol: string | null;
  method: string;
  path: string;
  kind: string;
  sessionId: string;
  model?: string;
  done: boolean;
  status?: number;
  outcome?: RelayExchangeResult['outcome'];
  durationMs?: number;
  responseBytes?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** The call's bodies can be read with GET /wire/call (recording consent was on, and still is). */
  hasBodies: boolean;
}

export interface LiveTraceSnapshot {
  /** This feed, new each time the gateway starts: a client that sees it change starts its list over. */
  feedId: string;
  seq: number;
  calls: LiveTraceCall[];
  now: string;
}

export interface LiveTraceCallBodies {
  requestBody: string;
  responseBody: string;
  requestTruncated: boolean;
  responseTruncated: boolean;
}

interface BodyCapture {
  generation: number;
  requestPrefix: Uint8Array | null;
  requestBytes: number;
  responseChunks: Uint8Array[];
  responseKeptBytes: number;
  responseBytes: number;
  /** Set once the call ended: the scrubbed, cut bodies. */
  finished: LiveTraceCallBodies | null;
}

const utf8Decoder = new TextDecoder();

/** `bytes` as text, scrubbed, then cut to the limit on a character boundary. */
function scrubbedAndCut(bytes: Uint8Array, totalBytes: number): { text: string; truncated: boolean } {
  const scrubbed = scrubWireText(utf8Decoder.decode(bytes));
  const encoded = Buffer.from(scrubbed, 'utf8');
  if (encoded.length <= LIVE_TRACE_BODY_MAX_BYTES && totalBytes <= bytes.length) return { text: scrubbed, truncated: false };
  let end = Math.min(encoded.length, LIVE_TRACE_BODY_MAX_BYTES);
  while (end > 0 && end < encoded.length && (encoded[end] & 0xc0) === 0x80) end--;
  return { text: encoded.subarray(0, end).toString('utf8'), truncated: true };
}

function joined(chunks: Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export interface WireLiveTraceFeedOptions {
  /** Whether bodies may be kept, and under which generation. */
  consent: WireRecordingConsent;
  now?: () => number;
}

export class WireLiveTraceFeed {
  readonly feedId = randomUUID();
  private seq = 0;
  private readonly calls: LiveTraceCall[] = [];
  private readonly bodiesById = new Map<string, BodyCapture>();
  private readonly waiters = new Set<() => void>();
  private readonly consent: WireRecordingConsent;
  private readonly now: () => number;

  constructor(options: WireLiveTraceFeedOptions) {
    this.consent = options.consent;
    this.now = options.now ?? Date.now;
  }

  /** The relay observer that feeds this (chunks, start and end). */
  readonly relayObserver: RelayObserver = {
    onExchangeStarted: exchange => this.begin(exchange),
    onResponseStarted: (exchange, response) => this.responseStarted(exchange, response),
    onResponseChunk: (exchange, chunk) => this.responseChunk(exchange, chunk),
    onExchangeFinished: (exchange, result) => this.finish(exchange, result),
  };

  /** The reply consumer that adds a finished call's model and tokens (from the shared reply collection). */
  readonly replyConsumer: RelayReplyConsumer = {
    onExchangeCompleted: (completed: CompletedRelayExchange) => this.noteReply(completed),
  };

  private changed(call: LiveTraceCall): void {
    this.seq++;
    call.seq = this.seq;
    for (const wake of [...this.waiters]) wake();
  }

  private callOf(exchangeId: string): LiveTraceCall | undefined {
    for (let index = this.calls.length - 1; index >= 0; index--) {
      if (this.calls[index].id === exchangeId) return this.calls[index];
    }
    return undefined;
  }

  /** magpie `trim`: keep the last 60, the oldest finished first; one going stays unless more than twice that are going. */
  private trim(): void {
    while (this.calls.length > LIVE_TRACE_KEPT_CALLS) {
      let index = this.calls.findIndex(call => call.done);
      if (index < 0) {
        if (this.calls.length <= 2 * LIVE_TRACE_KEPT_CALLS) return;
        index = 0;
      }
      const [dropped] = this.calls.splice(index, 1);
      this.bodiesById.delete(dropped.id);
    }
  }

  /** Bodies kept under another consent generation, or with recording off, are gone. */
  private dropStaleBodies(consentNow?: { recordingOn: boolean; generation: number }): void {
    if (this.bodiesById.size === 0) return;
    const recordingOn = consentNow?.recordingOn ?? this.consent.isRecordingOn();
    const generation = consentNow?.generation ?? this.consent.recordingGeneration();
    for (const [id, capture] of this.bodiesById) {
      if (recordingOn && capture.generation === generation) continue;
      this.bodiesById.delete(id);
      const call = this.callOf(id);
      if (call?.hasBodies) {
        call.hasBodies = false;
        this.changed(call);
      }
    }
  }

  private begin(exchange: RelayExchange): void {
    const call: LiveTraceCall = {
      id: exchange.exchangeId,
      seq: 0,
      time: new Date(exchange.startedAt).toISOString(),
      agentId: exchange.identity.agentId,
      routeId: exchange.routeId,
      protocol: exchange.protocol,
      method: exchange.method,
      path: exchange.suffixPath,
      kind: exchange.identity.kind,
      sessionId: exchange.identity.sessionId,
      done: false,
      hasBodies: false,
    };
    if (exchange.request?.model) call.model = exchange.request.model;
    // The consent file is read once per exchange: this runs on the request's path, before it goes upstream.
    const consentNow = { recordingOn: this.consent.isRecordingOn(), generation: this.consent.recordingGeneration() };
    this.dropStaleBodies(consentNow);
    // Bodies only with consent, and only of what the gateway captures (native-first, D6).
    if (exchange.captured && exchange.decodedRequestBody && consentNow.recordingOn) {
      const keep = Math.min(exchange.decodedRequestBody.length, LIVE_TRACE_BODY_MAX_BYTES + SCRUB_MARGIN_BYTES);
      this.bodiesById.set(exchange.exchangeId, {
        generation: consentNow.generation,
        // A copy of the prefix only: the whole body can be 64 MiB. Scrubbed when the call ends, off the request's path.
        requestPrefix: exchange.decodedRequestBody.slice(0, keep),
        requestBytes: exchange.decodedRequestBody.length,
        responseChunks: [],
        responseKeptBytes: 0,
        responseBytes: 0,
        finished: null,
      });
      call.hasBodies = true;
      this.keepAtMostBodies();
    }
    this.calls.push(call);
    this.trim();
    this.changed(call);
  }

  private keepAtMostBodies(): void {
    while (this.bodiesById.size > LIVE_TRACE_KEPT_BODIES) {
      const oldestId = this.bodiesById.keys().next().value as string;
      this.bodiesById.delete(oldestId);
      const call = this.callOf(oldestId);
      if (call?.hasBodies) {
        call.hasBodies = false;
        this.changed(call);
      }
    }
  }

  private responseStarted(exchange: RelayExchange, response: RelayResponseStart): void {
    const call = this.callOf(exchange.exchangeId);
    if (!call) return;
    call.status = response.status;
    this.changed(call);
  }

  private responseChunk(exchange: RelayExchange, chunk: Uint8Array): void {
    const capture = this.bodiesById.get(exchange.exchangeId);
    if (!capture) return;
    capture.responseBytes += chunk.length;
    const room = LIVE_TRACE_BODY_MAX_BYTES + SCRUB_MARGIN_BYTES - capture.responseKeptBytes;
    if (room <= 0) return;
    // The chunk is already a copy (the relay's capture queue), so a slice of it is kept as is.
    const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
    capture.responseChunks.push(kept);
    capture.responseKeptBytes += kept.length;
  }

  private finish(exchange: RelayExchange, result: RelayExchangeResult): void {
    const call = this.callOf(exchange.exchangeId);
    const capture = this.bodiesById.get(exchange.exchangeId);
    if (capture && !capture.finished) {
      try {
        const request = capture.requestPrefix ? scrubbedAndCut(capture.requestPrefix, capture.requestBytes) : { text: '', truncated: false };
        const response = scrubbedAndCut(joined(capture.responseChunks, capture.responseKeptBytes), capture.responseBytes);
        capture.finished = { requestBody: request.text, responseBody: response.text, requestTruncated: request.truncated, responseTruncated: response.truncated };
      } catch (error) {
        // A body that cannot be scrubbed is never shown: it is dropped, and the call says so.
        logger.warn('WIRE', 'Live trace body could not be scrubbed; it is not kept', { exchangeId: exchange.exchangeId },
          error instanceof Error ? error : new Error(String(error)));
        this.bodiesById.delete(exchange.exchangeId);
        if (call) call.hasBodies = false;
      }
      capture.requestPrefix = null;
      capture.responseChunks = [];
    }
    if (!call) return;
    call.done = true;
    call.status = result.recordedStatus;
    call.outcome = result.outcome;
    call.durationMs = result.durationMs;
    call.responseBytes = result.responseBytes;
    this.trim();
    this.changed(call);
  }

  private noteReply({ exchange, collected }: CompletedRelayExchange): void {
    const call = this.callOf(exchange.exchangeId);
    const reply = collected?.reply;
    if (!call || !reply) return;
    if (reply.model) call.model = reply.model;
    call.inputTokens = reply.usage.inputTokens;
    call.outputTokens = reply.usage.outputTokens;
    call.cacheReadTokens = reply.usage.cacheReadTokens;
    call.cacheWriteTokens = reply.usage.cacheWriteTokens;
  }

  private snapshotAfter(after: number, cursorFeedId?: string): LiveTraceSnapshot {
    const cursor = after > this.seq || (cursorFeedId !== undefined && cursorFeedId !== this.feedId) ? 0 : after;
    return {
      feedId: this.feedId,
      seq: this.seq,
      calls: this.calls.filter(call => call.seq > cursor).map(call => ({ ...call })),
      now: new Date(this.now()).toISOString(),
    };
  }

  /** Answer every waiting long-poll now (the gateway is draining: a 25 s wait must not hold the stop). */
  releaseWaiters(): void {
    for (const wake of [...this.waiters]) wake();
  }

  /**
   * The calls changed after `after`, oldest first. With none, waits up to
   * `waitMs` for one, or until `signal` aborts (the client left). A
   * `cursorFeedId` that is not this feed's reads `after` as 0.
   */
  async trace(after: number, waitMs: number, signal?: AbortSignal, cursorFeedId?: string): Promise<LiveTraceSnapshot> {
    this.dropStaleBodies();
    const immediate = this.snapshotAfter(after, cursorFeedId);
    if (immediate.calls.length > 0 || waitMs <= 0 || signal?.aborted) return immediate;
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      this.waiters.add(done);
      signal?.addEventListener('abort', done);
    });
    return this.snapshotAfter(after, cursorFeedId);
  }

  /**
   * A call's bodies: `found` with them, `no_bodies` for a call kept without
   * (no consent, cleared, not captured, or still going), `not_found` for a
   * call no longer in the feed.
   */
  callBodies(id: string): { kind: 'found'; bodies: LiveTraceCallBodies } | { kind: 'no_bodies' | 'still_going' | 'not_found' } {
    this.dropStaleBodies();
    const call = this.callOf(id);
    if (!call) return { kind: 'not_found' };
    const capture = this.bodiesById.get(id);
    if (!capture) return { kind: 'no_bodies' };
    if (!capture.finished) return { kind: 'still_going' };
    return { kind: 'found', bodies: capture.finished };
  }
}

/** The long-poll wait a `wait` query asks for: any value but "" / "0" / "false" waits 25 s. */
export function liveTraceWaitMs(waitQuery: string | null): number {
  if (waitQuery === null) return 0;
  const normalized = waitQuery.trim().toLowerCase();
  return normalized === '' || normalized === '0' || normalized === 'false' ? 0 : LIVE_TRACE_LONG_POLL_MS;
}

/** GET /wire/trace and GET /wire/call. */
export function createLiveTraceHandlers(feed: WireLiveTraceFeed) {
  return {
    async trace(request: Request): Promise<Response> {
      if (request.method !== 'GET') return Response.json({ error: { type: 'invalid_request_error', message: 'GET /wire/trace only' } }, { status: 405 });
      const url = new URL(request.url);
      const afterQuery = url.searchParams.get('after');
      const after = afterQuery === null || afterQuery === '' ? 0 : Number(afterQuery);
      if (!Number.isSafeInteger(after) || after < 0) {
        return Response.json({ error: { type: 'invalid_request_error', message: 'after must be a whole number (the seq of the last answer)' } }, { status: 400 });
      }
      const snapshot = await feed.trace(after, liveTraceWaitMs(url.searchParams.get('wait')), request.signal, url.searchParams.get('feed') || undefined);
      return Response.json(snapshot, { headers: { 'cache-control': 'no-store' } });
    },
    call(request: Request): Response {
      if (request.method !== 'GET') return Response.json({ error: { type: 'invalid_request_error', message: 'GET /wire/call only' } }, { status: 405 });
      const id = new URL(request.url).searchParams.get('id') ?? '';
      const answer = feed.callBodies(id);
      const headers = { 'cache-control': 'no-store' };
      if (answer.kind === 'found') return Response.json(answer.bodies, { headers });
      const message = answer.kind === 'not_found'
        ? 'This call is no longer in the live trace.'
        : answer.kind === 'still_going'
          ? 'This call is still going; its bodies are ready once it ends.'
          : 'This call has no bodies: they are kept only with recording consent (claude-mem wire consent --record), for agents the gateway captures, and are cleared by turning recording off or claude-mem wire clear.';
      return Response.json({ error: { type: 'not_found_error', message } }, { status: 404, headers });
    },
  };
}
