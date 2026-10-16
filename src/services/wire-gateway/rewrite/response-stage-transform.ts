// SPDX-License-Identifier: Apache-2.0
//
// The reply side of the rewrite seam (plan Phase 10 task 1): a stream is
// handed to the stages' onEvent one event at a time, as it comes; a whole
// JSON reply to their onResponse once it is done. Ported from magpie's reply
// wrapper (internal/middleware/run.go:204-404, MIT, Copyright (c) 2026
// yetone): an encoded reply passes as it is, an event without one JSON data
// line passes as it is (`data: [DONE]`, comments, pings), and an event no
// stage changed goes out byte for byte. A reply too large to hold goes out
// as it came from that point on.

import { logger } from '../../../utils/logger.js';
import { findSseEventEnd, splitSseEvent } from '../relay/sse-event-framing.js';
import type { WireRewriteRun } from './rewrite-stage.js';

/** The most of a whole reply, or of one unfinished event, held for the stages. */
export const RESPONSE_STAGE_MAX_HELD_BYTES = 32 * 1024 * 1024;

type TransformMode = 'undecided' | 'stream' | 'whole' | 'as_is';

const utf8Encoder = new TextEncoder();
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (first.length === 0) return second;
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first, 0);
  joined.set(second, first.length);
  return joined;
}

export interface ResponseStageTransformOptions {
  run: WireRewriteRun;
  status: number;
  contentType: string | null;
  contentEncoding: string | null;
  /** Test seam; defaults to RESPONSE_STAGE_MAX_HELD_BYTES. */
  maxHeldBytes?: number;
}

/**
 * One reply's pass through the response stages: feed it the chunks with
 * `push`, then call `finish`; each returns the bytes to send the agent now.
 */
export class ResponseStageTransform {
  private readonly run: WireRewriteRun;
  private readonly status: number;
  private readonly maxHeldBytes: number;
  private mode: TransformMode;
  private buffered: Uint8Array = new Uint8Array(0);
  private searchedUpTo = 0;
  private finished = false;

  constructor(options: ResponseStageTransformOptions) {
    this.run = options.run;
    this.status = options.status;
    this.maxHeldBytes = options.maxHeldBytes ?? RESPONSE_STAGE_MAX_HELD_BYTES;
    const contentEncoding = (options.contentEncoding ?? '').trim().toLowerCase();
    const contentType = (options.contentType ?? '').toLowerCase();
    if (contentEncoding !== '' && contentEncoding !== 'identity') this.mode = 'as_is';
    else if (contentType.includes('event-stream')) this.mode = this.run.hasEventStages ? 'stream' : 'as_is';
    else if (contentType !== '') this.mode = this.run.hasResponseStages ? 'whole' : 'as_is';
    else this.mode = 'undecided';
  }

  /** True when nothing of this reply goes through the stages. */
  get passesThrough(): boolean {
    return this.mode === 'as_is';
  }

  private decideFromFirstBytes(first: Uint8Array): void {
    // The ChatGPT backend streams without saying so (as the placeholder restorer decides).
    const start = new TextDecoder().decode(first.subarray(0, 6));
    const looksLikeStream = start.startsWith('event:') || start.startsWith('data:') || start.startsWith(':');
    if (looksLikeStream) this.mode = this.run.hasEventStages ? 'stream' : 'as_is';
    else this.mode = this.run.hasResponseStages ? 'whole' : 'as_is';
  }

  async push(chunk: Uint8Array): Promise<Uint8Array[]> {
    if (this.mode === 'undecided') this.decideFromFirstBytes(chunk);
    if (this.mode === 'as_is') return [chunk];
    if (this.buffered.length + chunk.length > this.maxHeldBytes) return this.giveUpHolding(chunk);
    this.buffered = concatBytes(this.buffered, chunk);
    if (this.mode === 'whole') return [];
    const output: Uint8Array[] = [];
    for (;;) {
      const end = findSseEventEnd(this.buffered, this.searchedUpTo);
      if (!end) {
        this.searchedUpTo = Math.max(0, this.buffered.length - 3);
        break;
      }
      const eventBytes = this.buffered.subarray(0, end.index + end.separatorLength);
      this.buffered = this.buffered.slice(end.index + end.separatorLength);
      this.searchedUpTo = 0;
      const rewritten = await this.rewriteEvent(eventBytes);
      if (rewritten) output.push(rewritten);
    }
    return output;
  }

  private giveUpHolding(chunk: Uint8Array): Uint8Array[] {
    logger.warn('WIRE', 'A reply is too large to hold for the rewrite stages; the rest is relayed as it came', {
      heldBytes: this.buffered.length, maxHeldBytes: this.maxHeldBytes,
    });
    const output = [this.buffered, chunk];
    this.buffered = new Uint8Array(0);
    this.mode = 'as_is';
    return output;
  }

  /** One event through the stages: its bytes as they came when unchanged, null when a stage dropped it. */
  private async rewriteEvent(eventBytes: Uint8Array): Promise<Uint8Array | null> {
    let eventText: string;
    try {
      eventText = strictUtf8Decoder.decode(eventBytes);
    } catch {
      return eventBytes;
    }
    const split = splitSseEvent(eventText);
    if (!split) return eventBytes;
    const rewritten = await this.run.runEventStages({ name: split.name, dataJson: split.data }, this.status);
    if (rewritten === null) return null;
    if (rewritten.dataJson === split.data) return eventBytes;
    return utf8Encoder.encode(split.before + rewritten.dataJson + split.after);
  }

  /**
   * What is still held. `replyComplete` is false when upstream broke off:
   * a partial reply goes out as it came, never through onResponse.
   */
  async finish(replyComplete: boolean): Promise<Uint8Array[]> {
    if (this.finished) return [];
    this.finished = true;
    const held = this.buffered;
    this.buffered = new Uint8Array(0);
    if (held.length === 0) return [];
    if (this.mode === 'whole' && replyComplete) return [await this.run.runResponseStages(held, this.status)];
    return [held];
  }
}
