// SPDX-License-Identifier: Apache-2.0
//
// Splice utilities for rewrite stages (plan Phase 10 task 2, D7.3): each
// edits a body by replacing byte ranges found by the Phase 3 scanner, never
// by JSON.parse → JSON.stringify, so every byte outside the edit goes
// upstream exactly as the agent wrote it. The helpers mirror magpie's raw
// splices (MIT, Copyright (c) 2026 yetone): `rewriteModel`
// internal/gateway/gateway.go:5370-5387 (one value), `deepseekToolPatterns`
// deepseek_schema.go:14-58 (many targets into a new buffer),
// `thinkingOffUnlessAsked` anthropic.go:220-242 (a member appended before
// the closing brace), `withoutBillingLine` billing_line.go:40-102 (an array
// element removed).
//
// Every helper returns a NEW buffer when it changes something and the SAME
// buffer when it does not, so `result === input` tells a caller nothing
// changed. Every helper is idempotent: applied to its own output with the
// same arguments it changes nothing more. Each reads one level of one
// container (arrayElements / objectMembers), which costs that container's
// bytes, so a stage that edits a few containers stays linear in the body.

import { applyByteSplices, type ByteSplice } from './byte-splices.js';
import {
  JsonScanError,
  arrayElements,
  objectMembers,
  scanDocument,
  type JsonSpan,
} from './scanner.js';
import { jsonEscapeString } from './string-walker.js';

const utf8Encoder = new TextEncoder();

/**
 * `text` as a JSON string literal, quotes included. JSON.stringify of a
 * string never escapes `<`, `>` or `&` (Go's encoder does, which is why
 * magpie needs `encodeJSONStringNoHTMLEscape`), so injected text keeps the
 * bytes a vendor's cache saw.
 */
export function encodeJsonString(text: string): string {
  return `"${jsonEscapeString(text)}"`;
}

/** UTF-8 bytes of a JSON value given as text; throws (fail fast) when it is not exactly one JSON value. */
function jsonValueBytes(valueJson: string | Uint8Array): Uint8Array {
  const bytes = typeof valueJson === 'string' ? utf8Encoder.encode(valueJson) : valueJson;
  scanDocument(bytes);
  return bytes;
}

function bytesEqual(bytes: Uint8Array, start: number, end: number, other: Uint8Array): boolean {
  if (end - start !== other.length) return false;
  for (let index = 0; index < other.length; index++) {
    if (bytes[start + index] !== other[index]) return false;
  }
  return true;
}

const COMMA_BYTES = utf8Encoder.encode(',');
const COLON_BYTES = utf8Encoder.encode(':');

function insertionSplice(at: number, ...pieces: Uint8Array[]): ByteSplice {
  return { start: at, end: at, replacement: Buffer.concat(pieces) };
}

/**
 * The value at `span` replaced by `replacementJson`. Unchanged (the same
 * buffer) when the bytes there already are the replacement.
 */
export function replaceSpan(bytes: Uint8Array, span: JsonSpan, replacementJson: string | Uint8Array): Uint8Array {
  const replacement = jsonValueBytes(replacementJson);
  if (bytesEqual(bytes, span.start, span.end, replacement)) return bytes;
  return applyByteSplices(bytes, [{ start: span.start, end: span.end, replacement }]);
}

function requireContainer(span: JsonSpan, type: 'array' | 'object'): void {
  if (span.type !== type) throw new JsonScanError(`not an ${type}`, span.start);
}

/**
 * `itemJson` inserted into the array at `arraySpan` so it becomes element
 * `index` (0 ≤ index ≤ length). Unchanged when element `index` already is
 * byte-identical to the item, so inserting twice is inserting once.
 */
export function insertArrayItem(bytes: Uint8Array, arraySpan: JsonSpan, index: number, itemJson: string | Uint8Array): Uint8Array {
  requireContainer(arraySpan, 'array');
  const item = jsonValueBytes(itemJson);
  const elements = [...arrayElements(bytes, arraySpan)];
  if (!Number.isInteger(index) || index < 0 || index > elements.length) {
    throw new RangeError(`array index ${index} is outside 0..${elements.length}`);
  }
  const existing = elements[index];
  if (existing && bytesEqual(bytes, existing.start, existing.end, item)) return bytes;
  let splice: ByteSplice;
  if (elements.length === 0) {
    splice = insertionSplice(arraySpan.start + 1, item);
  } else if (index === 0) {
    splice = insertionSplice(elements[0].start, item, COMMA_BYTES);
  } else {
    splice = insertionSplice(elements[index - 1].end, COMMA_BYTES, item);
  }
  return applyByteSplices(bytes, [splice]);
}

