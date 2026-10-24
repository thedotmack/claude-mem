// SPDX-License-Identifier: Apache-2.0
//
// The pieces every hidden-tool stitcher shares (plan Phase 12 task 2): a
// reply's SSE events as their own bytes, an event's JSON edited by byte
// splices (an event no edit touched goes out byte for byte), and usage
// added up across rounds.

import { logger } from '../../../../utils/logger.js';
import { SseEventBuffer, splitSseEvent } from '../../relay/sse-event-framing.js';
import { ScannedObject } from '../../ir/scanned-object.js';
import { arrayElements, getSpan, objectMembers, scanDocument, type JsonPath, type JsonSpan } from '../../json/scanner.js';
import { applyByteSplices } from '../../json/byte-splices.js';
import { insertObjectMember, removeArrayItems, replaceSpan } from '../../json/splice.js';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** An event's JSON being edited: each edit is a byte splice of the bytes so far. */
export class EditableEventJson {
  bytes: Uint8Array;
  private readonly original: Uint8Array;
  private scannedBytes: Uint8Array | null = null;
  private scannedRoot: ScannedObject | null = null;

  constructor(json: string | Uint8Array) {
    this.bytes = typeof json === 'string' ? utf8Encoder.encode(json) : json;
    this.original = this.bytes;
  }

  get changed(): boolean {
    return this.bytes !== this.original;
  }

  /** The root object of the bytes as they are now (scanned once per change). Throws when it is not one. */
  get root(): ScannedObject {
    if (this.scannedBytes !== this.bytes || !this.scannedRoot) {
      const root = ScannedObject.of(this.bytes, scanDocument(this.bytes));
      if (!root) throw new Error('event data is not a JSON object');
      this.scannedRoot = root;
      this.scannedBytes = this.bytes;
    }
    return this.scannedRoot;
  }

  spanAt(path: JsonPath): JsonSpan | null {
    return getSpan(this.bytes, path);
  }

  /** The value at `path` replaced; false (nothing done) when the path is absent. */
  replace(path: JsonPath, valueJson: string): boolean {
    const span = this.spanAt(path);
    if (!span) return false;
    this.bytes = replaceSpan(this.bytes, span, valueJson);
    return true;
  }

  /** Member `key` of the object at `objectPath` set to `valueJson` (added when absent). */
  set(objectPath: JsonPath, key: string, valueJson: string): void {
    const objectSpan = this.spanAt(objectPath);
    if (objectSpan?.type !== 'object') throw new Error(`no object at ${objectPath.join('.')}`);
    this.bytes = insertObjectMember(this.bytes, objectSpan, key, valueJson);
  }

  /** The array elements at `arrayPath` that `shouldRemove` picks taken out. */
  removeElements(arrayPath: JsonPath, shouldRemove: (elementSpan: JsonSpan, index: number) => boolean): void {
    const arraySpan = this.spanAt(arrayPath);
    if (arraySpan?.type !== 'array') return;
    this.bytes = removeArrayItems(this.bytes, arraySpan, shouldRemove);
  }

  /** Member `key` of the object at `objectPath` taken out (with its comma). */
  removeMember(objectPath: JsonPath, key: string): void {
    const objectSpan = this.spanAt(objectPath);
    if (objectSpan?.type !== 'object') return;
    this.bytes = removeObjectMember(this.bytes, objectSpan, key);
  }

  text(): string {
    return utf8Decoder.decode(this.bytes);
  }
}

/** One SSE event of a reply, as it came. */
export interface RawSseEvent {
  bytes: Uint8Array;
  /** The `event:` name; '' when none. */
  name: string;
  /** The JSON on its one data line, ready to edit; null for `data: [DONE]`, comments and anything else. */
  json: EditableEventJson | null;
  /** The event's text before and after its JSON (to rebuild it changed). */
  before: string;
  after: string;
  /** The data line's text when it is not JSON (`[DONE]`), else null. */
  dataText: string | null;
}

function rawSseEventOf(bytes: Uint8Array): RawSseEvent {
  let text: string;
  try {
    text = strictUtf8Decoder.decode(bytes);
  } catch {
    return { bytes, name: '', json: null, before: '', after: '', dataText: null };
  }
  const split = splitSseEvent(text);
  if (split) {
    // Scanned once here; `data: [DONE]` starts like a JSON array but is not one.
    const json = new EditableEventJson(split.data);
    try {
      void json.root;
      return { bytes, name: split.name, json, before: split.before, after: split.after, dataText: null };
    } catch {
      // Not a JSON object: told below as the data line's text.
    }
  }
  const dataLine = /^data:\s?(.*)$/m.exec(text);
  return { bytes, name: split?.name ?? '', json: null, before: '', after: '', dataText: dataLine ? dataLine[1].trim() : null };
}

