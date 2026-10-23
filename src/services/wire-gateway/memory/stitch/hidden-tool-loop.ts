// SPDX-License-Identifier: Apache-2.0
//
// The hidden memory_search loop (plan Phase 12 task 2), the part every
// protocol shares: read a round's reply through its protocol's stitcher,
// and when the model called only the hidden tool, run the searches, ask
// the same upstream again with the results, and stitch that round on. The
// client sees one reply. The idea is magpie's search loop
// (internal/gateway/search.go:904-1028, MIT, Copyright (c) 2026 yetone),
// which translates through its IR and streams live; the gateway never
// translates, so each protocol has a stitcher that works on the reply's
// own events.
//
// Rounds (the plan's cap, not magpie's): a round that calls only the hidden
// tool may be followed by another while its number is at most
// MAX_SEARCH_ROUNDS. Rounds 1–5 are searched; the results of round 6 say
// there will be no more searches; round 7 may not search again, so its
// hidden-only end goes out as a plain stop. So at most 5 real searches
// and 7 upstream calls per request.
//
// The client's stream is pulled: a round's reply is read only as fast as
// the client takes what was already stitched, so a slow client never makes
// the loop hold whole rounds. While the searches and the next round run,
// the client is kept alive the way its protocol is (magpie
// gateway.go:5197-5231): Anthropic `ping`, Responses `response.in_progress`,
// a Chat `: keepalive` comment, and nothing for Gemini (agy fails on any
// comment).
//
// A failure after the reply began (a later round's error status, a round
// that broke off, a stitcher bug) sends the protocol's error event and ends
// the stream without an end marker: the relay counts that a cut, and
// nothing is fabricated. A whole (non-stream) reply gets the protocol's
// error JSON instead.

import { logger } from '../../../../utils/logger.js';
import type { WireReplyStitchInput } from '../../rewrite/rewrite-stage.js';
import { RawSseEventSplitter, type HiddenToolCall, type HiddenToolResult, type ProtocolStitcher } from './stitch-events.js';

/** Rounds whose hidden-only calls are answered; the last of them is told there will be no more. */
export const MAX_SEARCH_ROUNDS = 6;
export const NO_MORE_SEARCHES_TEXT = 'No more searches: answer with what was found.';
/** How often a waiting client is kept alive (magpie keepaliveEvery). */
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;
/**
 * The most of one round held in memory: a whole (non-stream) round's reply,
 * and a streamed round's accumulated deltas (the Chat stitcher replays them).
 * The same cap as WIRE_REPLY_MAX_BYTES, far above any real round.
 */
export const WHOLE_ROUND_MAX_BYTES = 64 * 1024 * 1024;
/** The most of a failed round's body read to say why it failed. */
const FAILED_ROUND_DETAIL_MAX_BYTES = 4 * 1024;

export type HiddenToolSearch = (call: HiddenToolCall, signal: AbortSignal) => Promise<{ text: string; isError: boolean }>;

export interface HiddenToolLoopOptions {
  stitcher: ProtocolStitcher;
  mode: 'stream' | 'whole';
  input: WireReplyStitchInput;
  /** One call's search; must not throw (an error is a result with isError). */
  search: HiddenToolSearch;
  keepaliveIntervalMs?: number;
  maxSearchRounds?: number;
  /** For the log. */
  agentId?: string;
}

class LaterRoundFailed extends Error {}

function concatChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

async function boundedText(body: ReadableStream<Uint8Array>, maximumBytes: number): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < maximumBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(concatChunks(chunks, length)).slice(0, maximumBytes);
}

const sleep = (ms: number) => new Promise<'tick'>(resolve => setTimeout(() => resolve('tick'), ms));

