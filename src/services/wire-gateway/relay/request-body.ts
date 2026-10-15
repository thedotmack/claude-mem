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
 * into an unbounded copy.
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
        // Bun.zstdDecompressSync has no output bound (bun-types bun.d.ts), so the size is checked after.
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