/** Splits a round's body into whole SSE events as chunks arrive. */
export class RawSseEventSplitter {
  private readonly buffer = new SseEventBuffer();

  push(chunk: Uint8Array): RawSseEvent[] {
    this.buffer.append(chunk);
    return this.buffer.takeEvents().map(rawSseEventOf);
  }

  /** What is left when the body ends (an event with no blank line after it). */
  finish(): RawSseEvent[] {
    const rest = this.buffer.takeRest();
    return rest.length > 0 ? [rawSseEventOf(rest)] : [];
  }
}

/** The object at `objectSpan` without member `key` (every duplicate), commas and whitespace with it. */
export function removeObjectMember(bytes: Uint8Array, objectSpan: JsonSpan, key: string): Uint8Array {
  // The scanner's own walk: ScannedObject's map would lose order and duplicates.
  const members = [...objectMembers(bytes, objectSpan)].map(member => ({ key: member.key, start: member.keySpan.start, end: member.value.end }));
  if (!members.some(member => member.key === key)) return bytes;
  const removed = members.map(member => member.key === key);
  const firstKeptIndex = removed.indexOf(false);
  if (firstKeptIndex < 0) return applyByteSplices(bytes, [{ start: objectSpan.start + 1, end: objectSpan.end - 1, replacement: new Uint8Array(0) }]);
  const splices = members.flatMap((member, index) => {
    if (!removed[index]) return [];
    return index < firstKeptIndex
      ? [{ start: member.start, end: members[index + 1].start, replacement: new Uint8Array(0) }]
      : [{ start: members[index - 1].end, end: member.end, replacement: new Uint8Array(0) }];
  });
  return applyByteSplices(bytes, splices);
}

/** The JSON text with member `key` of its root object taken out. */
export function withoutRootMember(json: string, key: string): string {
  const bytes = utf8Encoder.encode(json);
  return utf8Decoder.decode(removeObjectMember(bytes, scanDocument(bytes), key));
}

/** The event rebuilt around new JSON; the event's own bytes when the JSON did not change. */
export function eventWithJson(event: RawSseEvent, json: EditableEventJson): Uint8Array {
  if (!json.changed) return event.bytes;
  return utf8Encoder.encode(`${event.before}${json.text()}${event.after}`);
}

/** A new SSE event: `event: <name>` when it has one, then its data line. */
export function sseEventBytes(name: string, dataJson: string): Uint8Array {
  return utf8Encoder.encode(name ? `event: ${name}\ndata: ${dataJson}\n\n` : `data: ${dataJson}\n\n`);
}

// ---------------------------------------------------------------------------
// Usage across rounds

type UsageObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is UsageObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `later`'s numbers over `earlier`'s, member by member (Anthropic's message_delta usage over message_start's). */
export function overlayUsage(earlier: unknown, later: unknown): UsageObject {
  const result: UsageObject = isPlainObject(earlier) ? { ...earlier } : {};
  if (!isPlainObject(later)) return result;
  for (const [key, value] of Object.entries(later)) {
    if (isPlainObject(value)) result[key] = overlayUsage(result[key], value);
    else if (typeof value === 'number') result[key] = value;
    else if (!(key in result)) result[key] = value;
  }
  return result;
}

/** Every number of `first` and `second` added, member by member; other values from `second`, else `first`. */
export function addUsage(first: unknown, second: unknown): UsageObject {
  const result: UsageObject = isPlainObject(first) ? { ...first } : {};
  if (!isPlainObject(second)) return result;
  for (const [key, value] of Object.entries(second)) {
    const existing = result[key];
    if (typeof value === 'number') result[key] = (typeof existing === 'number' ? existing : 0) + value;
    else if (isPlainObject(value)) result[key] = addUsage(existing, value);
    else if (value !== null || !(key in result)) result[key] = value;
  }
  return result;
}

/**
 * A usage value as an object: {} when there is none (absent or null), null
 * when there is one that cannot be read (unknown ≠ empty: a total built on
 * it would be wrong).
 */
export function decodedUsage(rawJson: string | undefined): UsageObject | null {
  if (rawJson === undefined) return {};
  try {
    const value = JSON.parse(rawJson) as unknown;
    if (value === null) return {};
    if (isPlainObject(value)) return value;
  } catch {
    // Told below.
  }
  logger.warn('WIRE', 'memory_search: a round\'s usage could not be read; the reply keeps the provider\'s own usage', {});
  return null;
}

