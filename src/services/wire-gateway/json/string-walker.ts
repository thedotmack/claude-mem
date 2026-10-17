// SPDX-License-Identifier: Apache-2.0
//
// Every string value of a JSON document, with where it sits, and a way to
// write some of them back changed while every other byte stays as it was.
// Ported from magpie's `walk` (internal/redact/json.go:220-366, MIT,
// Copyright (c) 2026 yetone) onto the Phase 3 byte-offset scanner and the
// byte-splice utility: magpie's paths ("messages.0.content", keys and
// indexes joined by dots) and its rule that an array's strings are under the
// key the array is under.

import { applyByteSplices, type ByteSplice } from './byte-splices.js';
import {
  JsonScanError,
  decodeString,
  scanDocument,
  scanValue,
  type JsonObjectMember,
  type JsonSpan,
} from './scanner.js';

/** One string value: its path, the key it is under ('' at the root), its span and its decoded text. */
export interface JsonStringSite<Context> {
  path: string;
  key: string;
  span: JsonSpan;
  value: string;
  /** What `contextOfMember` decided for the object member this string is in. */
  context: Context;
}

/** Where an object sits, handed to `contextOfMember` with each of its members. */
export interface JsonObjectSite<Context> {
  path: string;
  key: string;
  members: JsonObjectMember[];
  context: Context;
}

export interface JsonStringWalkOptions<Context> {
  rootContext: Context;
  /** The context of one member of an object; members of arrays take their array's. Defaults to the object's own. */
  contextOfMember?: (object: JsonObjectSite<Context>, member: JsonObjectMember) => Context;
}

export function joinJsonPath(path: string, step: string): string {
  return path === '' ? step : `${path}.${step}`;
}

interface PendingValue<Context> {
  span: JsonSpan;
  path: string;
  key: string;
  context: Context;
}

const QUOTE_BYTE = 0x22;
const BACKSLASH_BYTE = 0x5c;
const OPEN_BRACE_BYTE = 0x7b;
const CLOSE_BRACE_BYTE = 0x7d;
const OPEN_BRACKET_BYTE = 0x5b;
const CLOSE_BRACKET_BYTE = 0x5d;
const COMMA_BYTE = 0x2c;
const COLON_BYTE = 0x3a;

function skipJsonWhitespace(bytes: Uint8Array, position: number): number {
  while (position < bytes.length && (bytes[position] === 0x20 || bytes[position] === 0x09 || bytes[position] === 0x0a || bytes[position] === 0x0d)) position++;
  return position;
}

/**
 * Where each object and array of a document (already checked by
 * scanDocument) ends, by where it starts: one pass, so walking the document
 * never scans a container again for each level above it. (The scanner's
 * objectMembers/arrayElements find a child container's end by scanning it,
 * which over a deeply nested document costs depth × size: a tool's output
 * of nested brackets would stall the gateway.)
 */
function containerEndsByStart(bytes: Uint8Array): Map<number, number> {
  const ends = new Map<number, number>();
  const openStarts: number[] = [];
  let position = 0;
  while (position < bytes.length) {
    const byte = bytes[position];
    if (byte === QUOTE_BYTE) {
      position++;
      while (position < bytes.length && bytes[position] !== QUOTE_BYTE) position += bytes[position] === BACKSLASH_BYTE ? 2 : 1;
    } else if (byte === OPEN_BRACE_BYTE || byte === OPEN_BRACKET_BYTE) {
      openStarts.push(position);
    } else if (byte === CLOSE_BRACE_BYTE || byte === CLOSE_BRACKET_BYTE) {
      ends.set(openStarts.pop()!, position + 1);
    }
    position++;
  }
  return ends;
}

/** The span of the value at `position` (after whitespace), a container's end looked up rather than scanned. */
function valueSpanAt(bytes: Uint8Array, position: number, containerEnds: Map<number, number>): JsonSpan {
  const start = skipJsonWhitespace(bytes, position);
  const byte = bytes[start];
  if (byte === OPEN_BRACE_BYTE || byte === OPEN_BRACKET_BYTE) {
    const end = containerEnds.get(start);
    if (end === undefined) throw new JsonScanError('container without an end', start);
    return { start, end, type: byte === OPEN_BRACE_BYTE ? 'object' : 'array' };
  }
  return scanValue(bytes, start);
}

