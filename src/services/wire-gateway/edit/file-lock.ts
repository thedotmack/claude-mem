// SPDX-License-Identifier: Apache-2.0
//
// A cross-process lock around a file's read-modify-write. Generalized from
// routes.ts (Phase 2) so every wire-gateway file edited by more than one
// claude-mem process (routes.json, wiring/applied.json, wiring/stash.json,
// privacy/consent.json, library/library.json) shares one implementation.
//
// A lock is broken only when its holder is proven gone: the lock file names
// the holder (pid, host, the process's start token), and a waiter breaks it
// only when that process no longer exists on this host, or its pid now
// names another process (pid reuse). A live holder keeps its lock however
// long it stalls (a suspended laptop, a slow disk, a debugger), so a waiter
// can never roll back or overwrite a change that is still being made; the
// waiter fails loudly instead, naming the holder. Elapsed time alone breaks
// nothing — except a lock file that is still empty, see
// FILE_LOCK_EMPTY_STALE_MS.

import { randomBytes } from 'crypto';
import { hostname } from 'os';
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname } from 'path';
import { sleepSync } from '../../../shared/atomic-json.js';
import { WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE } from '../../../shared/paths.js';
import { captureProcessStartToken, isSameProcess } from '../../../shared/process-identity.js';

/**
 * A lock file is created empty (O_CREAT|O_EXCL) and its holder's identity is
 * written by the very next call. One still empty after this long belongs to
 * a process that died between those two calls, the only case judged by time.
 * 10 s is the value the time-based rule used before (and that
 * observer-health.ts and worker-spawn-gate.ts use), thousands of times the
 * one write the window spans.
 */
const FILE_LOCK_EMPTY_STALE_MS = 10_000;
/**
 * How long a waiter waits for a live holder before failing loudly with the
 * holder's pid. The longest critical sections are Library changes, which
 * read and write a few config files (measured: at most 7.1 ms per hold of
 * library.json's lock across the harness-installers and codex-cli-installer
 * tests); 15 s, kept from Phase 2's routes.json lock, leaves room for a
 * disk thousands of times slower, while a user command blocked behind a
 * hung holder still reports it instead of hanging.
 */
const FILE_LOCK_MAX_WAIT_MS = 15_000;
/** Poll interval while waiting: at most 100 stat/read calls a second, and a released lock is taken within 10 ms. */
const FILE_LOCK_RETRY_MS = 10;

/** What a lock file holds: the holder's identity. */
export interface FileLockOwner {
  /** Unique per acquisition, so a holder never releases or claims a lock another acquisition took. */
  token: string;
  pid: number;
  host: string;
  /** The process's start token (shared/process-identity.ts), or null when the platform could not read it. */
  startToken: string | null;
}

