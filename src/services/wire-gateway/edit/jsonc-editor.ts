// SPDX-License-Identifier: Apache-2.0
//
// A comment-preserving JSON/JSONC editor (plan Phase 7 task 3). Ported from
// magpie internal/edit/json.go:20-363 (MIT, Copyright (c) 2026 yetone):
// comments and trailing commas are blanked in a copy of identical length, the
// Phase 3 byte-offset scanner finds spans in that copy, and the original bytes
// are spliced at those offsets. The file is never re-serialized.

import { applyByteSplices } from '../json/byte-splices.js';
import { JsonScanError, decodeValue, objectMembers, scanDocument, type JsonObjectMember, type JsonSpan } from '../json/scanner.js';
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
}

/** Refuses invalid JSON/JSONC and a top level that is not an object. */
function scanJsoncDocument(original: Uint8Array): ScannedJsoncDocument {
  let blanked: Uint8Array;
  let root: JsonSpan;
  try {
    blanked = blankJsoncCommentsAndTrailingCommas(original);
    root = scanDocument(blanked);
  } catch (error) {
    throw new Error(`invalid JSON/JSONC: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (root.type !== 'object') throw new Error('the top level is not a JSON object');
  return { original, blanked, root };
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

/** A key path match: the literal keys it took and the value span it reached. */
export interface JsoncKeyPathMatch {
  keys: string[];
  value: unknown;
}

interface SpanMatch {
  keys: string[];
  span: JsonSpan;
}

function resolveSpans(document: ScannedJsoncDocument, segments: ConfigKeyPathSegment[]): SpanMatch[] {
  let frontier: SpanMatch[] = [{ keys: [], span: document.root }];
  for (const segment of segments) {
    const next: SpanMatch[] = [];
    for (const match of frontier) {
      if (match.span.type !== 'object') continue;
      if (segment.matchesAnyKey) {
        const lastByKey = new Map<string, JsonSpan>();
        for (const member of objectMembers(document.blanked, match.span)) lastByKey.set(member.key, member.value);
        for (const [key, span] of lastByKey) next.push({ keys: [...match.keys, key], span });
      } else {
        const member = lastMemberNamed(document, match.span, segment.key);
        if (member) next.push({ keys: [...match.keys, segment.key], span: member.value });
      }
    }
    frontier = next;
  }
  return frontier;
}

/**
 * Every value a key path reaches, in document order. `*` matches each key of
 * an object (used for per-provider blocks such as `provider.*.options.baseURL`).
 */
export function resolveJsoncKeyPath(configBytes: Uint8Array, keyPath: string): JsoncKeyPathMatch[] {
  const text = decodeConfigText(configBytes);
  if (text.trim() === '') return [];
  const document = scanJsoncDocument(utf8Encoder.encode(text));
  return resolveSpans(document, splitConfigKeyPath(keyPath)).map((match) => ({
    keys: match.keys,
    value: decodeValue(document.blanked, match.span),
  }));
}

/** The keys each wildcard expands to: a concrete path per existing match of the wildcard prefix. */
function expandWildcards(document: ScannedJsoncDocument, segments: ConfigKeyPathSegment[]): string[][] {
  let lastWildcard = -1;
  segments.forEach((segment, index) => {
    if (segment.matchesAnyKey) lastWildcard = index;
  });
  if (lastWildcard === -1) return [segments.map((segment) => segment.key)];
  const literalTail = segments.slice(lastWildcard + 1).map((segment) => segment.key);
  const matches = resolveSpans(document, segments.slice(0, lastWildcard + 1));
  // Each expanded edit re-scans the document; bound the work a hostile file can cause.
  if (matches.length > MAX_WILDCARD_EXPANSIONS) {
    throw new Error(`a "*" key path matched ${matches.length} keys (more than ${MAX_WILDCARD_EXPANSIONS}); edit the file by hand`);
  }
  return matches.map((match) => [...match.keys, ...literalTail]);
}

function lineStartBefore(bytes: Uint8Array, position: number): number {
  let index = position;
  while (index > 0 && bytes[index - 1] !== LINE_FEED) index--;
  return index;
}

function indentOfLineAt(bytes: Uint8Array, position: number): string {
  const lineStart = lineStartBefore(bytes, position);
  let index = lineStart;
  while (index < bytes.length && (bytes[index] === SPACE || bytes[index] === TAB)) index++;
  return utf8Decoder.decode(bytes.subarray(lineStart, index));
}

/** The indentation step from the line after `position`, else two spaces (a tab in a tab-indented file). */
function indentUnitAt(bytes: Uint8Array, position: number, baseIndent: string): string {
  let lineFeed = position;
  while (lineFeed < bytes.length && bytes[lineFeed] !== LINE_FEED) lineFeed++;
  if (lineFeed < bytes.length) {
    const nextIndent = indentOfLineAt(bytes, lineFeed + 1);
    if (nextIndent.length > baseIndent.length && nextIndent.startsWith(baseIndent)) return nextIndent.slice(baseIndent.length);
  }
  if (baseIndent.includes('\t')) return '\t';
  for (let index = 0; index + 1 < bytes.length; index++) {
    if (bytes[index] === LINE_FEED && bytes[index + 1] === TAB) return '\t';
  }
  return '  ';
}

function isMultiLine(bytes: Uint8Array): boolean {
  return bytes.includes(LINE_FEED);
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

function spliceText(bytes: Uint8Array, start: number, end: number, replacement: string): Uint8Array {
  return applyByteSplices(bytes, [{ start, end, replacement: utf8Encoder.encode(replacement) }]);
}

/** Add `key: value` as the first member of the object at `objectSpan`, at the detected indent. */
function insertMemberFirst(document: ScannedJsoncDocument, objectSpan: JsonSpan, key: string, value: unknown): Uint8Array {
  const { original, blanked } = document;
  const openBrace = objectSpan.start;
  const closeBrace = objectSpan.end - 1;
  const encodedKey = JSON.stringify(key);
  let hasMembers = false;
  for (const _member of objectMembers(blanked, objectSpan)) {
    hasMembers = true;
    break;
  }
  if (!isMultiLine(original)) {
    return spliceText(original, openBrace + 1, openBrace + 1, `${encodedKey}:${JSON.stringify(value)}${hasMembers ? ',' : ''}`);
  }
  const baseIndent = indentOfLineAt(original, openBrace);
  const unit = indentUnitAt(original, openBrace, baseIndent);
  const childIndent = baseIndent + unit;
  const member = `${childIndent}${encodedKey}: ${renderJsonValue(value, true, childIndent, unit)}`;
  const innerIsWhitespaceOnly = original.subarray(openBrace + 1, closeBrace).every(isJsonWhitespace);
  if (innerIsWhitespaceOnly) {
    return spliceText(original, openBrace, closeBrace + 1, `{\n${member}\n${baseIndent}}`);
  }
  return spliceText(original, openBrace + 1, openBrace + 1, `\n${member}${hasMembers ? ',' : ''}`);
}

function setAtKeys(original: Uint8Array, keys: string[], value: unknown): Uint8Array {
  const document = scanJsoncDocument(original);
  let current = document.root;
  for (let index = 0; index < keys.length; index++) {
    if (current.type !== 'object') {
      // A scalar or array in the way of a deeper key becomes the nested object we need.
      const replacement = renderJsonValue(nestUnderKeys(keys.slice(index), value), isMultiLine(original), indentOfLineAt(original, current.start), indentUnitAt(original, current.start, indentOfLineAt(original, current.start)));
      return spliceText(original, current.start, current.end, replacement);
    }
    const member = onlyMemberNamed(document, current, keys[index]);
    if (!member) {
      return insertMemberFirst(document, current, keys[index], nestUnderKeys(keys.slice(index + 1), value));
    }
    if (index === keys.length - 1) {
      const baseIndent = indentOfLineAt(original, member.value.start);
      const replacement = renderJsonValue(value, isMultiLine(original), baseIndent, indentUnitAt(original, member.value.start, baseIndent));
      return spliceText(original, member.value.start, member.value.end, replacement);
    }
    current = member.value;
  }
  throw new Error('unreachable: a key path has at least one key');
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
  const lineStart = lineStartBefore(original, start);
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
  let parent: JsonSpan | null = document.root;
  for (const key of keys.slice(0, -1)) {
    const member: JsonObjectMember | null = parent.type === 'object' ? onlyMemberNamed(document, parent, key) : null;
    if (!member) return null;
    parent = member.value;
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
    const member: JsonObjectMember | null = parent && parent.type === 'object' ? lastMemberNamed(document, parent, key) : null;
    parent = member ? member.value : null;
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
 * key there. Invalid JSON/JSONC and a non-object top level are refused, and
 * the edited document is re-scanned and checked before it is returned.
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
    const expectations: Array<{ keys: string[]; present: boolean; value?: unknown }> = [];
    for (const operation of patch.set ?? []) {
      assertPlainConfigValue(operation.value, operation.keyPath);
      for (const keys of expandWildcards(scanJsoncDocument(bytes), splitConfigKeyPath(operation.keyPath))) {
        bytes = setAtKeys(bytes, keys, operation.value);
        expectations.push({ keys, present: true, value: operation.value });
      }
    }
    for (const keyPath of patch.delete ?? []) {
      for (const keys of expandWildcards(scanJsoncDocument(bytes), splitConfigKeyPath(keyPath))) {
        bytes = deleteAtKeys(bytes, keys) ?? bytes;
        expectations.push({ keys, present: false });
      }
    }
    const edited = scanJsoncDocument(bytes);
    expectations.forEach((expectation, index) => {
      // A later edit of the same, an enclosing or an enclosed path decides instead.
      const overriddenLater = expectations.slice(index + 1).some((later) => keysOverlap(later.keys, expectation.keys));
      if (overriddenLater) return;
      const [match] = resolveSpans(edited, expectation.keys.map((key) => ({ key, matchesAnyKey: false })));
      const holds = expectation.present
        ? match !== undefined && sameJsonValue(decodeValue(edited.blanked, match.span), expectation.value)
        : match === undefined;
      if (!holds) throw new Error(`edited JSON does not hold the edit at ${expectation.keys.join('.')}`);
    });
    return utf8Decoder.decode(bytes);
  });
}
