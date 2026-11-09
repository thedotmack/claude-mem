// SPDX-License-Identifier: Apache-2.0
//
// A comment-preserving JSON/JSONC editor (plan Phase 7 task 3). Ported from
// magpie internal/edit/json.go:20-363 (MIT, Copyright (c) 2026 yetone):
// comments and trailing commas are blanked in a copy of identical length, the
// Phase 3 byte-offset scanner finds spans in that copy, and the original bytes
// are spliced at those offsets. The file is never re-serialized.

import { applyByteSplices, type ByteSplice } from '../json/byte-splices.js';
import { JsonScanError, arrayElements, decodeValue, objectMembers, scanDocument, type JsonObjectMember, type JsonSpan } from '../json/scanner.js';
import {
  assertPlainConfigValue,
  decodeConfigText,
  editConfigTextPreservingShape,
  keysOverlap,
  nestUnderKeys,
  splitConfigKeyPath,
  type ConfigKeyPathSegment,
  type ConfigPatch,
} from './text-shape.js';

const SPACE = 0x20;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SLASH = 0x2f;
const STAR = 0x2a;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const CLOSE_BRACKET = 0x5d;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true });

function isJsonWhitespace(byte: number): boolean {
  return byte === SPACE || byte === TAB || byte === LINE_FEED || byte === CARRIAGE_RETURN;
}

/**
 * A copy of `bytes` with `//` and `/* *\/` comments and trailing commas turned
 * into spaces (line breaks inside block comments kept), so every offset in the
 * copy is the same byte in the original. One linear pass each.
 */
export function blankJsoncCommentsAndTrailingCommas(bytes: Uint8Array): Uint8Array {
  const blanked = Uint8Array.from(bytes);
  let position = 0;
  while (position < blanked.length) {
    const byte = blanked[position];
    if (byte === QUOTE) {
      position++;
      while (position < blanked.length && blanked[position] !== QUOTE) {
        position += blanked[position] === BACKSLASH ? 2 : 1;
      }
      position++;
      continue;
    }
    if (byte === SLASH && blanked[position + 1] === SLASH) {
      while (position < blanked.length && blanked[position] !== LINE_FEED && blanked[position] !== CARRIAGE_RETURN) {
        blanked[position++] = SPACE;
      }
      continue;
    }
    if (byte === SLASH && blanked[position + 1] === STAR) {
      const commentStart = position;
      position += 2;
      while (position < blanked.length && !(blanked[position] === STAR && blanked[position + 1] === SLASH)) position++;
      if (position >= blanked.length) throw new JsonScanError('unterminated block comment', commentStart);
      position += 2;
      for (let index = commentStart; index < position; index++) {
        if (blanked[index] !== LINE_FEED && blanked[index] !== CARRIAGE_RETURN) blanked[index] = SPACE;
      }
      continue;
    }
    position++;
  }
  // Trailing commas: a comma whose next non-whitespace byte closes a container.
  let pendingCommaPosition = -1;
  position = 0;
  while (position < blanked.length) {
    const byte = blanked[position];
    if (byte === QUOTE) {
      pendingCommaPosition = -1;
      position++;
      while (position < blanked.length && blanked[position] !== QUOTE) {
        position += blanked[position] === BACKSLASH ? 2 : 1;
      }
      position++;
      continue;
    }
    if (isJsonWhitespace(byte)) {
      position++;
      continue;
    }
    if ((byte === CLOSE_BRACE || byte === CLOSE_BRACKET) && pendingCommaPosition !== -1) {
      blanked[pendingCommaPosition] = SPACE;
    }
    pendingCommaPosition = byte === COMMA ? position : -1;
    position++;
  }
  return blanked;
}

interface ScannedJsoncDocument {
  original: Uint8Array;
  blanked: Uint8Array;
  root: JsonSpan;
  /** Filled on first use (lineFeedPositions, indentUnitAt). */
  lineFeeds?: number[];
  tabIndented?: boolean;
}

