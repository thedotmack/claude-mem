// SPDX-License-Identifier: Apache-2.0
//
// What every format editor shares (plan Phase 7): a config keeps its UTF-8
// byte order mark and its line endings, and a key path is split the same way
// everywhere. magpie internal/edit/file.go:22-70 (`TrimBOM`/`keepBOM`) and
// json.go:56-66 (`keepCRLF`), MIT, Copyright (c) 2026 yetone.

const UTF8_BYTE_ORDER_MARK = [0xef, 0xbb, 0xbf] as const;

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Encoder = new TextEncoder();

function startsWithByteOrderMark(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === UTF8_BYTE_ORDER_MARK[0] && bytes[1] === UTF8_BYTE_ORDER_MARK[1] && bytes[2] === UTF8_BYTE_ORDER_MARK[2];
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) count++;
  return count;
}

/** True when the text has line breaks and every one of them is CRLF. */
export function everyLineBreakIsCrlf(text: string): boolean {
  const lineFeedCount = countOccurrences(text, '\n');
  return lineFeedCount > 0 && countOccurrences(text, '\r\n') === lineFeedCount;
}

/** The text of a config's bytes, without a leading byte order mark. Invalid UTF-8 throws. */
export function decodeConfigText(bytes: Uint8Array): string {
  const body = startsWithByteOrderMark(bytes) ? bytes.subarray(3) : bytes;
  try {
    return strictUtf8Decoder.decode(body);
  } catch {
    throw new Error('the file is not valid UTF-8; edit it by hand');
  }
}

/**
 * Edit a config's text and give back its bytes in the shape they came in:
 * the byte order mark is kept, and when every line break was CRLF the edit
 * sees LF only and every line break goes back as CRLF (a file that mixed
 * endings is left mixed; added lines get LF). `editText` sees no BOM.
 */
export function editConfigTextPreservingShape(originalBytes: Uint8Array, editText: (text: string) => string): Uint8Array {
  const hasByteOrderMark = startsWithByteOrderMark(originalBytes);
  const originalText = decodeConfigText(originalBytes);
  const crlfFile = everyLineBreakIsCrlf(originalText);
  const editableText = crlfFile ? originalText.replaceAll('\r\n', '\n') : originalText;
  const editedText = editText(editableText);
  if (editedText === editableText) return originalBytes;
  const shapedText = crlfFile ? editedText.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n') : editedText;
  const encoded = utf8Encoder.encode(shapedText);
  if (!hasByteOrderMark) return encoded;
  const withMark = new Uint8Array(encoded.length + 3);
  withMark.set(UTF8_BYTE_ORDER_MARK, 0);
  withMark.set(encoded, 3);
  return withMark;
}

/** One step of a key path: a literal key, or `*` (any key of an object). */
export interface ConfigKeyPathSegment {
  key: string;
  matchesAnyKey: boolean;
}

/**
 * Split a key path at its dots. A backslash makes the next character
 * literal, so `chat\.defaultModel` is one key (VS Code keeps dotted keys) and
 * `\*` is a key named `*`; a bare `*` segment is a wildcard.
 */
export function splitConfigKeyPath(keyPath: string): ConfigKeyPathSegment[] {
  if (keyPath === '') throw new Error('empty key path');
  const segments: ConfigKeyPathSegment[] = [];
  let key = '';
  let escapedSomething = false;
  for (let index = 0; index < keyPath.length; index++) {
    const character = keyPath[index];
    if (character === '\\') {
      if (index + 1 >= keyPath.length) throw new Error(`key path "${keyPath}" ends in a lone backslash`);
      key += keyPath[++index];
      escapedSomething = true;
    } else if (character === '.') {
      segments.push({ key, matchesAnyKey: key === '*' && !escapedSomething });
      key = '';
      escapedSomething = false;
    } else {
      key += character;
    }
  }
  segments.push({ key, matchesAnyKey: key === '*' && !escapedSomething });
  for (const segment of segments) {
    if (segment.key === '') throw new Error(`key path "${keyPath}" has an empty segment`);
  }
  return segments;
}

/** Literal keys only: TOML, YAML and .env paths take no wildcard. */
export function splitLiteralConfigKeyPath(keyPath: string): string[] {
  return splitConfigKeyPath(keyPath).map((segment) => {
    if (segment.matchesAnyKey) throw new Error(`key path "${keyPath}": "*" is supported for JSON/JSONC only`);
    return segment.key;
  });
}

/** The value at `keys` in a parsed document, or undefined. Own properties only. */
export function valueAtKeys(document: unknown, keys: readonly string[]): unknown {
  let current: unknown = document;
  for (const key of keys) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      if (!/^[0-9]+$/.test(key)) return undefined;
      current = current[Number(key)];
      continue;
    }
    if (!Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Plain JSON data only (what a config value can be); anything else is a caller bug. */
export function assertPlainConfigValue(value: unknown, keyPath: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${keyPath}: ${value} is not a finite number`);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) assertPlainConfigValue(element, keyPath);
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const entry of Object.values(value as Record<string, unknown>)) assertPlainConfigValue(entry, keyPath);
    return;
  }
  throw new Error(`${keyPath}: a ${typeof value} is not a config value`);
}

export function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when one key list is a prefix of the other (same, enclosing or enclosed path). */
export function keysOverlap(left: readonly string[], right: readonly string[]): boolean {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * `text` without leading and trailing characters from `characters`. A loop,
 * not `/x+$/`: an end-anchored repeat backtracks quadratically on a long run
 * followed by another character.
 */
export function trimCharacters(text: string, characters: string, sides: 'both' | 'end' = 'both'): string {
  let start = 0;
  let end = text.length;
  if (sides === 'both') while (start < end && characters.includes(text[start])) start++;
  while (end > start && characters.includes(text[end - 1])) end--;
  return text.slice(start, end);
}
