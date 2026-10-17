// SPDX-License-Identifier: Apache-2.0
//
// Puts the values back in what a vendor answers, on its way to the agent
// (plan Phase 6 task 3). Ported from magpie's `Writer` (internal/redact/
// writer.go:1-291, MIT, Copyright (c) 2026 yetone). A stream is put back
// event by event, as it comes; anything else when it is done.
//
// A placeholder a stream splits between two events ({{API_ in one text delta,
// KEY_k3v9x2mq}} in the next) is put back whole: an event whose text ends in
// what may be the start of one is held until the next, and if that one goes
// on with the same text (same event name, `type`, `item_id` and indexes, and
// the same string) the start moves over to it. Values put back inside a tool
// call's arguments (`arguments`, `partial_json`, argument deltas) go in
// JSON-escaped. Nothing is added or dropped: the agent gets the same events.

import { logger } from '../../../utils/logger.js';
import { rewriteJsonStringsInText } from '../json/string-walker.js';
import { EventStreamSniffer } from '../relay/protocols.js';
import { findSseEventEnd, splitSseEvent } from '../relay/sse-event-framing.js';
import { isKeptReplyString, valueHoldsJson, type OutboundRedactionPlaceholders } from './outbound-redaction.js';

type RestoringMode = 'undecided' | 'stream' | 'whole' | 'as_is';

/**
 * The most a reply is held to be put back: a whole (non-stream) reply, or a
 * stream's one unfinished event. Past it, what is held goes out as it came
 * and the rest of the reply is relayed untouched: the agent then sees
 * placeholders, never more than the provider saw, and the gateway's memory
 * stays bounded.
 */
export const PLACEHOLDER_RESTORE_MAX_HELD_BYTES = 32 * 1024 * 1024;

/** An event that ended in what may be the start of a placeholder. */
interface HeldEvent {
  continuationKey: string;
  path: string;
  tail: string;
  /** The event as it is, and without the tail. */
  full: string;
  cut: string;
}

const utf8Encoder = new TextEncoder();
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  if (first.length === 0) return second;
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first, 0);
  joined.set(second, first.length);
  return joined;
}

/** What says which text an event goes on with (magpie `eventCtx`). */
function eventContinuationKey(data: string): string {
  let key = '';
  rewriteJsonStringsInText(data, (path, _key, value) => {
    if (path === 'type' || path === 'item_id') key += `${path}=${value};`;
    return value;
  });
  for (const indexKey of ['"index":', '"output_index":', '"content_index":']) {
    const at = data.indexOf(indexKey);
    if (at < 0) continue;
    let end = at + indexKey.length;
    while (end < data.length && /[0-9 ]/.test(data[end])) end++;
    key += `${indexKey}${data.slice(at + indexKey.length, end)};`;
  }
  return key;
}

function hasStringAtPath(data: string, wantedPath: string): boolean {
  let found = false;
  rewriteJsonStringsInText(data, (path, _key, value) => {
    if (path === wantedPath) found = true;
    return value;
  });
  return found;
}

export interface PlaceholderRestoringResponseOptions {
  placeholders: OutboundRedactionPlaceholders;
  contentType: string | null;
  contentEncoding: string | null;
  /** Test seam; defaults to PLACEHOLDER_RESTORE_MAX_HELD_BYTES. */
  maxHeldBytes?: number;
}

/**
 * One reply's restorer: feed it the upstream chunks with `push`, then call
 * `finish`; each returns the bytes to send the agent now.
 */
export class PlaceholderRestoringResponse {
  private readonly placeholders: OutboundRedactionPlaceholders;
  private readonly contentType: string;
  private mode: RestoringMode;
  private buffered: Uint8Array = new Uint8Array(0);
  /** How far `buffered` was already searched for an event's end, less the separator's own length. */
  private searchedUpTo = 0;
  private held: HeldEvent | null = null;
  private finished = false;
  private readonly firstBytesSniffer = new EventStreamSniffer();
  private readonly maxHeldBytes: number;

  constructor(options: PlaceholderRestoringResponseOptions) {
    this.placeholders = options.placeholders;
    this.maxHeldBytes = options.maxHeldBytes ?? PLACEHOLDER_RESTORE_MAX_HELD_BYTES;
    this.contentType = (options.contentType ?? '').toLowerCase();
    const contentEncoding = (options.contentEncoding ?? '').trim().toLowerCase();
    // A compressed body is left as it is (magpie `decide`).
    if (contentEncoding !== '' && contentEncoding !== 'identity') this.mode = 'as_is';
    else if (this.contentType.includes('event-stream')) this.mode = 'stream';
    else if (this.contentType !== '') this.mode = 'whole';
    else this.mode = 'undecided';
  }

  /** True when the reply is relayed untouched (a compressed body). */
  get passesThrough(): boolean {
    return this.mode === 'as_is';
  }

