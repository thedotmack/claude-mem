// SPDX-License-Identifier: Apache-2.0
//
// Byte splices (plan D7.3): a forwarded body is edited only by replacing
// byte ranges, never by JSON.parse → JSON.stringify, so every byte outside
// an edit goes upstream exactly as the agent wrote it. magpie edits its
// bodies with gjson/sjson raw splices (internal/gateway/gateway.go:5370-5387,
// MIT, Copyright (c) 2026 yetone). Built here for Phase 6's outbound
// redaction; Phase 10's rewrites use the same utility.

export interface ByteSplice {
  /** Replace bytes [start, end) … */
  start: number;
  end: number;
  /** … with these. */
  replacement: Uint8Array;
}

/**
 * `bytes` with every splice applied. Splices must not overlap; they may come
 * in any order. Throws on an overlap or a range outside the bytes (fail fast:
 * an overlapping edit is a bug, never something to guess about).
 */
export function applyByteSplices(bytes: Uint8Array, splices: ByteSplice[]): Uint8Array {
  if (splices.length === 0) return bytes;
  const ordered = [...splices].sort((a, b) => a.start - b.start);
  let outputLength = bytes.length;
  let previousEnd = 0;
  for (const splice of ordered) {
    if (splice.start < previousEnd || splice.end < splice.start || splice.end > bytes.length) {
      throw new Error(`byte splice [${splice.start}, ${splice.end}) overlaps another or is outside ${bytes.length} bytes`);
    }
    previousEnd = splice.end;
    outputLength += splice.replacement.length - (splice.end - splice.start);
  }
  const output = new Uint8Array(outputLength);
  let readFrom = 0;
  let writeAt = 0;
  for (const splice of ordered) {
    output.set(bytes.subarray(readFrom, splice.start), writeAt);
    writeAt += splice.start - readFrom;
    output.set(splice.replacement, writeAt);
    writeAt += splice.replacement.length;
    readFrom = splice.end;
  }
  output.set(bytes.subarray(readFrom), writeAt);
  return output;
}
