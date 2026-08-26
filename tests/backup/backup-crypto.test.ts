
// Pro-backup plan Phase 3: streaming AES-256-GCM file crypto. Round-trips a
// multi-megabyte random file byte-identical, and proves the GCM auth tag
// actually protects the ciphertext: any tampered byte (ciphertext, tag, or
// nonce) and any wrong key must reject.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  decryptFile,
  encryptFile,
  mintEncryptionKeyBase64,
  NONCE_BYTES,
  TAG_BYTES,
} from '../../src/services/backup/backup-crypto.js';

const MULTI_MB = 3 * 1024 * 1024 + 12345; // deliberately not block-aligned

let tempRoot: string;
let srcPath: string;
let srcSha256: string;
const key = mintEncryptionKeyBase64();

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-backup-crypto-'));
  srcPath = join(tempRoot, 'source.db');
  writeFileSync(srcPath, randomBytes(MULTI_MB));
  srcSha256 = sha256(srcPath);
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('backup-crypto', () => {
  it('round-trips a multi-MB random file byte-identical', async () => {
    const encPath = join(tempRoot, 'roundtrip.enc');
    const outPath = join(tempRoot, 'roundtrip.out');

    await encryptFile(srcPath, encPath, key);
    // Format: <12B nonce><ciphertext><16B tag> — same length as plaintext + 28.
    expect(statSync(encPath).size).toBe(MULTI_MB + NONCE_BYTES + TAG_BYTES);
    // Ciphertext must not contain the plaintext verbatim.
    expect(sha256(encPath)).not.toBe(srcSha256);

    await decryptFile(encPath, outPath, key);
    expect(statSync(outPath).size).toBe(MULTI_MB);
    expect(sha256(outPath)).toBe(srcSha256);
  });

  it('uses a fresh random nonce per encryption (same input, different ciphertext)', async () => {
    const encA = join(tempRoot, 'nonce-a.enc');
    const encB = join(tempRoot, 'nonce-b.enc');
    await encryptFile(srcPath, encA, key);
    await encryptFile(srcPath, encB, key);
    expect(sha256(encA)).not.toBe(sha256(encB));
  });

  it('rejects tampered ciphertext (auth tag mismatch)', async () => {
    const encPath = join(tempRoot, 'tampered.enc');
    await encryptFile(srcPath, encPath, key);

    const tampered = readFileSync(encPath);
    const middle = Math.floor(tampered.length / 2);
    tampered[middle] = tampered[middle] ^ 0xff;
    writeFileSync(encPath, tampered);

    await expect(decryptFile(encPath, join(tempRoot, 'tampered.out'), key)).rejects.toThrow();
  });

  it('rejects a tampered auth tag', async () => {
    const encPath = join(tempRoot, 'tampered-tag.enc');
    await encryptFile(srcPath, encPath, key);

    const tampered = readFileSync(encPath);
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0x01;
    writeFileSync(encPath, tampered);

    await expect(decryptFile(encPath, join(tempRoot, 'tampered-tag.out'), key)).rejects.toThrow();
  });

  it('rejects decryption with the wrong key', async () => {
    const encPath = join(tempRoot, 'wrong-key.enc');
    await encryptFile(srcPath, encPath, key);
    const otherKey = mintEncryptionKeyBase64();
    await expect(decryptFile(encPath, join(tempRoot, 'wrong-key.out'), otherKey)).rejects.toThrow();
  });

  it('rejects keys that do not decode to 32 bytes', async () => {
    const shortKey = Buffer.from('too-short').toString('base64');
    await expect(encryptFile(srcPath, join(tempRoot, 'short-key.enc'), shortKey)).rejects.toThrow('32 bytes');
  });

  it('rejects an encrypted file too short to hold nonce and tag', async () => {
    const stub = join(tempRoot, 'truncated.enc');
    writeFileSync(stub, randomBytes(NONCE_BYTES + TAG_BYTES - 1));
    await expect(decryptFile(stub, join(tempRoot, 'truncated.out'), key)).rejects.toThrow('too short');
  });

  it('round-trips an empty file (tag still verified)', async () => {
    const emptySrc = join(tempRoot, 'empty.db');
    writeFileSync(emptySrc, '');
    const encPath = join(tempRoot, 'empty.enc');
    const outPath = join(tempRoot, 'empty.out');

    await encryptFile(emptySrc, encPath, key);
    expect(statSync(encPath).size).toBe(NONCE_BYTES + TAG_BYTES);
    await decryptFile(encPath, outPath, key);
    expect(statSync(outPath).size).toBe(0);

    await expect(decryptFile(encPath, outPath, mintEncryptionKeyBase64())).rejects.toThrow();
  });
});
