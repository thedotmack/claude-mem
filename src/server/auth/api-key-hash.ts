// SPDX-License-Identifier: Apache-2.0
//
// #2541 — salted, slow, timing-safe KDF for API-key storage, shared by both
// auth backends (bun:sqlite in sqlite-api-key-service.ts, Postgres in
// middleware/postgres-auth.ts). Pure crypto only: no database imports, so the
// Postgres server runtime keeps its "pool-only" dependency boundary.
//
// API keys were stored as unsalted single-round SHA-256, which is offline-
// crackable if the DB leaks. We use node's built-in `crypto.scryptSync` rather
// than argon2 — argon2 is a native dependency that would break the esbuild
// bundle, and is not currently a project dependency. scryptSync satisfies
// #2541's requirements:
//   - SALTED:      per-key 16-byte random salt defeats rainbow tables.
//   - SLOW:        scrypt is memory-hard (N=16384) so brute force is costly.
//   - TIMING-SAFE: comparison uses constant-time crypto.timingSafeEqual.
//
// Stored format for new keys: `scrypt$<N>$<saltHex>$<derivedHex>`.

import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { logger } from '../../utils/logger.js';

const SCRYPT_SALTED_PREFIX = 'scrypt';
const SCRYPT_COST = 16384; // N — must be a power of 2.
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

// Bounded concurrency so a burst of failed verifications cannot queue an
// unbounded number of scrypt derivations on the libuv thread pool (default 4)
// or block the main thread. A waiting request holds only a promise; in-flight
// derivations stay capped, and fs/dns work elsewhere keeps flowing.
const SCRYPT_MAX_CONCURRENT = 4;
// Abuse protection: without a cap, a caller who knows a key's 10-char prefix
// can queue unlimited failing derivations and starve every other request that
// needs one. 64 waiters drain through 4 slots in 16 rounds, i.e. at most
// ~0.8-1.6 s of queueing at the ~50-100 ms per derivation of N=16384. Past the
// cap the request fails loudly (ScryptQueueFullError -> HTTP 503) instead of
// waiting. Keys already verified skip scrypt entirely (verified-key cache in
// middleware/postgres-auth.ts), so a flood does not lock out valid callers.
export const SCRYPT_MAX_WAITERS = 64;
let scryptInFlight = 0;
const scryptWaiters: Array<() => void> = [];

export class ScryptQueueFullError extends Error {
  constructor() {
    super(`API key verification queue is full (${SCRYPT_MAX_WAITERS} waiting); retry shortly`);
    this.name = 'ScryptQueueFullError';
  }
}

async function acquireScryptSlot(): Promise<void> {
  if (scryptInFlight < SCRYPT_MAX_CONCURRENT) {
    scryptInFlight++;
    return;
  }
  if (scryptWaiters.length >= SCRYPT_MAX_WAITERS) {
    throw new ScryptQueueFullError();
  }
  await new Promise<void>(resolve => scryptWaiters.push(resolve));
  // Slot handed off by release(): scryptInFlight already accounts for it.
}
function releaseScryptSlot(): void {
  const next = scryptWaiters.shift();
  if (next) next(); // hand off: count stays
  else scryptInFlight--;
}

/**
 * #2541 — async variant of verifyRawKeyAgainstStoredHash. Salted scrypt
 * derivation is intentionally slow (~100 ms); running it synchronously on the
 * event loop while unauthenticated / failed requests keep arriving is exactly
 * how a prefix-known caller stalls every other request on the server.
 * This runs each derivation on the thread pool with bounded concurrency so the
 * event loop never blocks.
 */
export async function verifyRawKeyAgainstStoredHashAsync(rawKey: string, storedHash: string): Promise<boolean> {
  if (isSaltedHash(storedHash)) {
    const parts = storedHash.split('$');
    if (parts.length !== 4) {
      return false;
    }
    const [, costStr, saltHex, expectedHex] = parts;
    const cost = Number.parseInt(costStr, 10);
    if (!Number.isInteger(cost) || cost <= 0) {
      return false;
    }
    await acquireScryptSlot();
    try {
      const derivedHex = await new Promise<string>((resolve, reject) => {
        scrypt(rawKey, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN, { N: cost }, (err, derived) =>
          err ? reject(err) : resolve(derived.toString('hex')));
      });
      return safeEqualHex(derivedHex, expectedHex);
    } catch {
      return false;
    } finally {
      releaseScryptSlot();
    }
  }
  // Legacy unsalted SHA-256 path: hash is fast (~1 ms), no thread pool needed.
  return safeEqualHex(hashApiKeyLegacySha256(rawKey), storedHash);
}

/** The non-secret key prefix length used for candidate narrowing (first 10 chars). */
export const API_KEY_PREFIX_LENGTH = 10;

/** New salted hash, used for every newly-created key. */
export function hashApiKey(rawKey: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = scryptSync(rawKey, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST });
  return `${SCRYPT_SALTED_PREFIX}$${SCRYPT_COST}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Async variant of hashApiKey for use inside request handling (the legacy-key
 * re-hash on first successful verify). Same format and parameters; derivation
 * runs on the thread pool so the event loop stays free.
 */
export async function hashApiKeyAsync(rawKey: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  await acquireScryptSlot();
  try {
    const derived = await new Promise<Buffer>((resolve, reject) => {
      scrypt(rawKey, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST }, (err, key) =>
        err ? reject(err) : resolve(key));
    });
    return `${SCRYPT_SALTED_PREFIX}$${SCRYPT_COST}$${salt.toString('hex')}$${derived.toString('hex')}`;
  } finally {
    releaseScryptSlot();
  }
}

/** Legacy unsalted SHA-256 — retained ONLY so existing keys keep verifying. Never used to write a new key. */
export function hashApiKeyLegacySha256(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export function isSaltedHash(storedHash: string): boolean {
  return storedHash.startsWith(`${SCRYPT_SALTED_PREFIX}$`);
}

/** The non-secret prefix a raw key narrows candidate lookups by. */
export function apiKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, API_KEY_PREFIX_LENGTH);
}

function safeEqualHex(a: string, b: string): boolean {
  // timingSafeEqual throws on length mismatch; pre-check length (lengths are
  // not secret) then compare in constant time for equal-length inputs.
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('HTTP', 'timing-safe hash comparison failed (malformed hex input)', {}, err);
    return false;
  }
}

/**
 * Timing-safe verification that detects the stored format. New keys use the
 * salted scrypt scheme; legacy keys use unsalted SHA-256. Both paths compare
 * in constant time.
 */
export function verifyRawKeyAgainstStoredHash(rawKey: string, storedHash: string): boolean {
  if (isSaltedHash(storedHash)) {
    const parts = storedHash.split('$');
    if (parts.length !== 4) {
      return false;
    }
    const [, costStr, saltHex, expectedHex] = parts;
    const cost = Number.parseInt(costStr, 10);
    if (!Number.isInteger(cost) || cost <= 0) {
      return false;
    }
    let derivedHex: string;
    try {
      const salt = Buffer.from(saltHex, 'hex');
      derivedHex = scryptSync(rawKey, salt, SCRYPT_KEYLEN, { N: cost }).toString('hex');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn('HTTP', 'scrypt derivation failed for stored API key hash (malformed salt or cost)', { cost }, err);
      return false;
    }
    return safeEqualHex(derivedHex, expectedHex);
  }
  // Legacy unsalted SHA-256 path.
  return safeEqualHex(hashApiKeyLegacySha256(rawKey), storedHash);
}