/**
 * The usage of the rounds before the one now streaming. The client's last
 * usage report is the sum of every round; when one round's could not be
 * read, the sum is unknown and the provider's own report goes as it is.
 */
export class UsageAcrossRounds {
  private earlier: UsageObject = {};
  private earlierRounds = 0;
  private unknown = false;

  /** A round that the loop goes on from. */
  addRound(usage: UsageObject | null): void {
    this.earlierRounds++;
    if (usage === null) this.unknown = true;
    else this.earlier = addUsage(this.earlier, usage);
  }

  /** Whether a report must carry earlier rounds' usage. */
  get hasEarlierRounds(): boolean {
    return this.earlierRounds > 0;
  }

  /** `current` with every earlier round's usage added; null when any of them is unknown (leave the report as it came). */
  totalWith(current: UsageObject | null): UsageObject | null {
    if (this.unknown || current === null) return null;
    return addUsage(this.earlier, current);
  }
}

// ---------------------------------------------------------------------------
// Rounds

/** One call of the hidden tool, as the model made it. */
export interface HiddenToolCall {
  callId: string;
  /** Gemini: the function's name (its result names it). */
  name: string;
  argsJson: string;
}

export interface HiddenToolResult {
  call: HiddenToolCall;
  text: string;
  isError: boolean;
}

export interface StitchRoundOutcome {
  /** The round ended in calls of the hidden tool only, and its end was withheld: the loop goes on. */
  continues: boolean;
  hiddenCalls: HiddenToolCall[];
}

/**
 * One protocol's stitcher: it sees each round's reply, forwards what is not
 * the hidden tool's (renumbered to stay contiguous), and builds the next
 * round's request. A round ends in one of three ways: the model called only
 * the hidden tool (its end is withheld, the loop goes on), it called the
 * agent's tools too or none (its end goes out: the model's own stop), or it
 * may not search again (its end goes out as a plain stop).
 */
export interface ProtocolStitcher {
  /** A round starts; `maySearchAgain` false means its hidden-only end goes out as a plain stop. */
  startRound(round: number, maySearchAgain: boolean): void;
  /** One event of a streamed round: the bytes for the client now. */
  streamEvent(event: RawSseEvent): Uint8Array[];
  /** The streamed round's body ended: anything still held, and how the round ended. */
  endStreamRound(): StitchRoundOutcome & { held?: Uint8Array[] };
  /** A whole (non-stream) round's JSON. */
  wholeRound(json: Uint8Array): StitchRoundOutcome;
  /** After the last whole round: the one reply the client gets. */
  mergedWholeReply(): Uint8Array;
  /** The next round's request: `previousBody`, then the assistant turn as received, then the results. */
  nextRequestBody(previousBody: Uint8Array, results: HiddenToolResult[]): Uint8Array;
  /** What keeps the client's idle timer from firing while searches and the next round run; null: nothing (Gemini). */
  keepalive(): Uint8Array | null;
  /** An error in the protocol's own JSON shape (a later round failed). */
  errorJson(message: string): string;
  /** That error as the stream's event. */
  errorEvent(message: string): Uint8Array;
}

/** Text that follows earlier text across a search goes on after a blank line (as magpie's loop does, search.go:942-948). */
export function textAfterGap(text: string): string {
  return `\n\n${text.replace(/^\n+/, '')}`;
}

// ---------------------------------------------------------------------------
// The next round's request

/**
 * `itemsJson` appended after the array's last element by one insertion, so
 * every byte of the body before stays as it was (the request the vendor
 * cached). Each item must be one JSON value.
 */
export function appendArrayItems(bytes: Uint8Array, arraySpan: JsonSpan, itemsJson: string[]): Uint8Array {
  if (arraySpan.type !== 'array') throw new Error('not an array');
  if (itemsJson.length === 0) return bytes;
  for (const itemJson of itemsJson) scanDocument(utf8Encoder.encode(itemJson));
  let lastEnd = -1;
  for (const element of arrayElements(bytes, arraySpan)) lastEnd = element.end;
  const joined = itemsJson.join(',');
  const splice = lastEnd < 0
    ? { start: arraySpan.start + 1, end: arraySpan.start + 1, replacement: utf8Encoder.encode(joined) }
    : { start: lastEnd, end: lastEnd, replacement: utf8Encoder.encode(`,${joined}`) };
  return applyByteSplices(bytes, [splice]);
}

/** The root object of a request body and the span of member `key`. */
export function rootMember(bytes: Uint8Array, key: string): { root: ScannedObject; span: JsonSpan | undefined } {
  const root = ScannedObject.of(bytes, scanDocument(bytes));
  if (!root) throw new Error('the request body is not a JSON object');
  return { root, span: root.spanOf(key) };
}
