// SPDX-License-Identifier: Apache-2.0
//
// A single-pass, byte-offset JSON scanner over Uint8Array (plan Phase 3 task
// 1). It plays the part of magpie's gjson `Index`/`Raw`: it finds where a
// value sits in the original bytes, so later phases splice those bytes and
// never round-trip a forwarded body through JSON.parse → JSON.stringify
// (plan D7.3). Strict JSON only (RFC 8259): a JSONC caller blanks comments
// first, keeping offsets.

export type JsonValueType = 'object' | 'array' | 'string' | 'number' | 'true' | 'false' | 'null';

/** A value's bytes are `bytes.subarray(start, end)`. */
export interface JsonSpan {
  start: number;
  end: number;
  type: JsonValueType;
}

export interface JsonObjectMember {
  key: string;
  keySpan: JsonSpan;
  value: JsonSpan;
}

export type JsonPath = ReadonlyArray<string | number>;

export class JsonScanError extends Error {
  constructor(message: string, public readonly offset: number) {
    super(`${message} at byte ${offset}`);
    this.name = 'JsonScanError';
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;
const MINUS = 0x2d;

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

/** The offset of the first non-whitespace byte at or after `offset`. */
function skipWhitespace(bytes: Uint8Array, offset: number): number {
  let position = offset;
  while (position < bytes.length && isWhitespace(bytes[position])) position++;
  return position;
}

function expectLiteral(bytes: Uint8Array, start: number, literal: string): number {
  for (let index = 0; index < literal.length; index++) {
    if (bytes[start + index] !== literal.charCodeAt(index)) {
      throw new JsonScanError(`expected ${literal}`, start);
    }
  }
  return start + literal.length;
}

/** Bytes that may follow a backslash besides `u`: " \ / b f n r t. */
const SIMPLE_ESCAPE_BYTES = new Set([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74]);

/** The offset just past the escape whose backslash is at `position`; a bad escape is an error, as in JSON.parse. */
function endOfEscape(bytes: Uint8Array, position: number): number {
  const escaped = bytes[position + 1];
  if (escaped === undefined) throw new JsonScanError('unterminated string', position);
  if (SIMPLE_ESCAPE_BYTES.has(escaped)) return position + 2;
  if (escaped === 0x75) {
    hexValue(bytes, position + 2);
    return position + 6;
  }
  throw new JsonScanError('bad escape', position);
}

/** The end (exclusive) of the string whose opening quote is at `start`. */
function endOfString(bytes: Uint8Array, start: number): number {
  let position = start + 1;
  while (position < bytes.length) {
    const byte = bytes[position];
    if (byte === QUOTE) return position + 1;
    if (byte === BACKSLASH) {
      position = endOfEscape(bytes, position);
      continue;
    }
    if (byte < 0x20) throw new JsonScanError('control character in string', position);
    position++;
  }
  throw new JsonScanError('unterminated string', start);
}

function endOfNumber(bytes: Uint8Array, start: number): number {
  let position = start;
  if (bytes[position] === MINUS) position++;
  if (!isDigit(bytes[position])) throw new JsonScanError('expected a digit', position);
  if (bytes[position] === 0x30) {
    position++;
  } else {
    while (isDigit(bytes[position])) position++;
  }
  if (bytes[position] === 0x2e) {
    position++;
    if (!isDigit(bytes[position])) throw new JsonScanError('expected a fraction digit', position);
    while (isDigit(bytes[position])) position++;
  }
  if (bytes[position] === 0x65 || bytes[position] === 0x45) {
    position++;
    if (bytes[position] === 0x2b || bytes[position] === MINUS) position++;
    if (!isDigit(bytes[position])) throw new JsonScanError('expected an exponent digit', position);
    while (isDigit(bytes[position])) position++;
  }
  return position;
}

/**
 * The span of the value starting at the first non-whitespace byte at or after
 * `offset`. Containers are walked iteratively, so deep nesting cannot
 * overflow the stack.
 */
export function scanValue(bytes: Uint8Array, offset: number): JsonSpan {
  const start = skipWhitespace(bytes, offset);
  if (start >= bytes.length) throw new JsonScanError('expected a value', start);
  const first = bytes[start];
  switch (first) {
    case QUOTE:
      return { start, end: endOfString(bytes, start), type: 'string' };
    case 0x74:
      return { start, end: expectLiteral(bytes, start, 'true'), type: 'true' };
    case 0x66:
      return { start, end: expectLiteral(bytes, start, 'false'), type: 'false' };
    case 0x6e:
      return { start, end: expectLiteral(bytes, start, 'null'), type: 'null' };
    case OPEN_BRACE:
    case OPEN_BRACKET:
      return { start, end: endOfContainer(bytes, start), type: first === OPEN_BRACE ? 'object' : 'array' };
    default:
      if (first === MINUS || isDigit(first)) return { start, end: endOfNumber(bytes, start), type: 'number' };
      throw new JsonScanError('unexpected byte', start);
  }
}

/** Validates a container's grammar while finding its end. */
function endOfContainer(bytes: Uint8Array, start: number): number {
  // Each stack entry is the closing byte the open container expects.
  const closers: number[] = [];
  // What may come next: a value, a key, or a comma/close.
  type Expectation = 'value_or_close' | 'key_or_close' | 'value' | 'key' | 'comma_or_close';
  let expectation = 'value_or_close' as Expectation;
  let position = start;
  /** Opens the container whose opening byte is at `position`, returning what may follow it. */
  const open = (byte: number): Expectation => {
    closers.push(byte === OPEN_BRACE ? CLOSE_BRACE : CLOSE_BRACKET);
    position++;
    return byte === OPEN_BRACE ? 'key_or_close' : 'value_or_close';
  };
  expectation = open(bytes[start]);

  while (closers.length > 0) {
    position = skipWhitespace(bytes, position);
    if (position >= bytes.length) throw new JsonScanError('unterminated container', start);
    const byte = bytes[position];
    const closer = closers[closers.length - 1];
    const inObject = closer === CLOSE_BRACE;

    if ((expectation === 'value_or_close' || expectation === 'key_or_close' || expectation === 'comma_or_close') && byte === closer) {
      closers.pop();
      position++;
      expectation = 'comma_or_close';
      continue;
    }
    if (expectation === 'comma_or_close') {
      if (byte !== COMMA) throw new JsonScanError('expected , or a close', position);
      position++;
      expectation = inObject ? 'key' : 'value';
      continue;
    }
    if (expectation === 'key_or_close' || expectation === 'key') {
      if (byte !== QUOTE) throw new JsonScanError('expected a key', position);
      position = skipWhitespace(bytes, endOfString(bytes, position));
      if (bytes[position] !== COLON) throw new JsonScanError('expected :', position);
      position++;
      expectation = 'value';
      continue;
    }
    // A value.
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      expectation = open(byte);
      continue;
    }
    position = scanValue(bytes, position).end;
    expectation = 'comma_or_close';
  }
  return position;
}

/** The span of the whole document; trailing bytes other than whitespace are an error. */
export function scanDocument(bytes: Uint8Array): JsonSpan {
  const span = scanValue(bytes, 0);
  const trailing = skipWhitespace(bytes, span.end);
  if (trailing !== bytes.length) throw new JsonScanError('trailing bytes after the value', trailing);
  return span;
}

/**
 * Where each object and array of a document (already checked by
 * scanDocument) ends, by where it starts: one pass. Handed to
 * objectMembers/arrayElements, a child container's end is looked up rather
 * than scanned, so walking every level of a deeply nested document costs its
 * size once, not depth × size (a tool's output of nested brackets would
 * otherwise stall the gateway).
 */
export function containerEndsByStart(bytes: Uint8Array): Map<number, number> {
  const ends = new Map<number, number>();
  const openStarts: number[] = [];
  let position = 0;
  while (position < bytes.length) {
    const byte = bytes[position];
    if (byte === QUOTE) {
      position++;
      while (position < bytes.length && bytes[position] !== QUOTE) position += bytes[position] === BACKSLASH ? 2 : 1;
    } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      openStarts.push(position);
    } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      ends.set(openStarts.pop()!, position + 1);
    }
    position++;
  }
  return ends;
}

