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
  arrayElements,
  containerEndsByStart,
  decodeString,
  objectMembers,
  scanDocument,
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
      const members = [...objectMembers(bytes, span, containerEnds)];
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
      for (const element of arrayElements(bytes, span, containerEnds)) {
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

const utf8Decoder = new TextDecoder();

/**
 * Call `rewrite` on every string of the JSON `text`, in document order, and
 * write back each one it changed (magpie `walk`). Returns the text as it
 * came when nothing changed; `ok` is false when the text is not JSON.
 */
export function rewriteJsonStringsInText(
  text: string,
  rewrite: (path: string, key: string, value: string) => string,
): { ok: boolean; text: string } {
  const bytes = utf8Encoder.encode(text);
  let sites: JsonStringSite<null>[];
  try {
    sites = collectJsonStrings(bytes, { rootContext: null });
  } catch (error) {
    // Not JSON: the caller decides what a non-JSON body gets. Anything else is a bug.
    if (!(error instanceof JsonScanError)) throw error;
    return { ok: false, text };
  }
  const splices: ByteSplice[] = [];
  for (const site of sites) {
    const rewritten = rewrite(site.path, site.key, site.value);
    if (rewritten !== site.value) splices.push(stringValueSplice(site.span, rewritten));
  }
  return { ok: true, text: utf8Decoder.decode(applyByteSplices(bytes, splices)) };
}