/**
 * `itemJson` appended as the array's last element. Unchanged when the last
 * element already is byte-identical to the item (twice is once, as magpie's
 * zcodeStartBody test asks of a start body).
 */
export function appendArrayItem(bytes: Uint8Array, arraySpan: JsonSpan, itemJson: string | Uint8Array): Uint8Array {
  requireContainer(arraySpan, 'array');
  const item = jsonValueBytes(itemJson);
  const elements = [...arrayElements(bytes, arraySpan)];
  const last = elements[elements.length - 1];
  if (last && bytesEqual(bytes, last.start, last.end, item)) return bytes;
  const splice = last ? insertionSplice(last.end, COMMA_BYTES, item) : insertionSplice(arraySpan.start + 1, item);
  return applyByteSplices(bytes, [splice]);
}

/**
 * Member `key` set to `valueJson` in the object at `objectSpan`: appended
 * after the last member (before any whitespace that precedes the closing
 * brace, as magpie's thinkingOffUnlessAsked appends) when absent, its value
 * replaced when present (the last duplicate, the one JSON.parse keeps).
 * Unchanged when the member already holds byte-identical bytes.
 */
export function insertObjectMember(bytes: Uint8Array, objectSpan: JsonSpan, key: string, valueJson: string | Uint8Array): Uint8Array {
  requireContainer(objectSpan, 'object');
  const value = jsonValueBytes(valueJson);
  let lastMemberEnd = -1;
  let existingValue: JsonSpan | null = null;
  for (const member of objectMembers(bytes, objectSpan)) {
    lastMemberEnd = member.value.end;
    if (member.key === key) existingValue = member.value;
  }
  if (existingValue) return replaceSpan(bytes, existingValue, value);
  const keyBytes = utf8Encoder.encode(encodeJsonString(key));
  const splice = lastMemberEnd < 0
    ? insertionSplice(objectSpan.start + 1, keyBytes, COLON_BYTES, value)
    : insertionSplice(lastMemberEnd, COMMA_BYTES, keyBytes, COLON_BYTES, value);
  return applyByteSplices(bytes, [splice]);
}

/**
 * The splices that take the elements `shouldRemove` picks out of the array,
 * commas and the whitespace between them with them; [] when it picks none.
 * For a caller that applies them together with other splices of the same
 * bytes (they touch nothing outside the array).
 */
export function arrayItemRemovalSplices(
  bytes: Uint8Array,
  arraySpan: JsonSpan,
  shouldRemove: (elementSpan: JsonSpan, index: number) => boolean,
): ByteSplice[] {
  requireContainer(arraySpan, 'array');
  const elements = [...arrayElements(bytes, arraySpan)];
  const removed = elements.map((element, index) => shouldRemove(element, index));
  if (!removed.includes(true)) return [];
  const firstKeptIndex = removed.indexOf(false);
  if (firstKeptIndex < 0) {
    // All of them: keep only the brackets.
    return [{ start: arraySpan.start + 1, end: arraySpan.end - 1, replacement: new Uint8Array(0) }];
  }
  const splices: ByteSplice[] = [];
  elements.forEach((element, index) => {
    if (!removed[index]) return;
    // Before the first kept element: the element and what follows it up to the next one.
    // After it: what precedes the element (from the previous element's end) and the element.
    splices.push(index < firstKeptIndex
      ? { start: element.start, end: elements[index + 1].start, replacement: new Uint8Array(0) }
      : { start: elements[index - 1].end, end: element.end, replacement: new Uint8Array(0) });
  });
  return splices;
}

/**
 * The elements `shouldRemove` picks taken out of the array, commas and the
 * whitespace between them with them. Idempotent when `shouldRemove` decides
 * by an element's content (what it removed is gone, so a second pass finds
 * nothing). Unchanged when it picks none; `[]` (the brackets kept) when it
 * picks all.
 */
export function removeArrayItems(
  bytes: Uint8Array,
  arraySpan: JsonSpan,
  shouldRemove: (elementSpan: JsonSpan, index: number) => boolean,
): Uint8Array {
  return applyByteSplices(bytes, arrayItemRemovalSplices(bytes, arraySpan, shouldRemove));
}