/** scanValue, with a container's end looked up in `containerEnds` when given. */
function childValueSpan(bytes: Uint8Array, position: number, containerEnds?: Map<number, number>): JsonSpan {
  if (!containerEnds) return scanValue(bytes, position);
  const start = skipWhitespace(bytes, position);
  const byte = bytes[start];
  if (byte !== OPEN_BRACE && byte !== OPEN_BRACKET) return scanValue(bytes, start);
  const end = containerEnds.get(start);
  if (end === undefined) throw new JsonScanError('container without an end', start);
  return { start, end, type: byte === OPEN_BRACE ? 'object' : 'array' };
}

/** Every member of an object, in order, duplicates included. `containerEnds`: see containerEndsByStart. */
export function* objectMembers(bytes: Uint8Array, objectSpan: JsonSpan, containerEnds?: Map<number, number>): Generator<JsonObjectMember> {
  if (objectSpan.type !== 'object') throw new JsonScanError('not an object', objectSpan.start);
  let position = skipWhitespace(bytes, objectSpan.start + 1);
  if (bytes[position] === CLOSE_BRACE) return;
  for (;;) {
    const keySpan: JsonSpan = { start: position, end: endOfString(bytes, position), type: 'string' };
    position = skipWhitespace(bytes, keySpan.end);
    if (bytes[position] !== COLON) throw new JsonScanError('expected :', position);
    const value = childValueSpan(bytes, position + 1, containerEnds);
    yield { key: decodeString(bytes, keySpan), keySpan, value };
    position = skipWhitespace(bytes, value.end);
    if (bytes[position] === CLOSE_BRACE) return;
    if (bytes[position] !== COMMA) throw new JsonScanError('expected , or }', position);
    position = skipWhitespace(bytes, position + 1);
  }
}