/** The lock a `mutate` runs under. */
export interface ExclusiveFileLockHandle {
  readonly lockPath: string;
  /**
   * Throws unless this acquisition still holds the lock. Call it before a
   * write that must only happen under the lock (a commit): a lock taken away
   * (deleted by hand, or broken by a waiter that judged its holder gone)
   * means another process may already have acted on the file.
   */
  assertStillHeld(): void;
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** This process's start token, read once: a process's own start token cannot change while it runs. */
let ownStartToken: string | null | undefined;
function thisProcessStartToken(): string | null {
  if (ownStartToken === undefined) ownStartToken = captureProcessStartToken(process.pid);
  return ownStartToken;
}

/** Read a lock file's holder. Legacy locks (`<pid>.<hex>`, before identities were recorded) name only a pid on this host. */
export function parseFileLockOwner(content: string): FileLockOwner | null {
  if (content.length === 0) return null;
  const legacy = /^(\d+)\.[0-9a-f]+$/.exec(content);
  if (legacy) return { token: content, pid: Number(legacy[1]), host: hostname(), startToken: null };
  try {
    const parsed = JSON.parse(content) as Partial<FileLockOwner>;
    if (typeof parsed.token === 'string' && Number.isInteger(parsed.pid) && typeof parsed.host === 'string') {
      return { token: parsed.token, pid: parsed.pid!, host: parsed.host, startToken: typeof parsed.startToken === 'string' ? parsed.startToken : null };
    }
  } catch {
    // Not JSON: handled below as an unrecognized holder (never broken).
  }
  return { token: content, pid: 0, host: '', startToken: null };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, owned by another user.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

type HolderVerdict = { gone: true; why: string } | { gone: false; holder: string };

/** Whether a lock's holder is proven gone. Anything that cannot be proven (another host, an unreadable identity) is alive. */
function judgeHolder(owner: FileLockOwner | null, lockMtimeMs: number): HolderVerdict {
  if (owner === null) {
    return Date.now() - lockMtimeMs > FILE_LOCK_EMPTY_STALE_MS
      ? { gone: true, why: 'its holder died before writing its identity' }
      : { gone: false, holder: 'a process that is taking it now' };
  }
  if (owner.pid <= 0) return { gone: false, holder: 'an unrecognized holder' };
  if (owner.host !== hostname()) return { gone: false, holder: `pid ${owner.pid} on host ${owner.host}` };
  if (!processExists(owner.pid)) return { gone: true, why: `process ${owner.pid} no longer exists` };
  if (owner.startToken !== null && !isSameProcess(owner.pid, owner.startToken)) return { gone: true, why: `pid ${owner.pid} now names another process` };
  return { gone: false, holder: `process ${owner.pid}` };
}

/**
 * Take a dead holder's lock away. The lock is first renamed aside, so it is
 * removed only if it is still the very lock judged dead; a lock that changed
 * hands in between is linked back (link never replaces), and if a new lock
 * already took its place the waiter fails loudly rather than guess.
 */
function breakDeadLock(lockPath: string, judgedContent: string, breakerToken: string): void {
  const aside = `${lockPath}.breaking-${breakerToken}`;
  try {
    renameSync(lockPath, aside);
  } catch (error) {
    if (isMissingFileError(error)) return; // Released, or another waiter broke it first.
    throw error;
  }
  const content = readFileSync(aside, 'utf-8');
  if (content === judgedContent) {
    unlinkSync(aside);
    return;
  }
  try {
    linkSync(aside, lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      unlinkSync(aside);
      throw new Error(`${lockPath} changed hands while a dead holder's lock was being broken; the holder that lost it will refuse to commit. Try again.`);
    }
    throw error;
  }
  unlinkSync(aside);
}

function readLockContent(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, 'utf-8');
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

/**
 * Hold `<lockedFilePath>.lock` across `mutate`, so two processes cannot each
 * write back a copy missing the other's change. The `wx` (O_CREAT|O_EXCL)
 * lock is the pattern of observer-health.ts withLedgerLock and
 * worker-spawn-gate.ts, but it fails loud: an edit that cannot be serialized
 * is refused, never written unlocked, and a live holder's lock is never
 * broken (see the file comment).
 */
export function withExclusiveFileLock<T>(lockedFilePath: string, mutate: (lock: ExclusiveFileLockHandle) => T): T {
  const lockPath = `${lockedFilePath}.lock`;
  const owner: FileLockOwner = { token: randomBytes(12).toString('hex'), pid: process.pid, host: hostname(), startToken: thisProcessStartToken() };
  const ownerContent = JSON.stringify(owner);
  const deadline = Date.now() + FILE_LOCK_MAX_WAIT_MS;
  // isSameProcess spawns `ps` on macOS: judge each lock content once, not every poll.
  let judged: { content: string; verdict: HolderVerdict } | null = null;
  for (;;) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
      writeFileSync(lockPath, ownerContent, { flag: 'wx', mode: WIRE_GATEWAY_FILE_MODE });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const content = readLockContent(lockPath);
    if (content === null) continue; // The holder released between our create and the read.
    let lockMtimeMs: number;
    try {
      lockMtimeMs = statSync(lockPath).mtimeMs;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      continue;
    }
    // An empty lock is re-judged each poll (its verdict depends on its age).
    const verdict: HolderVerdict = judged && judged.content === content && content.length > 0 ? judged.verdict : judgeHolder(parseFileLockOwner(content), lockMtimeMs);
    judged = { content, verdict };
    if (verdict.gone) {
      breakDeadLock(lockPath, content, owner.token);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${basename(lockedFilePath)} is locked by another claude-mem process (${verdict.holder}; ${lockPath}). Try again when it finishes. If that process is not claude-mem or is gone, delete ${lockPath}.`);
    }
    sleepSync(FILE_LOCK_RETRY_MS);
  }
  const handle: ExclusiveFileLockHandle = {
    lockPath,
    assertStillHeld() {
      if (readLockContent(lockPath) !== ownerContent) {
        throw new Error(`lost the lock on ${basename(lockedFilePath)} (${lockPath}): another process removed or took it while this change was running, so nothing more is written. Check ${lockedFilePath} and try again.`);
      }
    },
  };
  let mutated = false;
  try {
    const result = mutate(handle);
    mutated = true;
    return result;
  } finally {
    const lostLock = releaseFileLockIfOwned(lockPath, ownerContent);
    // Reported only when mutate itself succeeded: its own error says more.
    if (lostLock && mutated) {
      throw new Error(`lost the lock on ${basename(lockedFilePath)} (${lockPath}) before this change finished: another process may have edited ${lockedFilePath} at the same time. Check it and try again.`);
    }
  }
}

/** Remove the lock if this acquisition still holds it. Returns true when it no longer did (lost). */
function releaseFileLockIfOwned(lockPath: string, ownerContent: string): boolean {
  const currentContent = readLockContent(lockPath);
  if (currentContent !== ownerContent) return true;
  unlinkSync(lockPath);
  return false;
}
