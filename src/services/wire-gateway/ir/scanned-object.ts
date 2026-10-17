// SPDX-License-Identifier: Apache-2.0
//
// Typed reads of one JSON object through the byte-offset scanner. A field of
// the wrong type reads as absent, so a parser never throws on an odd field
// (plan Phase 3 "Parsers must not throw on unknown event types or fields").

import {
  arrayElements,
  decodeString,
  objectMemberMap,
  rawText,
  type JsonSpan,
} from '../json/scanner.js';

export class ScannedObject {
  private readonly members: Map<string, JsonSpan>;

  constructor(readonly bytes: Uint8Array, readonly span: JsonSpan) {
    this.members = objectMemberMap(bytes, span);
  }

  /** A ScannedObject for `span` when it is an object, else undefined. */
  static of(bytes: Uint8Array, span: JsonSpan | undefined): ScannedObject | undefined {
    return span?.type === 'object' ? new ScannedObject(bytes, span) : undefined;
  }

  /** The member keys, each once. */
  keys(): string[] {
    return [...this.members.keys()];
  }

  /** The span of the first of `keys` present (Gemini accepts camelCase and snake_case spellings). */
  spanOf(...keys: string[]): JsonSpan | undefined {
    for (const key of keys) {
      const span = this.members.get(key);
      if (span) return span;
    }
    return undefined;
  }

  string(...keys: string[]): string | undefined {
    const span = this.spanOf(...keys);
    return span?.type === 'string' ? decodeString(this.bytes, span) : undefined;
  }

  number(...keys: string[]): number | undefined {
    const span = this.spanOf(...keys);
    return span?.type === 'number' ? Number(rawText(this.bytes, span)) : undefined;
  }

  isTrue(...keys: string[]): boolean {
    return this.spanOf(...keys)?.type === 'true';
  }

  object(...keys: string[]): ScannedObject | undefined {
    return ScannedObject.of(this.bytes, this.spanOf(...keys));
  }

  /** An array's elements; [] when absent or not an array. */
  elements(...keys: string[]): JsonSpan[] {
    const span = this.spanOf(...keys);
    return span?.type === 'array' ? [...arrayElements(this.bytes, span)] : [];
  }

  /** A member's raw JSON text; undefined when absent or null. */
  raw(...keys: string[]): string | undefined {
    const span = this.spanOf(...keys);
    return span && span.type !== 'null' ? rawText(this.bytes, span) : undefined;
  }
}

/** The elements of an array span that are objects. */
export function objectElements(bytes: Uint8Array, arraySpan: JsonSpan | undefined): ScannedObject[] {
  if (arraySpan?.type !== 'array') return [];
  const objects: ScannedObject[] = [];
  for (const element of arrayElements(bytes, arraySpan)) {
    if (element.type === 'object') objects.push(new ScannedObject(bytes, element));
  }
  return objects;
}

/** A span covering `first` through `last`. */
export function joinSpans(first: JsonSpan, last: JsonSpan): JsonSpan {
  return first === last ? first : { start: first.start, end: last.end, type: first.type };
}