/** Every element of an array, in order. `containerEnds`: see containerEndsByStart. */
export function* arrayElements(bytes: Uint8Array, arraySpan: JsonSpan, containerEnds?: Map<number, number>): Generator<JsonSpan> {
  if (arraySpan.type !== 'array') throw new JsonScanError('not an array', arraySpan.start);
  let position = skipWhitespace(bytes, arraySpan.start + 1);
  if (bytes[position] === CLOSE_BRACKET) return;
  for (;;) {
    const element = childValueSpan(bytes, position, containerEnds);
    yield element;
    position = skipWhitespace(bytes, element.end);
    if (bytes[position] === CLOSE_BRACKET) return;
    if (bytes[position] !== COMMA) throw new JsonScanError('expected , or ]', position);
    position++;
  }
}

/**
 * The span at `path` from the document root (or from `rootSpan`): a string
 * step reads an object member (last duplicate wins), a number an array index.
 * Null when the path does not exist or crosses a value of the wrong type.
 */
export function getSpan(bytes: Uint8Array, path: JsonPath, rootSpan: JsonSpan = scanDocument(bytes)): JsonSpan | null {
  let current: JsonSpan = rootSpan;
  for (const step of path) {
    let found: JsonSpan | null = null;
    if (typeof step === 'string') {
      if (current.type !== 'object') return null;
      for (const member of objectMembers(bytes, current)) {
        if (member.key === step) found = member.value;
      }
    } else {
      if (current.type !== 'array') return null;
      let index = 0;
      for (const element of arrayElements(bytes, current)) {
        if (index === step) {
          found = element;
          break;
        }
        index++;
      }
    }
    if (!found) return null;
    current = found;
  }
  return current;
}

const utf8Decoder = new TextDecoder('utf-8');

/** The raw UTF-8 text of a span (any type), exactly as it is in the bytes. */
export function rawText(bytes: Uint8Array, span: JsonSpan): string {
  return utf8Decoder.decode(bytes.subarray(span.start, span.end));
}

function hexValue(bytes: Uint8Array, position: number): number {
  let value = 0;
  for (let index = 0; index < 4; index++) {
    const byte = bytes[position + index];
    let digit: number;
    if (byte >= 0x30 && byte <= 0x39) digit = byte - 0x30;
    else if (byte >= 0x61 && byte <= 0x66) digit = byte - 0x61 + 10;
    else if (byte >= 0x41 && byte <= 0x46) digit = byte - 0x41 + 10;
    else throw new JsonScanError('bad \\u escape', position);
    value = value * 16 + digit;
  }
  return value;
}

/**
 * Decode a string span. Escapes are decoded here; `😀` pairs join
 * into one code point and a lone surrogate stays a lone UTF-16 unit, as
 * JSON.parse leaves it.
 */
export function decodeString(bytes: Uint8Array, span: JsonSpan): string {
  if (span.type !== 'string') throw new JsonScanError('not a string', span.start);
  const contentStart = span.start + 1;
  const contentEnd = span.end - 1;
  // Fast path: no escapes.
  let hasEscape = false;
  for (let position = contentStart; position < contentEnd; position++) {
    if (bytes[position] === BACKSLASH) {
      hasEscape = true;
      break;
    }
  }
  if (!hasEscape) return utf8Decoder.decode(bytes.subarray(contentStart, contentEnd));

  let decoded = '';
  let runStart = contentStart;
  let position = contentStart;
  while (position < contentEnd) {
    if (bytes[position] !== BACKSLASH) {
      position++;
      continue;
    }
    decoded += utf8Decoder.decode(bytes.subarray(runStart, position));
    const escaped = bytes[position + 1];
    switch (escaped) {
      case 0x22: decoded += '"'; break;
      case 0x5c: decoded += '\\'; break;
      case 0x2f: decoded += '/'; break;
      case 0x62: decoded += '\b'; break;
      case 0x66: decoded += '\f'; break;
      case 0x6e: decoded += '\n'; break;
      case 0x72: decoded += '\r'; break;
      case 0x74: decoded += '\t'; break;
      case 0x75:
        decoded += String.fromCharCode(hexValue(bytes, position + 2));
        position += 4;
        break;
      default:
        throw new JsonScanError('bad escape', position);
    }
    position += 2;
    runStart = position;
  }
  return decoded + utf8Decoder.decode(bytes.subarray(runStart, contentEnd));
}

/** A leaf or container decoded to a JS value (JSON.parse of just that span). */
export function decodeValue(bytes: Uint8Array, span: JsonSpan): unknown {
  if (span.type === 'string') return decodeString(bytes, span);
  return JSON.parse(rawText(bytes, span));
}