  /** Settles an undecided mode from the held first bytes (the ChatGPT backend streams without saying so), then restores them. */
  private decideThenPush(chunk: Uint8Array, ended: boolean): Uint8Array[] {
    const decision = this.firstBytesSniffer.push(chunk, ended);
    if (!decision) return [];
    this.mode = decision.isEventStream ? 'stream' : 'whole';
    return decision.heldChunks.flatMap(heldChunk => this.push(heldChunk));
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.mode === 'undecided') return this.decideThenPush(chunk, false);
    if (this.mode === 'as_is') return [chunk];
    if (this.buffered.length + chunk.length > this.maxHeldBytes) return this.giveUpHolding(chunk);
    this.buffered = concatBytes(this.buffered, chunk);
    if (this.mode === 'whole') return [];
    const output: string[] = [];
    for (;;) {
      const end = findSseEventEnd(this.buffered, this.searchedUpTo);
      if (!end) {
        this.searchedUpTo = Math.max(0, this.buffered.length - 3);
        break;
      }
      const eventBytes = this.buffered.subarray(0, end.index + end.separatorLength);
      this.buffered = this.buffered.slice(end.index + end.separatorLength);
      this.searchedUpTo = 0;
      this.handleEvent(eventBytes, output);
    }
    return output.map(text => utf8Encoder.encode(text));
  }

  /** Over the bound: everything held goes out as it came, then the rest of the reply as it comes. */
  private giveUpHolding(chunk: Uint8Array): Uint8Array[] {
    logger.warn('WIRE', 'Outbound redaction: a reply is too large to hold; the rest is relayed with its placeholders', {
      heldBytes: this.buffered.length, maxHeldBytes: this.maxHeldBytes,
    });
    const output: Uint8Array[] = [];
    if (this.held) output.push(utf8Encoder.encode(this.held.full));
    this.held = null;
    output.push(this.buffered, chunk);
    this.buffered = new Uint8Array(0);
    this.mode = 'as_is';
    return output;
  }

  /** What is still held, written out (magpie `Finish`). */
  finish(): Uint8Array[] {
    if (this.finished) return [];
    const decidedOutput = this.mode === 'undecided' ? this.decideThenPush(new Uint8Array(0), true) : [];
    this.finished = true;
    return [...decidedOutput, ...this.finishDecided()];
  }

  private finishDecided(): Uint8Array[] {
    if (this.mode === 'whole') {
      const body = this.buffered;
      this.buffered = new Uint8Array(0);
      let text: string;
      try {
        text = strictUtf8Decoder.decode(body);
      } catch {
        return body.length > 0 ? [body] : [];
      }
      const restored = this.placeholders.restoreJsonText(text);
      return restored === text ? (body.length > 0 ? [body] : []) : [utf8Encoder.encode(restored)];
    }
    if (this.mode !== 'stream') return [];
    const output: Uint8Array[] = [];
    if (this.held) {
      output.push(utf8Encoder.encode(this.held.full));
      this.held = null;
    }
    if (this.buffered.length > 0) {
      const rest = this.buffered;
      this.buffered = new Uint8Array(0);
      try {
        output.push(utf8Encoder.encode(this.placeholders.restore(strictUtf8Decoder.decode(rest), false)));
      } catch {
        output.push(rest);
      }
    }
    return output;
  }

  private releaseHeld(output: string[]): void {
    if (this.held) {
      output.push(this.held.full);
      this.held = null;
    }
  }

  /** Put the values back in one event and write it, or hold it (magpie `event`). */
  private handleEvent(eventBytes: Uint8Array, output: string[]): void {
    let event: string;
    try {
      event = strictUtf8Decoder.decode(eventBytes);
    } catch {
      this.releaseHeld(output);
      output.push(new TextDecoder().decode(eventBytes));
      return;
    }
    const split = splitSseEvent(event);
    if (!split) {
      this.releaseHeld(output);
      output.push(this.placeholders.restore(event, false));
      return;
    }
    const continuationKey = `${split.name}|${eventContinuationKey(split.data)}`;
    // The start of a placeholder the last event ended in goes on here.
    let carry = '';
    let carryPath: string | null = null;
    if (this.held) {
      if (this.held.continuationKey === continuationKey && hasStringAtPath(split.data, this.held.path)) {
        output.push(this.held.cut);
        carry = this.held.tail;
        carryPath = this.held.path;
      } else {
        output.push(this.held.full);
      }
      this.held = null;
    }

    let eventType = '';
    let tailPath = '';
    let tail = '';
    let cutValue = '';
    const restored = rewriteJsonStringsInText(split.data, (path, key, value) => {
      if (path === 'type') eventType = value;
      let text = value;
      if (path === carryPath) text = carry + text;
      if (isKeptReplyString(path, key, text)) return text;
      // The tail is looked for before anything is put back, so a placeholder
      // whose last brace is still to come is not put back without it.
      const tailLength = this.placeholders.partialPlaceholderTailLength(text);
      if (tailLength > 0) {
        tailPath = path;
        tail = text.slice(text.length - tailLength);
        cutValue = this.placeholders.restore(text.slice(0, text.length - tailLength), valueHoldsJson(key, eventType));
      }
      return this.placeholders.restore(text, valueHoldsJson(key, eventType));
    });
    const restoredData = restored.ok ? restored.text : split.data;
    const full = split.before + restoredData + split.after;
    if (tail === '' || !restored.ok) {
      output.push(full);
      return;
    }
    const cutData = rewriteJsonStringsInText(restoredData, (path, _key, value) => (path === tailPath ? cutValue : value)).text;
    this.held = { continuationKey, path: tailPath, tail, full, cut: split.before + cutData + split.after };
  }
}
