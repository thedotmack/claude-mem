// SPDX-License-Identifier: Apache-2.0
//
// Bounded request-body read and a decoded copy for parsing (plan Phase 2 task
// 3). Ported in idea from magpie internal/gateway/request_bounds.go (MIT,
// Copyright (c) 2026 yetone), with one difference: magpie forwards the decoded
// body, the wire gateway forwards the ORIGINAL bytes and Content-Encoding and
// only parses the decoded copy.

import { brotliDecompressSync, gunzipSync } from 'node:zlib';

/** How long a request body may sit without a byte before it is answered 408. */
export const DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS = 60_000;

export type BoundedBodyReadResult =
  | { kind: 'read'; body: Uint8Array }
  | { kind: 'too_large'; limitBytes: number }
  | { kind: 'idle_timeout'; idleTimeoutMs: number };

/**
 * Read the whole body, enforcing the byte limit ourselves: Bun.serve's
 * maxRequestBodySize is not enforced for chunked bodies (report 08 §Q2), so
 * it is never trusted. A Content-Length over the limit is refused before any
 * read. Each read waits at most idleTimeoutMs.
 */
export async function readBoundedRequestBody(
  request: Request,
  limits: { maxRequestBytes: number; idleTimeoutMs: number },
): Promise<BoundedBodyReadResult> {
  const declaredLength = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declaredLength) && declaredLength > limits.maxRequestBytes) {
    return { kind: 'too_large', limitBytes: limits.maxRequestBytes };
  }
  if (!request.body) {
    return { kind: 'read', body: new Uint8Array(0) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<'idle'>(resolve => {
      idleTimer = setTimeout(() => resolve('idle'), limits.idleTimeoutMs);
    });
    let next: Bun.ReadableStreamDefaultReadResult<Uint8Array> | 'idle';
    try {
      next = await Promise.race([reader.read(), idle]);
    } finally {
      clearTimeout(idleTimer);
    }
    if (next === 'idle') {
      // The client stalled; stop reading. cancel() rejects when the socket is
      // already gone, which changes nothing here.
      reader.cancel().catch(() => undefined);
      return { kind: 'idle_timeout', idleTimeoutMs: limits.idleTimeoutMs };
    }
    if (next.done) break;
    totalBytes += next.value.byteLength;
    if (totalBytes > limits.maxRequestBytes) {
      reader.cancel().catch(() => undefined);
      return { kind: 'too_large', limitBytes: limits.maxRequestBytes };
    }
    chunks.push(next.value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'read', body };
}

export type DecodedBodyCopy =
  | { kind: 'decoded'; bytes: Uint8Array; contentEncoding: string }
  /** The body cannot be parsed: relayed untouched, capture skipped. */
  | { kind: 'skipped'; reason: 'unknown_content_encoding' | 'decode_failed' | 'decoded_too_large'; contentEncoding: string };

/**
 * A decoded COPY of the body for parsing. The original bytes are what goes
 * upstream. Decoders (report 08 §Q4):
 * - gzip: node:zlib gunzipSync, which reads every member (Bun.gunzipSync keeps the first only)
 * - zstd: Bun.zstdDecompressSync, which reads every frame (zlib.zstdDecompressSync keeps the first only)
 * - br: node:zlib brotliDecompressSync
 * The decoded size is bounded too, so a small compressed body cannot expand
 * into an unbounded copy. gzip and br stop at maxOutputLength; zstd has no
 * bounded all-frames decoder, so its bound is read from the frame structure
 * BEFORE anything is decoded (zstdDecodedSizeUpperBound).
 */
export function decodeRequestBodyCopy(
  originalBody: Uint8Array,
  contentEncodingHeader: string | null,
  maxDecodedBytes: number,
): DecodedBodyCopy {
  const contentEncoding = (contentEncodingHeader ?? '').trim().toLowerCase();
  try {
    switch (contentEncoding) {
      case '':
      case 'identity':
        // A copy even here: observers hold it, and the original is what goes upstream.
        return { kind: 'decoded', bytes: originalBody.slice(), contentEncoding };
      case 'gzip':
      case 'x-gzip':
        // maxOutputLength throws RangeError past the bound (https://nodejs.org/api/zlib.html#class-options).
        return { kind: 'decoded', bytes: new Uint8Array(gunzipSync(originalBody, { maxOutputLength: maxDecodedBytes })), contentEncoding };
      case 'br':
        return { kind: 'decoded', bytes: new Uint8Array(brotliDecompressSync(originalBody, { maxOutputLength: maxDecodedBytes })), contentEncoding };
      case 'zstd': {
        // Bun.zstdDecompressSync has no output bound (bun-types bun.d.ts): a
        // few KB of zstd can expand to hundreds of MiB, so nothing is decoded
        // unless the frame structure already caps the output.
        const decodedSizeUpperBound = zstdDecodedSizeUpperBound(originalBody, maxDecodedBytes);
        if (decodedSizeUpperBound === 'malformed') {
          return { kind: 'skipped', reason: 'decode_failed', contentEncoding };
        }
        if (decodedSizeUpperBound > maxDecodedBytes) {
          return { kind: 'skipped', reason: 'decoded_too_large', contentEncoding };
        }
        const decoded = Bun.zstdDecompressSync(originalBody);
        if (decoded.byteLength > maxDecodedBytes) {
          return { kind: 'skipped', reason: 'decoded_too_large', contentEncoding };
        }
        return { kind: 'decoded', bytes: new Uint8Array(decoded), contentEncoding };
      }
      default:
        return { kind: 'skipped', reason: 'unknown_content_encoding', contentEncoding };
    }
  } catch (error) {
    if (error instanceof RangeError) {
      return { kind: 'skipped', reason: 'decoded_too_large', contentEncoding };
    }
    // A body that does not decode is still the vendor's to refuse; it is
    // relayed untouched and only capture is skipped.
    return { kind: 'skipped', reason: 'decode_failed', contentEncoding };
  }
}

const ZSTD_FRAME_MAGIC = 0xfd2fb528;
/** Skippable frames carry magic 0x184D2A50..0x184D2A5F (RFC 8878 §3.1.2). */
const ZSTD_SKIPPABLE_FRAME_MAGIC_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_FRAME_MAGIC = 0x184d2a50;
/** Block_Maximum_Size: no block regenerates more than 128 KiB (RFC 8878 §3.1.1.2.4). */
const ZSTD_BLOCK_MAXIMUM_DECODED_BYTES = 128 * 1024;

/**
 * An upper bound on what a zstd body decodes to, read from frame and block
 * headers only (RFC 8878 §3.1.1). Per frame it is the smaller of the declared
 * Frame_Content_Size (the decoder rejects a frame that overruns it) and the
 * block bound: raw and RLE blocks state their decoded size, a compressed block
 * regenerates at most Block_Maximum_Size. The walk stops as soon as the bound
 * passes stopAboveBytes. Truncated or reserved structures are 'malformed'.
 * Layout as in src/services/transcripts/zstd-frames.ts scanZstdFramesInFile.
 */
export function zstdDecodedSizeUpperBound(body: Uint8Array, stopAboveBytes: number): number | 'malformed' {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let offset = 0;
  let totalUpperBound = 0;
  while (offset < body.byteLength) {
    if (offset + 4 > body.byteLength) return 'malformed';
    const magic = view.getUint32(offset, true);
    offset += 4;
    if ((magic & ZSTD_SKIPPABLE_FRAME_MAGIC_MASK) >>> 0 === ZSTD_SKIPPABLE_FRAME_MAGIC) {
      if (offset + 4 > body.byteLength) return 'malformed';
      offset += 4 + view.getUint32(offset, true);
      if (offset > body.byteLength) return 'malformed';
      continue;
    }
    if (magic !== ZSTD_FRAME_MAGIC) return 'malformed';

    if (offset + 1 > body.byteLength) return 'malformed';
    const descriptor = view.getUint8(offset);
    offset += 1;
    if ((descriptor & 0x08) !== 0) return 'malformed';
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const hasChecksum = (descriptor & 0x04) !== 0;
    const dictionaryIdFlag = descriptor & 0x03;
    const contentSizeFieldBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + (dictionaryIdFlag === 3 ? 4 : dictionaryIdFlag);
    if (offset + contentSizeFieldBytes > body.byteLength) return 'malformed';
    let declaredContentSize = Number.POSITIVE_INFINITY;
    switch (contentSizeFieldBytes) {
      case 1: declaredContentSize = view.getUint8(offset); break;
      case 2: declaredContentSize = view.getUint16(offset, true) + 256; break;
      case 4: declaredContentSize = view.getUint32(offset, true); break;
      case 8: declaredContentSize = Number(view.getBigUint64(offset, true)); break;
    }
    offset += contentSizeFieldBytes;

    let blockUpperBound = 0;
    for (;;) {
      if (offset + 3 > body.byteLength) return 'malformed';
      const blockHeader = view.getUint16(offset, true) | (view.getUint8(offset + 2) << 16);
      offset += 3;
      const isLastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return 'malformed';
      // 0 raw: blockSize bytes in and out. 1 RLE: one byte in, blockSize out. 2 compressed.
      blockUpperBound += blockType === 2 ? ZSTD_BLOCK_MAXIMUM_DECODED_BYTES : blockSize;
      offset += blockType === 1 ? 1 : blockSize;
      if (offset > body.byteLength) return 'malformed';
      if (isLastBlock) break;
    }
    if (hasChecksum) offset += 4;
    if (offset > body.byteLength) return 'malformed';

    totalUpperBound += Math.min(declaredContentSize, blockUpperBound);
    if (totalUpperBound > stopAboveBytes) return totalUpperBound;
  }
  return totalUpperBound;
}