/**
 * Refuses invalid JSON/JSONC and a top level that is neither an object nor an
 * array. A top-level array (VS Code's chatLanguageModels.json) is edited only
 * through key paths that start with an index or `*` (requireAddressableRoot).
 */
function scanJsoncDocument(original: Uint8Array): ScannedJsoncDocument {
  let blanked: Uint8Array;
  let root: JsonSpan;
  try {
    blanked = blankJsoncCommentsAndTrailingCommas(original);
    root = scanDocument(blanked);
  } catch (error) {
    throw new Error(`invalid JSON/JSONC: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (root.type !== 'object' && root.type !== 'array') throw new Error('the top level is not a JSON object');
  return { original, blanked, root };
}

const ARRAY_INDEX_PATTERN = /^(?:0|[1-9][0-9]{0,14})$/;

/**
 * The array index a key-path segment names: canonical decimal only (`0`,
 * `12`; not `01`, `-1`, `1e2`), so one segment never names two elements.
 * A segment is an index only where the value it steps into is an array; in
 * an object the same segment is a key.
 */
function arrayIndexOf(key: string): number | null {
  return ARRAY_INDEX_PATTERN.test(key) ? Number(key) : null;
}

/** The element at `index`, or null past the end. Walks the array once, up to the index. */
function elementAt(document: ScannedJsoncDocument, arraySpan: JsonSpan, index: number): JsonSpan | null {
  let position = 0;
  for (const element of arrayElements(document.blanked, arraySpan)) {
    if (position === index) return element;
    position++;
  }
  return null;
}

/** A top-level array is addressed by index or `*` only; any other key keeps the "not an object" refusal. */
function requireAddressableRoot(document: ScannedJsoncDocument, first: { key: string; matchesAnyKey?: boolean }): void {
  if (document.root.type === 'object') return;
  if (!first.matchesAnyKey && arrayIndexOf(first.key) === null) throw new Error('the top level is not a JSON object');
}

/**
 * The member a key names in an object. A read takes the last of a duplicated
 * key, as JSON.parse does; an edit refuses a key written twice in one object:
 * which copy an agent reads is the agent's choice, so the file is left for a
 * person to fix.
 */
function memberNamed(document: ScannedJsoncDocument, objectSpan: JsonSpan, key: string, forEdit: boolean): JsonObjectMember | null {
  let found: JsonObjectMember | null = null;
  for (const member of objectMembers(document.blanked, objectSpan)) {
    if (member.key !== key) continue;
    if (found && forEdit) throw new Error(`"${key}" is written twice in one object; edit the file by hand`);
    found = member;
  }
  return found;
}

/** The value a key steps into from `container` (object member, or array element by index), or null. */
function childSpan(document: ScannedJsoncDocument, container: JsonSpan, key: string, forEdit: boolean): JsonSpan | null {
  if (container.type === 'object') return memberNamed(document, container, key, forEdit)?.value ?? null;
  if (container.type === 'array') {
    const index = arrayIndexOf(key);
    return index === null ? null : elementAt(document, container, index);
  }
  return null;
}

/** The value literal `keys` reach from the root, or null. */
function spanAtKeys(document: ScannedJsoncDocument, keys: readonly string[], forEdit: boolean): JsonSpan | null {
  let current: JsonSpan | null = document.root;
  for (const key of keys) {
    current = childSpan(document, current, key, forEdit);
    if (!current) return null;
  }
  return current;
}

/** A key path match: the literal keys it took (array indexes as decimal strings) and the value it reached. */
interface JsoncKeyPathMatch {
  keys: string[];
  value: unknown;
}

interface SpanMatch {
  keys: string[];
  span: JsonSpan;
}

/** Every match of `segments` (reads only: a duplicated key resolves to its last value). */
function resolveSpans(document: ScannedJsoncDocument, segments: ConfigKeyPathSegment[]): SpanMatch[] {
  let frontier: SpanMatch[] = [{ keys: [], span: document.root }];
  for (const segment of segments) {
    const next: SpanMatch[] = [];
    for (const match of frontier) {
      if (segment.matchesAnyKey && match.span.type === 'object') {
        const lastByKey = new Map<string, JsonSpan>();
        for (const member of objectMembers(document.blanked, match.span)) lastByKey.set(member.key, member.value);
        for (const [key, span] of lastByKey) next.push({ keys: [...match.keys, key], span });
      } else if (segment.matchesAnyKey && match.span.type === 'array') {
        let index = 0;
        for (const element of arrayElements(document.blanked, match.span)) next.push({ keys: [...match.keys, String(index++)], span: element });
      } else if (!segment.matchesAnyKey) {
        const child = childSpan(document, match.span, segment.key, false);
        if (child) next.push({ keys: [...match.keys, segment.key], span: child });
      }
    }
    frontier = next;
  }
  return frontier;
}

/**
 * Every value a key path reaches, in document order. `*` matches each key of
 * an object (used for per-provider blocks such as `provider.*.options.baseURL`)
 * and each element of an array (`customModels.*.baseUrl`); a decimal segment
 * names one array element (`customModels.0.baseUrl`).
 */
export function resolveJsoncKeyPath(configBytes: Uint8Array, keyPath: string): JsoncKeyPathMatch[] {
  const text = decodeConfigText(configBytes);
  if (text.trim() === '') return [];
  const document = scanJsoncDocument(utf8Encoder.encode(text));
  const segments = splitConfigKeyPath(keyPath);
  requireAddressableRoot(document, segments[0]);
  return resolveSpans(document, segments).map((match) => ({
    keys: match.keys,
    value: decodeValue(document.blanked, match.span),
  }));
}

/** A key path an edit takes: literal keys only. A `*` path is expanded first (resolveJsoncKeyPath), one literal path per match. */
function splitEditKeyPath(keyPath: string): string[] {
  return splitConfigKeyPath(keyPath).map((segment) => {
    if (segment.matchesAnyKey) throw new Error(`key path "${keyPath}": "*" is for reading; edit each literal key path it reaches`);
    return segment.key;
  });
}

/** The line feeds of a document's original bytes, found once: line lookups stay O(log n) however many edits one patch makes. */
function lineFeedPositions(document: ScannedJsoncDocument): number[] {
  if (document.lineFeeds) return document.lineFeeds;
  const positions: number[] = [];
  for (let index = document.original.indexOf(LINE_FEED); index !== -1; index = document.original.indexOf(LINE_FEED, index + 1)) positions.push(index);
  document.lineFeeds = positions;
  return positions;
}

/** The index (in lineFeedPositions) of the first line feed at or after `position`. */
function lineFeedIndexAtOrAfter(document: ScannedJsoncDocument, position: number): number {
  const positions = lineFeedPositions(document);
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (positions[middle] < position) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The first line feed at or after `position`, else the document length. */
function lineFeedAtOrAfter(document: ScannedJsoncDocument, position: number): number {
  const positions = lineFeedPositions(document);
  const index = lineFeedIndexAtOrAfter(document, position);
  return index < positions.length ? positions[index] : document.original.length;
}

function lineStartBefore(document: ScannedJsoncDocument, position: number): number {
  const index = lineFeedIndexAtOrAfter(document, position);
  return index === 0 ? 0 : lineFeedPositions(document)[index - 1] + 1;
}

function indentOfLineAt(document: ScannedJsoncDocument, position: number): string {
  const bytes = document.original;
  const lineStart = lineStartBefore(document, position);
  let index = lineStart;
  while (index < bytes.length && (bytes[index] === SPACE || bytes[index] === TAB)) index++;
  return utf8Decoder.decode(bytes.subarray(lineStart, index));
}

/** The indentation step from the line after `position`, else two spaces (a tab in a tab-indented file). */
function indentUnitAt(document: ScannedJsoncDocument, position: number, baseIndent: string): string {
  const lineFeed = lineFeedAtOrAfter(document, position);
  if (lineFeed < document.original.length) {
    const nextIndent = indentOfLineAt(document, lineFeed + 1);
    if (nextIndent.length > baseIndent.length && nextIndent.startsWith(baseIndent)) return nextIndent.slice(baseIndent.length);
  }
  if (baseIndent.includes('\t')) return '\t';
  document.tabIndented ??= lineFeedPositions(document).some((position) => document.original[position + 1] === TAB);
  return document.tabIndented ? '\t' : '  ';
}

function isMultiLine(document: ScannedJsoncDocument): boolean {
  return lineFeedPositions(document).length > 0;
}

/** JSON text for `value`; on multi-line files indented to sit at `prefix` with `unit` steps (Go's MarshalIndent). */
function renderJsonValue(value: unknown, multiLine: boolean, prefix: string, unit: string): string {
  if (!multiLine) return JSON.stringify(value);
  return JSON.stringify(value, null, unit).split('\n').join(`\n${prefix}`);
}

function textSplice(start: number, end: number, replacement: string): ByteSplice {
  return { start, end, replacement: utf8Encoder.encode(replacement) };
}

/** The value at `span` replaced by `value`, indented where it sits. */
function replaceValueSplice(document: ScannedJsoncDocument, span: JsonSpan, value: unknown): ByteSplice {
  const baseIndent = indentOfLineAt(document, span.start);
  return textSplice(span.start, span.end, renderJsonValue(value, isMultiLine(document), baseIndent, indentUnitAt(document, span.start, baseIndent)));
}

/** Add `key: value` as the first member of the object at `objectSpan`, at the detected indent. */
function insertMemberFirstSplice(document: ScannedJsoncDocument, objectSpan: JsonSpan, key: string, value: unknown): ByteSplice {
  const { original, blanked } = document;
  const openBrace = objectSpan.start;
  const closeBrace = objectSpan.end - 1;
  const encodedKey = JSON.stringify(key);
  let hasMembers = false;
  for (const _member of objectMembers(blanked, objectSpan)) {
    hasMembers = true;
    break;
  }
  if (!isMultiLine(document)) {
    return textSplice(openBrace + 1, openBrace + 1, `${encodedKey}:${JSON.stringify(value)}${hasMembers ? ',' : ''}`);
  }
  const baseIndent = indentOfLineAt(document, openBrace);
  const unit = indentUnitAt(document, openBrace, baseIndent);
  const childIndent = baseIndent + unit;
  const member = `${childIndent}${encodedKey}: ${renderJsonValue(value, true, childIndent, unit)}`;
  const innerIsWhitespaceOnly = original.subarray(openBrace + 1, closeBrace).every(isJsonWhitespace);
  if (innerIsWhitespaceOnly) {
    return textSplice(openBrace, closeBrace + 1, `{\n${member}\n${baseIndent}}`);
  }
  return textSplice(openBrace + 1, openBrace + 1, `\n${member}${hasMembers ? ',' : ''}`);
}

/** The splice that sets `keys` (one or more) to `value`, walking from the root. */
function setSplice(document: ScannedJsoncDocument, keys: string[], value: unknown): ByteSplice {
  let current = document.root;
  for (let index = 0; index < keys.length; index++) {
    if (current.type === 'array') {
      // An array element is edited in place, never added or made: which slot a
      // new one takes, and what would shift, is the agent's to decide.
      const where = keys.slice(0, index).join('.') || 'the top level';
      const elementIndex = arrayIndexOf(keys[index]);
      if (elementIndex === null) throw new Error(`${where} is an array, so "${keys[index]}" names nothing there; edit the file by hand`);
      const element = elementAt(document, current, elementIndex);
      if (!element) throw new Error(`${where} has no element ${elementIndex}; edit the file by hand`);
      if (index === keys.length - 1) return replaceValueSplice(document, element, value);
      current = element;
      continue;
    }
    if (current.type !== 'object') {
      // A scalar in the way of a deeper key becomes the nested object we need.
      return replaceValueSplice(document, current, nestUnderKeys(keys.slice(index), value));
    }
    const member = memberNamed(document, current, keys[index], true);
    if (!member) return insertMemberFirstSplice(document, current, keys[index], nestUnderKeys(keys.slice(index + 1), value));
    if (index === keys.length - 1) return replaceValueSplice(document, member.value, value);
    current = member.value;
  }
  throw new Error('empty key path');
}

/** Past the line end at `position` (LF or CRLF), else `position`. */
function pastLineEnd(bytes: Uint8Array, position: number): number {
  if (bytes[position] === CARRIAGE_RETURN && bytes[position + 1] === LINE_FEED) return position + 2;
  if (bytes[position] === LINE_FEED) return position + 1;
  return position;
}

function onlyWhitespaceBetween(bytes: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    if (bytes[index] !== SPACE && bytes[index] !== TAB) return false;
  }
  return true;
}

/** The byte range that removes `member` (and the comma that joins it to its neighbors). */
function memberRemovalRange(document: ScannedJsoncDocument, member: JsonObjectMember): { start: number; end: number; precedingCommaPosition: number } {
  const { original, blanked } = document;
  let start = member.keySpan.start;
  let end = member.value.end;
  const lineStart = lineStartBefore(document, start);
  const aloneOnLine = onlyWhitespaceBetween(original, lineStart, start);
  let next = end;
  while (next < blanked.length && isJsonWhitespace(blanked[next])) next++;
  const followedByComma = blanked[next] === COMMA;
  if (followedByComma) end = next + 1;
  let precedingCommaPosition = -1;
  if (!followedByComma) {
    let previous = start;
    while (previous > 0 && isJsonWhitespace(blanked[previous - 1])) previous--;
    if (blanked[previous - 1] === COMMA) precedingCommaPosition = previous - 1;
  }
  if (aloneOnLine) {
    let afterMember = end;
    while (afterMember < original.length && (original[afterMember] === SPACE || original[afterMember] === TAB)) afterMember++;
    const lineEnd = pastLineEnd(original, afterMember);
    if (lineEnd !== afterMember || afterMember === original.length) {
      // Nothing else on the line: the whole line goes, with its line end.
      start = lineStart;
      end = lineEnd;
    } else if (lineStart > 0) {
      // A comment follows on the line: keep it, joined to the line before.
      start = lineStart - 1;
      if (start > 0 && original[start - 1] === CARRIAGE_RETURN) start--;
    }
  }
  return { start, end, precedingCommaPosition };
}

/** Remove the member at `keys`. Returns null when it is absent. */
function deleteAtKeys(original: Uint8Array, keys: string[]): Uint8Array | null {
  const document = scanJsoncDocument(original);
  requireAddressableRoot(document, { key: keys[0] });
  const parent = spanAtKeys(document, keys.slice(0, -1), true);
  if (!parent) return null;
  if (parent.type === 'array') {
    const elementIndex = arrayIndexOf(keys[keys.length - 1]);
    if (elementIndex !== null && elementAt(document, parent, elementIndex)) {
      throw new Error(`removing element ${elementIndex} of ${keys.slice(0, -1).join('.') || 'the top level'} would shift the elements after it; edit the file by hand`);
    }
    return null;
  }
  if (parent.type !== 'object') return null;
  const member = memberNamed(document, parent, keys[keys.length - 1], true);
  if (!member) return null;
  const removal = memberRemovalRange(document, member);
  const splices = [{ start: removal.start, end: removal.end, replacement: new Uint8Array(0) }];
  if (removal.precedingCommaPosition !== -1 && removal.precedingCommaPosition < removal.start) {
    splices.push({ start: removal.precedingCommaPosition, end: removal.precedingCommaPosition + 1, replacement: new Uint8Array(0) });
  }
  return collapseEmptiedObject(applyByteSplices(original, splices), keys.slice(0, -1));
}

/** An object a delete left with no members and only whitespace inside collapses to `{}`. */
function collapseEmptiedObject(bytes: Uint8Array, parentKeys: string[]): Uint8Array {
  const parent = spanAtKeys(scanJsoncDocument(bytes), parentKeys, false);
  if (!parent || parent.type !== 'object') return bytes;
  const inner = bytes.subarray(parent.start + 1, parent.end - 1);
  if (inner.length === 0 || !inner.every(isJsonWhitespace)) return bytes;
  return applyByteSplices(bytes, [textSplice(parent.start, parent.end, '{}')]);
}

/**
 * Apply sets, then deletes, to a JSON/JSONC document and return its new
 * bytes. Comments, key order, indentation, a byte order mark and all-CRLF
 * line endings are kept; only the edited members change. A set inserts a
 * missing key as the first member of its object, creating parents; a delete
 * removes the member's line, its comma and its line end, and an emptied
 * object collapses to `{}`. Key paths are literal: a `*` path is refused
 * (resolveJsoncKeyPath expands it first). A decimal segment steps into the array
 * element at that index: an element is replaced or edited inside, never
 * added, and removing one (which shifts the rest) is refused. Invalid
 * JSON/JSONC and a top level that is not an object (or an array addressed by
 * index) are refused, and the edited document is re-scanned and checked
 * before it is returned.
 */
export function patchJsoncDocument(originalBytes: Uint8Array, patch: ConfigPatch): Uint8Array {
  return editConfigTextPreservingShape(originalBytes, (text) => {
    const hasOnlyDeletes = (patch.set ?? []).length === 0;
    if (text.trim() === '') {
      if (hasOnlyDeletes) return text;
      text = '{}\n';
    }
    let bytes: Uint8Array = utf8Encoder.encode(text);
    scanJsoncDocument(bytes); // Refuse invalid input before anything else.
    const expectations: Array<{ keys: string[]; present: boolean; value?: unknown }> = [];
    for (const operation of patch.set ?? []) {
      assertPlainConfigValue(operation.value, operation.keyPath);
      const keys = splitEditKeyPath(operation.keyPath);
      const document = scanJsoncDocument(bytes);
      requireAddressableRoot(document, { key: keys[0] });
      bytes = applyByteSplices(bytes, [setSplice(document, keys, operation.value)]);
      expectations.push({ keys, present: true, value: operation.value });
    }
    for (const keyPath of patch.delete ?? []) {
      const keys = splitEditKeyPath(keyPath);
      bytes = deleteAtKeys(bytes, keys) ?? bytes;
      expectations.push({ keys, present: false });
    }
    const edited = scanJsoncDocument(bytes);
    expectations.forEach((expectation, index) => {
      // A later edit of the same, an enclosing or an enclosed path decides instead.
      for (let later = index + 1; later < expectations.length; later++) {
        if (keysOverlap(expectations[later].keys, expectation.keys)) return;
      }
      const span = spanAtKeys(edited, expectation.keys, false);
      const holds = expectation.present
        ? span !== null && Bun.deepEquals(decodeValue(edited.blanked, span), expectation.value, true)
        : span === null;
      if (!holds) throw new Error(`edited JSON does not hold the edit at ${expectation.keys.join('.')}`);
    });
    return utf8Decoder.decode(bytes);
  });
}

// --- array elements (the Library's hook lists, watches and plugin lists) ----------------------

/** The array a literal key path names (no `*`), refusing anything else: a missing key or a non-array is the caller's to handle. */
function arraySpanAt(document: ScannedJsoncDocument, keyPath: string): JsonSpan {
  const segments = splitConfigKeyPath(keyPath);
  if (segments.some((segment) => segment.matchesAnyKey)) throw new Error(`${keyPath}: an array element is added or removed at one literal key path, not a "*" path`);
  requireAddressableRoot(document, segments[0]);
  const span = spanAtKeys(document, segments.map((segment) => segment.key), true);
  if (!span) throw new Error(`${keyPath} is not in the file`);
  if (span.type !== 'array') throw new Error(`${keyPath} is not an array; edit the file by hand`);
  return span;
}

function arrayValueAt(bytes: Uint8Array, keyPath: string): unknown[] {
  const document = scanJsoncDocument(bytes);
  return decodeValue(document.blanked, arraySpanAt(document, keyPath)) as unknown[];
}

/** The first byte after `position` (spaces and tabs skipped) in the original: a trailing comma the blanked copy hides shows here. */
function nextNonBlankOnLine(bytes: Uint8Array, position: number): number {
  let index = position;
  while (index < bytes.length && (bytes[index] === SPACE || bytes[index] === TAB)) index++;
  return index;
}

/**
 * Append `value` as the last element of the array at `keyPath`, as a byte
 * splice: every other byte of the file stays (comments, the other elements'
 * formatting, a trailing-comma style). On a multi-line array the element gets
 * its own line at the last element's indent, after any comment that ends the
 * last element's line; on a one-line array it is added inline.
 */
export function appendJsoncArrayElement(originalBytes: Uint8Array, keyPath: string, value: unknown): Uint8Array {
  assertPlainConfigValue(value, keyPath);
  return editConfigTextPreservingShape(originalBytes, (text) => {
    const bytes = utf8Encoder.encode(text);
    const document = scanJsoncDocument(bytes);
    const arraySpan = arraySpanAt(document, keyPath);
    const before = decodeValue(document.blanked, arraySpan) as unknown[];
    const elements = [...arrayElements(document.blanked, arraySpan)];
    const openBracket = arraySpan.start;
    const closeBracket = arraySpan.end - 1;
    const multiLine = isMultiLine(document);
    let splices: ByteSplice[];
    if (elements.length === 0) {
      const baseIndent = indentOfLineAt(document, openBracket);
      const unit = indentUnitAt(document, openBracket, baseIndent);
      const innerIsWhitespaceOnly = bytes.subarray(openBracket + 1, closeBracket).every(isJsonWhitespace);
      if (!multiLine) splices = [textSplice(openBracket + 1, innerIsWhitespaceOnly ? closeBracket : openBracket + 1, JSON.stringify(value))];
      else if (innerIsWhitespaceOnly) splices = [textSplice(openBracket, closeBracket + 1, `[\n${baseIndent + unit}${renderJsonValue(value, true, baseIndent + unit, unit)}\n${baseIndent}]`)];
      // Only comments inside: the element goes first, the comments stay after it.
      else splices = [textSplice(openBracket + 1, openBracket + 1, `\n${baseIndent + unit}${renderJsonValue(value, true, baseIndent + unit, unit)}`)];
    } else {
      const last = elements[elements.length - 1];
      const afterLast = nextNonBlankOnLine(bytes, last.end);
      const trailingComma = bytes[afterLast] === COMMA;
      const lastStartsItsLine = onlyWhitespaceBetween(bytes, lineStartBefore(document, last.start), last.start);
      const restOfLineEnd = lineFeedAtOrAfter(document, last.end);
      // Only whitespace or comments after the last element on its line (the blanked copy shows comments as spaces).
      const lastEndsItsLine = document.blanked.subarray(trailingComma ? afterLast + 1 : last.end, restOfLineEnd).every(isJsonWhitespace);
      if (multiLine && lastStartsItsLine && lastEndsItsLine) {
        const indent = indentOfLineAt(document, last.start);
        const lineEnd = restOfLineEnd > 0 && bytes[restOfLineEnd - 1] === CARRIAGE_RETURN ? restOfLineEnd - 1 : restOfLineEnd;
        const element = `\n${indent}${renderJsonValue(value, true, indent, indentUnitAt(document, openBracket, indentOfLineAt(document, openBracket)))}${trailingComma ? ',' : ''}`;
        splices = trailingComma ? [textSplice(lineEnd, lineEnd, element)] : [textSplice(last.end, last.end, ','), textSplice(lineEnd, lineEnd, element)];
      } else {
        splices = [textSplice(trailingComma ? afterLast + 1 : last.end, trailingComma ? afterLast + 1 : last.end, `${trailingComma ? ' ' : ', '}${JSON.stringify(value)}${trailingComma ? ',' : ''}`)];
      }
    }
    const edited = applyByteSplices(bytes, splices);
    const after = arrayValueAt(edited, keyPath);
    if (!Bun.deepEquals(after, [...before, value], true)) throw new Error(`edited JSON does not hold the new element at the end of ${keyPath}`);
    return utf8Decoder.decode(edited);
  });
}

/**
 * Remove element `index` of the array at `keyPath`, as a byte splice: the
 * element's line goes when nothing else is on it (a comment after it on the
 * line stays), with the comma joining it to its neighbors; an array left with
 * only whitespace inside collapses to `[]`. Every other byte stays.
 */
export function removeJsoncArrayElement(originalBytes: Uint8Array, keyPath: string, index: number): Uint8Array {
  return editConfigTextPreservingShape(originalBytes, (text) => {
    const bytes = utf8Encoder.encode(text);
    const document = scanJsoncDocument(bytes);
    const arraySpan = arraySpanAt(document, keyPath);
    const before = decodeValue(document.blanked, arraySpan) as unknown[];
    const element = elementAt(document, arraySpan, index);
    if (!element) throw new Error(`${keyPath} has no element ${index}`);
    const { blanked } = document;
    let start = element.start;
    let end = element.end;
    let next = end;
    while (next < blanked.length && isJsonWhitespace(blanked[next])) next++;
    // A comma after the element (a separator, or a trailing comma the blanked copy hides) goes with it.
    const afterOnLine = nextNonBlankOnLine(bytes, end);
    const followedByComma = blanked[next] === COMMA || bytes[afterOnLine] === COMMA;
    if (blanked[next] === COMMA) end = next + 1;
    else if (bytes[afterOnLine] === COMMA) end = afterOnLine + 1;
    let precedingCommaPosition = -1;
    if (!followedByComma) {
      let previous = start;
      while (previous > 0 && isJsonWhitespace(blanked[previous - 1])) previous--;
      if (blanked[previous - 1] === COMMA) precedingCommaPosition = previous - 1;
    }
    const lineStart = lineStartBefore(document, start);
    const aloneOnLine = onlyWhitespaceBetween(bytes, lineStart, start);
    if (!aloneOnLine) {
      // Inline (`[a, b]`): the spaces that set the element off go with it and its comma.
      if (precedingCommaPosition !== -1 && onlyWhitespaceBetween(bytes, precedingCommaPosition + 1, start)) {
        start = precedingCommaPosition;
        precedingCommaPosition = -1;
      } else if (followedByComma) {
        end = nextNonBlankOnLine(bytes, end);
      }
    }
    if (aloneOnLine) {
      const afterElement = nextNonBlankOnLine(bytes, end);
      const lineEnd = pastLineEnd(bytes, afterElement);
      if (lineEnd !== afterElement || afterElement === bytes.length) {
        start = lineStart;
        end = lineEnd;
      } else if (lineStart > 0 && blanked.subarray(afterElement, lineFeedAtOrAfter(document, afterElement)).every(isJsonWhitespace)) {
        // A comment follows on the line: it stays, joined to the line before.
        start = lineStart - 1;
        if (start > 0 && bytes[start - 1] === CARRIAGE_RETURN) start--;
      }
    }
    const splices: ByteSplice[] = [{ start, end, replacement: new Uint8Array(0) }];
    if (precedingCommaPosition !== -1 && precedingCommaPosition < start) splices.push({ start: precedingCommaPosition, end: precedingCommaPosition + 1, replacement: new Uint8Array(0) });
    let edited = applyByteSplices(bytes, splices);
    const editedDocument = scanJsoncDocument(edited);
    const emptied = arraySpanAt(editedDocument, keyPath);
    if (edited.subarray(emptied.start + 1, emptied.end - 1).every(isJsonWhitespace)) edited = applyByteSplices(edited, [textSplice(emptied.start, emptied.end, '[]')]);
    const after = arrayValueAt(edited, keyPath);
    if (!Bun.deepEquals(after, before.filter((_entry, position) => position !== index), true)) throw new Error(`edited JSON does not hold ${keyPath} without element ${index}`);
    return utf8Decoder.decode(edited);
  });
}
