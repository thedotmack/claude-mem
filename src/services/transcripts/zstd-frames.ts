import { zstdDecompressSync } from 'node:zlib';
import { logger } from '../../utils/logger.js';

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
  frames: ZstdFrameRange[];
  /** Byte offset of an incomplete trailing frame, or null when all bytes belong to complete frames. */
  tornStart: number | null;
}

/**
 * Locate complete Zstandard frames without decompressing their blocks. The
 * layout follows the Zstandard frame specification:
 * magic(4) + frame-header-descriptor(1) + optional header fields
 * (window descriptor / frame content size / dictionary id) + one or more
 * blocks (3-byte header + payload, last block flagged) + optional 4-byte
 * checksum. EOF inside any structure is reported as a torn frame instead of an
 * error, so an interrupted durable write can be retried once the file grows.
 */
export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): ZstdScanResult {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;

  while (offset < buffer.length && frames.length < maxFrames) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid Zstandard frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };

    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`);
    }

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`reserved Zstandard block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }

  return { frames, tornStart: offset < buffer.length ? offset : null };
}

/**
 * Decompress one complete Zstandard frame back to UTF-8 text.
 */
export function decompressZstdFrame(buffer: Buffer, frame: ZstdFrameRange): string {
  try {
    const decoded = zstdDecompressSync(buffer.subarray(frame.start, frame.end));
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

/**
 * Decompress the complete frames of a concatenated-frame container and return
 * the concatenated plaintext. Torn (incomplete) trailing frames are skipped.
 */
export function decompressZstdContainer(buffer: Buffer): string {
  const { frames } = scanZstdFrames(buffer);
  const parts: string[] = [];
  for (const frame of frames) {
    parts.push(decompressZstdFrame(buffer, frame));
  }
  return parts.join('');
}