/** An object's members (scanDocument has checked its grammar). */
function membersOf(bytes: Uint8Array, objectSpan: JsonSpan, containerEnds: Map<number, number>): JsonObjectMember[] {
  const members: JsonObjectMember[] = [];
  let position = skipJsonWhitespace(bytes, objectSpan.start + 1);
  if (bytes[position] === CLOSE_BRACE_BYTE) return members;
  for (;;) {
    const keySpan = scanValue(bytes, position);
    position = skipJsonWhitespace(bytes, keySpan.end);
    if (bytes[position] !== COLON_BYTE) throw new JsonScanError('expected :', position);
    const value = valueSpanAt(bytes, position + 1, containerEnds);
    members.push({ key: decodeString(bytes, keySpan), keySpan, value });
    position = skipJsonWhitespace(bytes, value.end);
    if (bytes[position] !== COMMA_BYTE) return members;
    position = skipJsonWhitespace(bytes, position + 1);
  }
}

/** An array's elements (scanDocument has checked its grammar). */
function elementsOf(bytes: Uint8Array, arraySpan: JsonSpan, containerEnds: Map<number, number>): JsonSpan[] {
  const elements: JsonSpan[] = [];
  let position = skipJsonWhitespace(bytes, arraySpan.start + 1);
  if (bytes[position] === CLOSE_BRACKET_BYTE) return elements;
  for (;;) {
    const element = valueSpanAt(bytes, position, containerEnds);
    elements.push(element);
    position = skipJsonWhitespace(bytes, element.end);
    if (bytes[position] !== COMMA_BYTE) return elements;
    position++;
  }
}

/**
 * Every string value in `bytes`, in document order. Throws JsonScanError when
 * the bytes are not one JSON document. Walked with an explicit stack, so deep
 * nesting cannot overflow the call stack, and in time linear in the bytes
 * however deep the nesting.
 */
export function collectJsonStrings<Context>(bytes: Uint8Array, options: JsonStringWalkOptions<Context>): JsonStringSite<Context>[] {
  const sites: JsonStringSite<Context>[] = [];
  const root = scanDocument(bytes);
  const containerEnds = containerEndsByStart(bytes);
  const stack: PendingValue<Context>[] = [{ span: root, path: '', key: '', context: options.rootContext }];
  while (stack.length > 0) {
    const pending = stack.pop()!;
    const { span, path, key, context } = pending;
    if (span.type === 'string') {
      sites.push({ path, key, span, value: decodeString(bytes, span), context });
      continue;
    }
    const children: PendingValue<Context>[] = [];
    if (span.type === 'object') {
      const members = membersOf(bytes, span, containerEnds);
      const objectSite: JsonObjectSite<Context> = { path, key, members, context };
      for (const member of members) {
        children.push({
          span: member.value,
          path: joinJsonPath(path, member.key),
          key: member.key,
          context: options.contextOfMember ? options.contextOfMember(objectSite, member) : context,
        });
      }
    } else if (span.type === 'array') {
      let index = 0;
      for (const element of elementsOf(bytes, span, containerEnds)) {
        // An array's strings are under the key the array is.
        children.push({ span: element, path: joinJsonPath(path, String(index)), key, context });
        index++;
      }
    }
    // Reversed onto the stack, so they come off in document order.
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
  return sites;
}

const utf8Encoder = new TextEncoder();

/** `text` as it goes between the quotes of a JSON string (magpie `jsonEscape`). */
export function jsonEscapeString(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/** The splice that writes `newValue` where the string at `span` is. */
export function stringValueSplice(span: JsonSpan, newValue: string): ByteSplice {
  return { start: span.start, end: span.end, replacement: utf8Encoder.encode(`"${jsonEscapeString(newValue)}"`) };
}

/**
 * Call `rewrite` on every string of the document, in document order, and
 * write back each one it changed (magpie `walk`). Returns the bytes as they
 * came when nothing changed; `ok` is false when the bytes are not JSON.
 */
export function rewriteJsonStrings(
  bytes: Uint8Array,
  rewrite: (path: string, key: string, value: string) => string,
): { ok: boolean; bytes: Uint8Array } {
  let sites: JsonStringSite<null>[];
  try {
    sites = collectJsonStrings(bytes, { rootContext: null });
  } catch (error) {
    // Not JSON: the caller decides what a non-JSON body gets. Anything else is a bug.
    if (!(error instanceof JsonScanError)) throw error;
    return { ok: false, bytes };
  }
  const splices: ByteSplice[] = [];
  for (const site of sites) {
    const rewritten = rewrite(site.path, site.key, site.value);
    if (rewritten !== site.value) splices.push(stringValueSplice(site.span, rewritten));
  }
  return { ok: true, bytes: applyByteSplices(bytes, splices) };
}

const utf8Decoder = new TextDecoder();

/** rewriteJsonStrings over text. */
export function rewriteJsonStringsInText(
  text: string,
  rewrite: (path: string, key: string, value: string) => string,
): { ok: boolean; text: string } {
  const result = rewriteJsonStrings(utf8Encoder.encode(text), rewrite);
  return { ok: result.ok, text: result.ok ? utf8Decoder.decode(result.bytes) : text };
}
