// SPDX-License-Identifier: Apache-2.0
//
// A cross-process lock around a file's read-modify-write. Generalized from
// routes.ts (Phase 2) so every wire-gateway file edited by more than one
// claude-mem process (routes.json, wiring/applied.json, wiring/stash.json)
// shares one implementation.

import { randomBytes } from 'crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname } from 'path';
import { WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE } from '../../../shared/paths.js';

/** A holder that has not released within this window is presumed dead. */
const FILE_LOCK_STALE_MS = 10_000;
const FILE_LOCK_MAX_WAIT_MS = 15_000;
const FILE_LOCK_RETRY_MS = 10;

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Hold `<lockedFilePath>.lock` across `mutate`, so two processes cannot each
 * write back a copy missing the other's change. The `wx` (O_CREAT|O_EXCL)
 * lock with mtime staleness is the pattern of observer-health.ts
 * withLedgerLock and worker-spawn-gate.ts, but it fails loud: an edit that
 * cannot be serialized is refused, never written unlocked.
 */
export function withExclusiveFileLock<T>(lockedFilePath: string, mutate: () => T): T {
  const lockPath = `${lockedFilePath}.lock`;
  // Unique per acquisition, so a holder whose lock was broken as stale never
  // releases the lock a waiter took after it.
  const ownerToken = `${process.pid}.${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + FILE_LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
      writeFileSync(lockPath, ownerToken, { flag: 'wx', mode: WIRE_GATEWAY_FILE_MODE });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let lockMtimeMs: number;
    try {
      lockMtimeMs = statSync(lockPath).mtimeMs;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      continue; // The holder released between our create and the stat.
    }
    if (Date.now() - lockMtimeMs > FILE_LOCK_STALE_MS) {
      try {
        if (statSync(lockPath).mtimeMs === lockMtimeMs) unlinkSync(lockPath);
      } catch (error) {
        // A competing waiter broke it first; the loop re-evaluates. Anything
        // else (a lock we may not remove) must not spin here forever.
        if (!isMissingFileError(error)) throw error;
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${basename(lockedFilePath)} is locked by another claude-mem process (${lockPath}); try again`);
    }
    sleepSync(FILE_LOCK_RETRY_MS);
  }
  try {
    return mutate();
  } finally {
    releaseFileLockIfOwned(lockPath, ownerToken);
  }
}

function releaseFileLockIfOwned(lockPath: string, ownerToken: string): void {
  let currentToken: string;
  try {
    currentToken = readFileSync(lockPath, 'utf-8');
  } catch (error) {
    if (isMissingFileError(error)) return; // Broken as stale by a waiter.
    throw error;
  }
  if (currentToken === ownerToken) unlinkSync(lockPath);
}
