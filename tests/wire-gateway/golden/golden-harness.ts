import { expect } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { WireProtocol } from '../../../src/services/wire-gateway/relay/protocols.js';

// The golden-bytes harness (plan Phase 10 task 3), after magpie's
// TestUpstreamBodiesUnchanged (internal/gateway/upstream_bytes_test.go:16-151,
// MIT, Copyright (c) 2026 yetone): what the vendor got is compared with a
// saved file, and UPDATE_WIRE_GOLDEN=1 saves it again. Beside the saved
// bytes, a rewritten body must differ from its input ONLY inside the spans
// the rewrite declared, and an unchanged body must be byte-identical.
// Phases 11 and 12 add their cases here.

const GOLDEN_DIRECTORY = import.meta.dir;
const INPUTS_DIRECTORY = join(GOLDEN_DIRECTORY, 'inputs');
const EXPECTED_DIRECTORY = join(GOLDEN_DIRECTORY, 'expected');
/** Bodies larger than this are kept by their hash, as magpie keeps them. */
const GOLDEN_HASH_THRESHOLD_BYTES = 16 * 1024;

export const updatingGoldenFiles = process.env.UPDATE_WIRE_GOLDEN === '1';

/** The odd-JSON request body of a protocol: whitespace, `1.50e2`, `0.70`, `\/`, escapes, `<b> & co`, non-ASCII. */
export function readGoldenInput(protocol: WireProtocol): Uint8Array {
  return new Uint8Array(readFileSync(join(INPUTS_DIRECTORY, `${protocol}.json`)));
}

/** `bytes` match the saved golden file of `caseName` (or are saved as it, under UPDATE_WIRE_GOLDEN=1). */
export function expectMatchesGoldenFile(caseName: string, bytes: Uint8Array): void {
  let saved: Uint8Array = bytes;
  let fileName = `${caseName}.json`;
  if (bytes.length > GOLDEN_HASH_THRESHOLD_BYTES) {
    saved = new TextEncoder().encode(`${createHash('sha256').update(bytes).digest('hex')}\n`);
    fileName = `${caseName}.sha256`;
  }
  const filePath = join(EXPECTED_DIRECTORY, fileName);
  if (updatingGoldenFiles) {
    mkdirSync(EXPECTED_DIRECTORY, { recursive: true });
    writeFileSync(filePath, saved);
    return;
  }
  if (!existsSync(filePath)) throw new Error(`no golden file ${filePath}; run with UPDATE_WIRE_GOLDEN=1 to save it`);
  // A Windows checkout may have made line ends CRLF; no golden body holds a CR of its own outside escapes.
  const expected = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  expect(new TextDecoder().decode(saved)).toBe(expected);
}

export interface DeclaredSpan {
  start: number;
  end: number;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0) return from;
  outer: for (let index = from; index + needle.length <= haystack.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function bytesEqualAt(haystack: Uint8Array, at: number, needle: Uint8Array): boolean {
  if (at < 0 || at + needle.length > haystack.length) return false;
  for (let offset = 0; offset < needle.length; offset++) {
    if (haystack[at + offset] !== needle[offset]) return false;
  }
  return true;
}

/**
 * `rewritten` is `original` with only the declared spans (ranges of the
 * original; an empty range is an insertion point) replaced: every byte
 * between them is there, in order. Matched as a glob whose wildcards are the
 * spans: the first gap anchored at the start, the last at the end, the rest
 * leftmost in between, which finds a match whenever one exists.
 */
export function expectDiffersOnlyInsideDeclaredSpans(original: Uint8Array, rewritten: Uint8Array, declaredSpans: DeclaredSpan[]): void {
  const ordered = [...declaredSpans].sort((first, second) => first.start - second.start);
  const gaps: Uint8Array[] = [];
  let previousEnd = 0;
  for (const span of ordered) {
    if (span.start < previousEnd || span.end < span.start || span.end > original.length) throw new Error('declared spans overlap or fall outside the body');
    gaps.push(original.subarray(previousEnd, span.start));
    previousEnd = span.end;
  }
  gaps.push(original.subarray(previousEnd));
  const firstGap = gaps[0];
  const lastGap = gaps[gaps.length - 1];
  let matched = bytesEqualAt(rewritten, 0, firstGap) && bytesEqualAt(rewritten, rewritten.length - lastGap.length, lastGap);
  let cursor = firstGap.length;
  for (let index = 1; matched && index < gaps.length - 1; index++) {
    const foundAt = indexOfBytes(rewritten, gaps[index], cursor);
    if (foundAt < 0) matched = false;
    else cursor = foundAt + gaps[index].length;
  }
  if (gaps.length > 1 && cursor > rewritten.length - lastGap.length) matched = false;
  if (!matched) {
    const decoder = new TextDecoder();
    throw new Error(`the rewritten body changed bytes outside its declared spans:\n original ${decoder.decode(original)}\nrewritten ${decoder.decode(rewritten)}`);
  }
}
