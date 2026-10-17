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
  splitConfigKeyPath,
  type ConfigKeyPathSegment,
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

/** Most keys one `*` edit may touch. */
export const MAX_WILDCARD_EXPANSIONS = 1000;

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
function requireAddressableRoot(document: ScannedJsoncDocument, segments: ConfigKeyPathSegment[]): void {
  if (document.root.type === 'object') return;
  const [first] = segments;
  if (!first.matchesAnyKey && arrayIndexOf(first.key) === null) throw new Error('the top level is not a JSON object');
}

/** The value a key steps into from `container` (object member, last duplicate wins; or array element by index), or null. */
function childSpanForRead(document: ScannedJsoncDocument, container: JsonSpan, key: string): JsonSpan | null {
  if (container.type === 'object') return lastMemberNamed(document, container, key)?.value ?? null;
  if (container.type === 'array') {
    const index = arrayIndexOf(key);
    return index === null ? null : elementAt(document, container, index);
  }
  return null;
}

/** The member a key names in an object; a duplicated key resolves to its last value, as JSON.parse does. */
function lastMemberNamed(document: ScannedJsoncDocument, objectSpan: JsonSpan, key: string): JsonObjectMember | null {
  let found: JsonObjectMember | null = null;
  for (const member of objectMembers(document.blanked, objectSpan)) {
    if (member.key === key) found = member;
  }
  return found;
}

/**
 * The member a key names when the edit changes it. A key written twice in one
 * object is refused: which copy an agent reads is the agent's choice, so the
 * file is left for a person to fix.
 */
function onlyMemberNamed(document: ScannedJsoncDocument, objectSpan: JsonSpan, key: string): JsonObjectMember | null {
  let found: JsonObjectMember | null = null;
  for (const member of objectMembers(document.blanked, objectSpan)) {
    if (member.key !== key) continue;
    if (found) throw new Error(`"${key}" is written twice in one object; edit the file by hand`);
    found = member;
  }
  return found;
}

/** A key path match: the literal keys it took (array indexes as decimal strings) and the value it reached. */
export interface JsoncKeyPathMatch {
  keys: string[];
  value: unknown;
}

interface SpanMatch {
  keys: string[];
  span: JsonSpan;
}

