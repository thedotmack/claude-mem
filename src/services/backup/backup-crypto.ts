/**
 * Streaming AES-256-GCM file encryption for cloud backups (pro-backup plan
 * Phase 3). Pure node:crypto + node:fs — no new dependencies, unit-testable
 * without any claude-mem runtime.
 *
 * On-disk format: `<12-byte random nonce><ciphertext><16-byte GCM auth tag>`.
 * Everything is streamed (snapshots are 600MB+): encrypt pipes
 * read → cipher → write and appends the tag after the cipher finalizes;
 * decrypt reads the nonce and trailing tag with positioned reads, then pipes
 * only the ciphertext window through the decipher. A tampered ciphertext or
 * wrong key fails the GCM tag check and rejects — no partial plaintext is
 * ever reported as success (the destination file may exist but the promise
 * rejects).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, closeSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ALGORITHM = 'aes-256-gcm';

/** Decode and validate a base64 AES-256 key (exactly 32 bytes). */
function keyFromBase64(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`Backup encryption key must decode to ${KEY_BYTES} bytes (got ${key.length})`);
  }
  return key;
}

/** Mint a fresh random AES-256 key, base64-encoded for settings.json. */
export function mintEncryptionKeyBase64(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/**
 * Encrypt srcPath into destPath as `<nonce><ciphertext><tag>`. Streaming:
 * the source is never buffered whole. Rejects on any stream error.
 */
export async function encryptFile(srcPath: string, destPath: string, keyBase64: string): Promise<void> {
  const key = keyFromBase64(keyBase64);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const source = createReadStream(srcPath);
  const dest = createWriteStream(destPath);

  await new Promise<void>((resolve, reject) => {
    const fail = (err: unknown) => {
      source.destroy();
      dest.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    source.on('error', fail);
    cipher.on('error', fail);
    dest.on('error', fail);
    dest.write(nonce);
    // end: false — the tag can only be appended AFTER the cipher finalizes.
    source.pipe(cipher).pipe(dest, { end: false });
    cipher.on('end', () => {
      dest.end(cipher.getAuthTag(), () => resolve());
    });
  });
}

/**
 * Decrypt srcPath (in `<nonce><ciphertext><tag>` format) into destPath.
 * Streaming: only the nonce and tag are read with positioned reads; the
 * ciphertext window is piped through the decipher. Rejects when the auth tag
 * does not verify (tampered ciphertext or wrong key).
 */
export async function decryptFile(srcPath: string, destPath: string, keyBase64: string): Promise<void> {
  const key = keyFromBase64(keyBase64);
  const { size } = statSync(srcPath);
  if (size < NONCE_BYTES + TAG_BYTES) {
    throw new Error(`Encrypted file too short to contain nonce and auth tag (${size} bytes)`);
  }

  const nonce = Buffer.alloc(NONCE_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  const fd = openSync(srcPath, 'r');
  try {
    readSync(fd, nonce, 0, NONCE_BYTES, 0);
    readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    closeSync(fd);
  }

  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  if (size === NONCE_BYTES + TAG_BYTES) {
    // Empty plaintext: no ciphertext window to stream, but the tag must
    // still verify (final() throws otherwise) and destPath must exist.
    decipher.final();
    writeFileSync(destPath, Buffer.alloc(0));
    return;
  }
  // `end` is inclusive: the ciphertext window is [NONCE_BYTES, size - TAG_BYTES).
  const source = createReadStream(srcPath, { start: NONCE_BYTES, end: size - TAG_BYTES - 1 });
  const dest = createWriteStream(destPath);
  await pipeline(source, decipher, dest);
}
