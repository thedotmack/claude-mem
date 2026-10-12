import * as zlib from 'node:zlib';
import { closeSync, openSync, readSync } from 'node:fs';
import { logger } from '../../utils/logger.js';

type ZstdDecompressSync = (data: Uint8Array) => Buffer;

// zlib.zstdDecompressSync exists only on newer runtimes (Node 22.15+, recent
// Bun). A named import would fail the whole transcript-watcher module at load
// on an older one, so it is looked up at call time instead.
function zstdDecompressor(): ZstdDecompressSync | undefined {
  const candidate = (zlib as unknown as { zstdDecompressSync?: unknown }).zstdDecompressSync;
  return typeof candidate === 'function' ? (candidate as ZstdDecompressSync) : undefined;
}

/** Whether this runtime can decode Zstandard frames at all. */
export function isZstdSupported(): boolean {
  return zstdDecompressor() !== undefined;
}

/**
 * Zstandard frame utilities for concatenated-frame session containers.
 *
 * DeepSeek Harness (DSH) persists each session as a `.jsonl.zstd` file built
 * from a sequence of independently decodable Zstandard frames: every durable
 * write appends one complete, checksummed frame to the end of the file. Node's
 * one-shot `zstdDecompressSync` only decodes the first frame of such a
 * container, so the transcript watcher must locate frame boundaries itself and
 * decode each frame separately.
 */

const ZSTD_MAGIC = 0xfd2fb528;

export interface ZstdFrameRange {
  start: number;
  end: number;
}

export interface ZstdScanResult {
  /** Complete frames, in file order, with absolute byte offsets. */
  frames: ZstdFrameRange[];
  /** Absolute offset of an incomplete trailing frame, or null when the scan met none. */
  tornStart: number | null;
}

/** Header reads go through a window this large, so payloads are skipped rather than read. */
const HEADER_WINDOW_BYTES = 64 * 1024;

/**
 * Locate complete Zstandard frames in [start, end) of a file without reading
 * their compressed payloads: only the frame and block headers are read,
 * through a small window. The layout follows the Zstandard frame
 * specification: magic(4) + frame-header-descriptor(1) + optional header
 * fields (window descriptor / frame content size / dictionary id) + one or
 * more blocks (3-byte header + payload, last block flagged) + optional 4-byte
 * checksum. EOF inside any structure is reported as a torn frame instead of an
 * error, so an interrupted durable write can be retried once the file grows.
 *
 * The scan stops once the frames found span `maxBytes` (it always returns at
 * least one complete frame when one exists), so a single call stays bounded
 * however large the file is; the caller continues from the last frame's end.
 */
export function scanZstdFramesInFile(
  filePath: string,
  start: number,
  end: number,
  maxBytes = Number.POSITIVE_INFINITY,
): ZstdScanResult {
  const fd = openSync(filePath, 'r');
  try {
    let window = Buffer.alloc(0);
    let windowStart = 0;
    // The requested bytes, or null when they run past `end` (a torn frame).
    const bytesAt = (position: number, length: number): Buffer | null => {
      if (position + length > end) return null;
      if (position < windowStart || position + length > windowStart + window.length) {
        const size = Math.min(Math.max(length, HEADER_WINDOW_BYTES), end - position);
        const buffer = Buffer.alloc(size);
        window = buffer.subarray(0, readSync(fd, buffer, 0, size, position));
        windowStart = position;
        if (window.length < length) return null;
      }
      return window.subarray(position - windowStart, position - windowStart + length);
    };

    const frames: ZstdFrameRange[] = [];
    let offset = start;
    while (offset < end && (frames.length === 0 || offset - start < maxBytes)) {
      const frameStart = offset;
      const magic = bytesAt(offset, 4);
      if (!magic) return { frames, tornStart: frameStart };
      if (magic.readUInt32LE(0) !== ZSTD_MAGIC) {
        throw new Error(`invalid Zstandard frame magic at byte ${offset}`);
      }
      offset += 4;

      const descriptorByte = bytesAt(offset, 1);
      if (!descriptorByte) return { frames, tornStart: frameStart };
      const descriptor = descriptorByte.readUInt8(0);
      offset += 1;
      // Bit 4 is unused and must be ignored by decoders (RFC 8878).
      // Bit 3 is reserved and must still be rejected.
      if ((descriptor & 8) !== 0) {
        throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`);
      }

      const contentSizeFlag = descriptor >>> 6;
      const singleSegment = (descriptor & 32) !== 0;
      const checksum = (descriptor & 4) !== 0;
      const dictionaryFlag = descriptor & 3;
      const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
      const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
      const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
      if (offset + remainingHeaderBytes > end) return { frames, tornStart: frameStart };
      offset += remainingHeaderBytes;

      for (;;) {
        const blockHeaderBytes = bytesAt(offset, 3);
        if (!blockHeaderBytes) return { frames, tornStart: frameStart };
        const blockHeader = blockHeaderBytes.readUIntLE(0, 3);
        offset += 3;
        const lastBlock = (blockHeader & 1) !== 0;
        const blockType = (blockHeader >>> 1) & 3;
        const blockSize = blockHeader >>> 3;
        if (blockType === 3) {
          throw new Error(`reserved Zstandard block type at byte ${offset - 3}`);
        }
        const payloadBytes = blockType === 1 ? 1 : blockSize;
        if (offset + payloadBytes > end) return { frames, tornStart: frameStart };
        offset += payloadBytes;
        if (lastBlock) break;
      }

      if (checksum) {
        if (offset + 4 > end) return { frames, tornStart: frameStart };
        offset += 4;
      }
      frames.push({ start: frameStart, end: offset });
    }

    return { frames, tornStart: null };
  } finally {
    closeSync(fd);
  }
}

/**
 * Decompress one complete Zstandard frame back to UTF-8 text.
 */
export function decompressZstdFrame(buffer: Buffer, frame: ZstdFrameRange): string {
  try {
    const decompress = zstdDecompressor();
    if (!decompress) throw new Error('this runtime cannot decode Zstandard (zlib.zstdDecompressSync is missing)');
    const decoded = decompress(buffer.subarray(frame.start, frame.end));
    return decoded.toString('utf8');
  } catch (error) {
    logger.warn('TRANSCRIPT', 'Failed to decompress Zstandard frame', {
      start: frame.start,
      end: frame.end,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