/** Every match of `segments`. For an edit (`refuseDuplicateKeys`), a key written twice on the way is refused. */
function resolveSpans(document: ScannedJsoncDocument, segments: ConfigKeyPathSegment[], options: { refuseDuplicateKeys?: boolean } = {}): SpanMatch[] {
  let frontier: SpanMatch[] = [{ keys: [], span: document.root }];
  for (const segment of segments) {
    const next: SpanMatch[] = [];
    for (const match of frontier) {
      if (segment.matchesAnyKey && match.span.type === 'object') {
        const lastByKey = new Map<string, JsonSpan>();
        for (const member of objectMembers(document.blanked, match.span)) {
          if (options.refuseDuplicateKeys && lastByKey.has(member.key)) throw new Error(`"${member.key}" is written twice in one object; edit the file by hand`);
          lastByKey.set(member.key, member.value);
        }
        for (const [key, span] of lastByKey) next.push({ keys: [...match.keys, key], span });
      } else if (segment.matchesAnyKey && match.span.type === 'array') {
        let index = 0;
        for (const element of arrayElements(document.blanked, match.span)) next.push({ keys: [...match.keys, String(index++)], span: element });
      } else if (!segment.matchesAnyKey) {
        const child = options.refuseDuplicateKeys ? childSpanForEdit(document, match.span, segment.key) : childSpanForRead(document, match.span, segment.key);
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
  requireAddressableRoot(document, segments);
  return resolveSpans(document, segments).map((match) => ({
    keys: match.keys,
    value: decodeValue(document.blanked, match.span),
  }));
}

/** Index of the last `*` segment, or -1. */
function lastWildcardIndex(segments: ConfigKeyPathSegment[]): number {
  let lastWildcard = -1;
  segments.forEach((segment, index) => {
    if (segment.matchesAnyKey) lastWildcard = index;
  });
  return lastWildcard;
}

/**
 * Where an edit starts: one match per existing key (or array element) of the
 * wildcard prefix, each with the literal keys still to walk; a path without
 * `*` starts at the root. Keys written twice on the way are refused, as for
 * any edit.
 */
function editStartingPoints(document: ScannedJsoncDocument, segments: ConfigKeyPathSegment[]): Array<SpanMatch & { tail: string[] }> {
  requireAddressableRoot(document, segments);
  const lastWildcard = lastWildcardIndex(segments);
  if (lastWildcard === -1) return [{ keys: [], span: document.root, tail: segments.map((segment) => segment.key) }];
  const tail = segments.slice(lastWildcard + 1).map((segment) => segment.key);
  const matches = resolveSpans(document, segments.slice(0, lastWildcard + 1), { refuseDuplicateKeys: true });
  // Bound the work (and the edit) a hostile file can cause.
  if (matches.length > MAX_WILDCARD_EXPANSIONS) {
    throw new Error(`a "*" key path matched ${matches.length} keys (more than ${MAX_WILDCARD_EXPANSIONS}); edit the file by hand`);
  }
  return matches.map((match) => ({ ...match, tail }));
}

/** The line feeds of a document's original bytes, found once: line lookups stay O(log n) however many edits one patch makes. */
function lineFeedPositions(document: ScannedJsoncDocument): number[] {
  if (document.lineFeeds) return document.lineFeeds;
  const positions: number[] = [];
  for (let index = document.original.indexOf(LINE_FEED); index !== -1; index = document.original.indexOf(LINE_FEED, index + 1)) positions.push(index);
  document.lineFeeds = positions;
  return positions;
}

/** The first line feed at or after `position`, else the document length. */
function lineFeedAtOrAfter(document: ScannedJsoncDocument, position: number): number {
  const positions = lineFeedPositions(document);
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (positions[middle] < position) low = middle + 1;
    else high = middle;
  }
  return low < positions.length ? positions[low] : document.original.length;
}

function lineStartBefore(document: ScannedJsoncDocument, position: number): number {
  const positions = lineFeedPositions(document);
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (positions[middle] < position) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? 0 : positions[low - 1] + 1;
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

function nestUnderKeys(keys: string[], value: unknown): unknown {
  let nested = value;
  for (let index = keys.length - 1; index >= 0; index--) nested = { [keys[index]]: nested };
  return nested;
}

function textSplice(start: number, end: number, replacement: string): ByteSplice {
  return { start, end, replacement: utf8Encoder.encode(replacement) };
}

function spliceText(bytes: Uint8Array, start: number, end: number, replacement: string): Uint8Array {
  return applyByteSplices(bytes, [textSplice(start, end, replacement)]);
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

/**
 * The splice that sets `keys` to `value`, walking from `start` (the value at
 * `keys[0..walkedCount)`). Nothing is re-scanned, so the splices of every
 * match of one `*` path come from one scan and are applied together.
 */
function setSplice(document: ScannedJsoncDocument, start: JsonSpan, keys: string[], walkedCount: number, value: unknown): ByteSplice {
  let current = start;
  for (let index = walkedCount; index < keys.length; index++) {
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
    const member = onlyMemberNamed(document, current, keys[index]);
    if (!member) return insertMemberFirstSplice(document, current, keys[index], nestUnderKeys(keys.slice(index + 1), value));
    if (index === keys.length - 1) return replaceValueSplice(document, member.value, value);
    current = member.value;
  }
  // `*` as the last segment: the matched value itself is replaced.
  return replaceValueSplice(document, current, value);
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

/** The value a key steps into for an edit: a key written twice in one object is refused. */
function childSpanForEdit(document: ScannedJsoncDocument, container: JsonSpan, key: string): JsonSpan | null {
  if (container.type === 'object') return onlyMemberNamed(document, container, key)?.value ?? null;
  return childSpanForRead(document, container, key);
}

/** Remove the member at `keys`. Returns null when it is absent. */
function deleteAtKeys(original: Uint8Array, keys: string[]): Uint8Array | null {
  const document = scanJsoncDocument(original);
  let parent: JsonSpan | null = document.root;
  for (const key of keys.slice(0, -1)) {
    const child = childSpanForEdit(document, parent, key);
    if (!child) return null;
    parent = child;
  }
  if (parent.type === 'array') {
    const elementIndex = arrayIndexOf(keys[keys.length - 1]);
    if (elementIndex !== null && elementAt(document, parent, elementIndex)) {
      throw new Error(`removing element ${elementIndex} of ${keys.slice(0, -1).join('.') || 'the top level'} would shift the elements after it; edit the file by hand`);
    }
    return null;
  }
  if (parent.type !== 'object') return null;
  const member = onlyMemberNamed(document, parent, keys[keys.length - 1]);
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
  const document = scanJsoncDocument(bytes);
  let parent: JsonSpan | null = document.root;
  for (const key of parentKeys) {
    parent = parent ? childSpanForRead(document, parent, key) : null;
  }
  if (!parent || parent.type !== 'object') return bytes;
  const inner = bytes.subarray(parent.start + 1, parent.end - 1);
  if (inner.length === 0 || !inner.every(isJsonWhitespace)) return bytes;
  return spliceText(bytes, parent.start, parent.end, '{}');
}

export interface JsoncSetOperation {
  keyPath: string;
  value: unknown;
}

export interface JsoncPatch {
  set?: JsoncSetOperation[];
  delete?: string[];
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return Bun.deepEquals(left, right, true);
}


/**
 * Apply sets, then deletes, to a JSON/JSONC document and return its new
 * bytes. Comments, key order, indentation, a byte order mark and all-CRLF
 * line endings are kept; only the edited members change. A set inserts a
 * missing key as the first member of its object, creating parents; a delete
 * removes the member's line, its comma and its line end, and an emptied
 * object collapses to `{}`. A `*` segment applies the edit to every existing
 * key (or array element) there. A decimal segment steps into the array
 * element at that index: an element is replaced or edited inside, never
 * added, and removing one (which shifts the rest) is refused. Invalid
 * JSON/JSONC and a top level that is not an object (or an array addressed by
 * index) are refused, and the edited document is re-scanned and checked
 * before it is returned.
 */
export function patchJsoncDocument(originalBytes: Uint8Array, patch: JsoncPatch): Uint8Array {
  return editConfigTextPreservingShape(originalBytes, (text) => {
    const hasOnlyDeletes = (patch.set ?? []).length === 0;
    if (text.trim() === '') {
      if (hasOnlyDeletes) return text;
      text = '{}\n';
    }
    let bytes: Uint8Array = utf8Encoder.encode(text);
    scanJsoncDocument(bytes); // Refuse invalid input before anything else.
    const expectations: Array<{ keys: string[]; present: boolean; value?: unknown; operation: number }> = [];
    const operationSegments: ConfigKeyPathSegment[][] = [];
    for (const operation of patch.set ?? []) {
      assertPlainConfigValue(operation.value, operation.keyPath);
      const segments = splitConfigKeyPath(operation.keyPath);
      operationSegments.push(segments);
      // Every match of one `*` path is set from one scan: the work stays linear in the file.
      const document = scanJsoncDocument(bytes);
      const splices: ByteSplice[] = [];
      for (const start of editStartingPoints(document, segments)) {
        const keys = [...start.keys, ...start.tail];
        splices.push(setSplice(document, start.span, keys, start.keys.length, operation.value));
        expectations.push({ keys, present: true, value: operation.value, operation: operationSegments.length - 1 });
      }
      bytes = applyByteSplices(bytes, splices);
    }
    for (const keyPath of patch.delete ?? []) {
      const segments = splitConfigKeyPath(keyPath);
      operationSegments.push(segments);
      for (const start of editStartingPoints(scanJsoncDocument(bytes), segments)) {
        const keys = [...start.keys, ...start.tail];
        bytes = deleteAtKeys(bytes, keys) ?? bytes;
        expectations.push({ keys, present: false, operation: operationSegments.length - 1 });
      }
    }
    const edited = scanJsoncDocument(bytes);
    // What each operation's path reaches now, resolved once per operation (not once per match).
    const reachedByOperation = operationSegments.map((segments) => {
      const reached = new Map<string, JsonSpan>();
      for (const match of resolveSpans(edited, segments)) reached.set(JSON.stringify(match.keys), match.span);
      return reached;
    });
    expectations.forEach((expectation, index) => {
      // A later edit of the same, an enclosing or an enclosed path decides instead.
      for (let later = index + 1; later < expectations.length; later++) {
        if (keysOverlap(expectations[later].keys, expectation.keys)) return;
      }
      const span = reachedByOperation[expectation.operation].get(JSON.stringify(expectation.keys));
      const holds = expectation.present
        ? span !== undefined && sameJsonValue(decodeValue(edited.blanked, span), expectation.value)
        : span === undefined;
      if (!holds) throw new Error(`edited JSON does not hold the edit at ${expectation.keys.join('.')}`);
    });
    return utf8Decoder.decode(bytes);
  });
}
