// SPDX-License-Identifier: Apache-2.0
//
// End-to-end encryption for cloud sync (CLAUDE_MEM_CLOUD_SYNC_E2E=true).
//
// The hub stores and relays sealed payloads it cannot read. Only the envelope
// (id, kind, entity_rev, deleted, origin ids, hashes) stays in the clear, and
// it is bound to the ciphertext as AES-GCM associated data, so a sealed
// payload cannot be replayed under another entity or revision.
//
// Sealing is DETERMINISTIC: the nonce is an HMAC of (aad, plaintext). The same
// row at the same revision always seals to the same bytes. The sync protocol
// depends on that: the hub rejects a different body at an already-acked
// revision (revision_hash_conflict), and CloudSync.reconcileAckedContent
// rebuilds an acked op and compares hashes before stamping it. Distinct
// (aad, plaintext) pairs get distinct nonces, so GCM nonces never repeat
// across different messages under one key.
//
// Key: 32 random bytes in <data dir>/sync-e2e.key (0600). Every device of the
// user holds the same key; losing it makes hub data unreadable.

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from '../../shared/paths.js';

export const E2E_ALG = 'cmem-e2e-v1';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_STRING_PREFIX = `${E2E_ALG}:`;

export interface SealedPayload {
  alg: typeof E2E_ALG;
  kid: string;
  n: string;
  ct: string;
}

export class E2EError extends Error {}

export class E2ECodec {
  readonly keyId: string;
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== KEY_BYTES) throw new E2EError(`E2E key must be ${KEY_BYTES} bytes`);
    this.keyId = keyIdFor(masterKey);
    this.encKey = Buffer.from(hkdfSync('sha256', masterKey, E2E_ALG, 'enc', KEY_BYTES));
    this.macKey = Buffer.from(hkdfSync('sha256', masterKey, E2E_ALG, 'mac', KEY_BYTES));
  }

  /** `plaintext` is canonical JSON; `aad` binds the ciphertext to its envelope. */
  seal(plaintext: string, aad: string): SealedPayload {
    const nonce = createHmac('sha256', this.macKey)
      .update(aad, 'utf8')
      .update(Buffer.from([0]))
      .update(plaintext, 'utf8')
      .digest()
      .subarray(0, NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { alg: E2E_ALG, kid: this.keyId, n: nonce.toString('base64url'), ct: ct.toString('base64url') };
  }

  open(sealed: unknown, aad: string): string {
    assertSealedPayload(sealed);
    if (sealed.kid !== this.keyId) {
      throw new E2EError(`sealed with a different key (kid ${sealed.kid}, local ${this.keyId})`);
    }
    const nonce = Buffer.from(sealed.n, 'base64url');
    const data = Buffer.from(sealed.ct, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch {
      throw new E2EError('ciphertext failed authentication (tampered, or envelope mismatch)');
    }
  }
}

const KID = /^[0-9a-f]{16}$/;
const NONCE_B64 = /^[A-Za-z0-9_-]{16}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

export function isSealedPayload(value: unknown): value is SealedPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 4
    && keys[0] === 'alg' && keys[1] === 'ct' && keys[2] === 'kid' && keys[3] === 'n'
    && record.alg === E2E_ALG
    && typeof record.kid === 'string' && KID.test(record.kid)
    && typeof record.n === 'string' && NONCE_B64.test(record.n)
    && typeof record.ct === 'string' && B64URL.test(record.ct) && record.ct.length >= 22;
}

export function assertSealedPayload(value: unknown): asserts value is SealedPayload {
  if (!isSealedPayload(value)) throw new E2EError(`expected a ${E2E_ALG} sealed payload`);
}

function keyIdFor(masterKey: Buffer): string {
  return createHash('sha256').update(masterKey).digest('hex').slice(0, 16);
}

export function e2eKeyPath(): string {
  return join(resolveDataDir(), 'sync-e2e.key');
}

export function generateE2EKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Portable form for copying the key to another device: `cmem-e2e-v1:<base64url>`. */
export function encodeE2EKey(key: Buffer): string {
  return `${KEY_STRING_PREFIX}${key.toString('base64url')}`;
}

export function decodeE2EKey(text: string): Buffer {
  const trimmed = text.trim();
  if (!trimmed.startsWith(KEY_STRING_PREFIX)) throw new E2EError(`key must start with ${KEY_STRING_PREFIX}`);
  const key = Buffer.from(trimmed.slice(KEY_STRING_PREFIX.length), 'base64url');
  if (key.length !== KEY_BYTES) throw new E2EError(`key must decode to ${KEY_BYTES} bytes`);
  return key;
}

/** Reads the key file; null when it does not exist. Throws when it is malformed. */
export function readE2EKey(path = e2eKeyPath()): Buffer | null {
  if (!existsSync(path)) return null;
  return decodeE2EKey(readFileSync(path, 'utf8'));
}

/** Writes a new key file; refuses to overwrite one that exists. */
export function writeE2EKey(key: Buffer, path = e2eKeyPath()): void {
  writeFileSync(path, `${encodeE2EKey(key)}\n`, { mode: 0o600, flag: 'wx' });
}
