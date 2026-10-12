import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { scanZstdFramesInFile, decompressZstdFrame } from '../../src/services/transcripts/zstd-frames.js';

it('ignores the unused descriptor bit just like the real Zstandard decoder', () => {
  const root = mkdtempSync(join(tmpdir(), 'cmem-zstd-unused-'));
  try {
    const text = '{"type":"user","text":"Fixture transcript"}\n';
    const frame = zstdCompressSync(Buffer.from(text));
    frame[4] |= 0x10; // RFC 8878 section 3.1.1.1.1.3: decoders shall not interpret bit 4.
    expect(zstdDecompressSync(frame).toString()).toBe(text);
    const file = join(root, 'session.jsonl.zstd');
    writeFileSync(file, frame);
    const scan = scanZstdFramesInFile(file, 0, frame.length);
    expect(scan.frames).toEqual([{ start: 0, end: frame.length }]);
    expect(scan.tornStart).toBeNull();
    expect(decompressZstdFrame(frame, scan.frames[0])).toBe(text);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('still rejects the reserved descriptor bit', () => {
  const root = mkdtempSync(join(tmpdir(), 'cmem-zstd-reserved-'));
  try {
    const frame = zstdCompressSync(Buffer.from('fixture'));
    frame[4] |= 0x08;
    const file = join(root, 'session.jsonl.zstd');
    writeFileSync(file, frame);
    expect(() => scanZstdFramesInFile(file, 0, frame.length)).toThrow('reserved Zstandard frame-header bit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