/** The client's stream: the first round's reply with every later round stitched on. */
export function hiddenToolLoopStream(options: HiddenToolLoopOptions): ReadableStream<Uint8Array> {
  const { stitcher, mode, input, search } = options;
  const keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
  const maxSearchRounds = options.maxSearchRounds ?? MAX_SEARCH_ROUNDS;
  let cancelled = false;
  let currentReader: { cancel(): Promise<void> } | null = null;
  const gone = () => cancelled || input.signal.aborted;

  /**
   * Waits for `work`, handing out a keepalive each interval meanwhile
   * (stream only; nothing for Gemini). Yields keepalive bytes; returns the work's value.
   */
  async function* whileKeptAlive<T>(work: Promise<T>): AsyncGenerator<Uint8Array[], T> {
    const settled = work.then(value => ({ value }));
    // A failure is thrown by the await below; never left unobserved meanwhile.
    settled.catch(() => undefined);
    for (;;) {
      const next = await Promise.race([settled, sleep(keepaliveIntervalMs)]);
      if (next !== 'tick') return next.value;
      const keepalive = mode === 'stream' ? stitcher.keepalive() : null;
      if (keepalive) yield [keepalive];
    }
  }

  /** Every round's stitched bytes, one read's worth at a time. */
  async function* stitchedRounds(): AsyncGenerator<Uint8Array[], void> {
    let body = input.firstReplyBody;
    let requestBody = input.forwardedBody;
    for (let round = 1; ; round++) {
      stitcher.startRound(round, round <= maxSearchRounds);
      const reader = body.getReader();
      currentReader = reader;
      let outcome;
      if (mode === 'stream') {
        const splitter = new RawSseEventSplitter();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          yield splitter.push(value).flatMap(event => stitcher.streamEvent(event));
        }
        yield splitter.finish().flatMap(event => stitcher.streamEvent(event));
        outcome = stitcher.endStreamRound();
        if (outcome.held) yield outcome.held;
      } else {
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > WHOLE_ROUND_MAX_BYTES) throw new Error(`a round's reply is over ${WHOLE_ROUND_MAX_BYTES} bytes`);
          chunks.push(value);
        }
        outcome = stitcher.wholeRound(concatChunks(chunks, length));
      }
      if (!outcome.continues) {
        if (mode === 'whole') yield [stitcher.mergedWholeReply()];
        return;
      }
      if (gone()) return;

      const results: HiddenToolResult[] = yield* whileKeptAlive(Promise.all(outcome.hiddenCalls.map(async call => {
        if (round >= maxSearchRounds) return { call, text: NO_MORE_SEARCHES_TEXT, isError: true };
        return { call, ...await search(call, input.signal) };
      })));
      if (gone()) return;
      const nextBody = stitcher.nextRequestBody(requestBody, results);
      const response = yield* whileKeptAlive(input.askUpstreamAgain(nextBody));
      if (gone()) {
        response.body?.cancel().catch(() => undefined);
        return;
      }
      const encoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase();
      if (response.status !== 200 || !response.body || (encoding !== '' && encoding !== 'identity')) {
        const detail = response.status !== 200 && response.body ? (await boundedText(response.body, FAILED_ROUND_DETAIL_MAX_BYTES)).trim() : '';
        if (response.status === 200) response.body?.cancel().catch(() => undefined);
        throw new LaterRoundFailed(`claude-mem memory_search: round ${round + 1} failed upstream (HTTP ${response.status}${encoding ? `, ${encoding}` : ''})${detail ? `: ${detail}` : ''}`);
      }
      requestBody = nextBody;
      body = response.body;
    }
  }

  const rounds = stitchedRounds();
  let finished = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      // Enqueue at least one chunk per pull, or end: a pull that enqueues nothing is called again only if asked.
      for (;;) {
        let step: IteratorResult<Uint8Array[], void>;
        try {
          step = await rounds.next();
        } catch (error) {
          finished = true;
          if (gone()) {
            controller.close();
            return;
          }
          const failure = error instanceof Error ? error : new Error(String(error));
          if (!(failure instanceof LaterRoundFailed)) {
            logger.warn('WIRE', 'The hidden memory_search loop failed; the reply ends here', { agentId: options.agentId, error: failure.message });
          }
          input.noteFailure(failure);
          // The error goes to the client, and the stream ends without an end marker (a cut).
          controller.enqueue(mode === 'stream' ? stitcher.errorEvent(failure.message) : new TextEncoder().encode(stitcher.errorJson(failure.message)));
          controller.close();
          return;
        }
        if (step.done || gone()) {
          finished = true;
          controller.close();
          return;
        }
        const chunks = step.value.filter(chunk => chunk.length > 0);
        if (chunks.length === 0) continue;
        for (const chunk of chunks) controller.enqueue(chunk);
        return;
      }
    },
    cancel() {
      cancelled = true;
      finished = true;
      currentReader?.cancel().catch(() => undefined);
      void rounds.return(undefined).catch(() => undefined);
    },
  }, { highWaterMark: 0 });
}
