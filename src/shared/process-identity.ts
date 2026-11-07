/**
 * Process identity (start token) — the primitive that makes PID-based
 * teardown safe.
 *
 * A bare PID is not a stable handle: the OS reissues numbers, so a PID
 * recorded at snapshot time can name a completely unrelated process by the
 * time a kill is issued. Every teardown path in this codebase that holds a PID
 * across a wait therefore pairs it with a start token and revalidates before
 * signalling.
 *
 * Lives in shared/ rather than supervisor/ because src/shared/kill-process-tree.ts
 * needs it and process-registry.ts already imports THAT — putting it there
 * would close an import cycle. process-registry re-exports it, so existing
 * callers are unaffected.
 */

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { logger } from '../utils/logger.js';
import { sanitizeEnv } from '../supervisor/env-sanitizer.js';

// Windows lacks a cheap /proc-style start-time read and `ps lstart`, so we
// shell to PowerShell's CIM (wmic is removed on Windows 11). The lookup is
// ~100-300ms, so cache per-pid for 5s to avoid re-shelling when the same PID
// is validated repeatedly within one spawn-decision window.
const WINDOWS_START_TOKEN_CACHE_TTL_MS = 5_000;
const windowsStartTokenCache = new Map<number, { token: string | null; capturedAtMs: number }>();

/**
 * Count of RAW platform reads (cache misses and deliberate bypasses alike).
 *
 * DELIBERATE TEST SEAM, kept after review rather than fenced. It is a
 * monotonic read-only counter: calling it cannot mutate state, change a
 * verdict, or affect any kill decision, so there is nothing for a non-test
 * caller to abuse. It exists because "isSameProcess must re-read the OS on
 * every authorization" is otherwise unobservable from outside — and that
 * property is what stops a cached verdict certifying a reused PID
 * (round 6). Removing it would delete a real gate to save zero risk.
 *
 * The double-underscore prefix marks it as non-API; nothing in src/ imports it.
 */
let rawProbeCount = 0;
export function __identityProbeCountForTesting(): number {
  return rawProbeCount;
}

/**
 * Reads a start token out of a spawnSync result, treating a missing or
 * non-string stdout as "no token" instead of dereferencing it.
 *
 * A probe that the OS kills — a timeout is the common way — comes back with an
 * absent `stdout`. `result.stdout.trim()` then throws; on Bun the engine words
 * it as "TypeError: undefined is not a function", so the probe crashes instead
 * of degrading, and on Windows that removed the PID-reuse guard the token
 * exists to provide (#4145).
 *
 * A null token is safe here: isSameProcess reads it as "proceed", strictly
 * narrower than a false match. But a probe that reports success (status 0) and
 * still hands back no usable stdout is a genuine degrade — the host silently
 * loses reuse protection — so that one case is logged above debug rather than
 * swallowed. A status-0 read with an EMPTY string is the normal "process is
 * gone" answer and stays quiet.
 */
export function startTokenFromSpawnResult(
  source: string,
  pid: number,
  result: { status: number | null; stdout?: unknown }
): string | null {
  if (result.status !== 0) return null;
  if (typeof result.stdout !== 'string') {
    logger.warn('SYSTEM', 'captureProcessStartToken: start-token probe returned no stdout', {
      pid,
      source,
      status: result.status
    });
    return null;
  }
  const trimmed = result.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Spawn env for every start-token probe (and the process-name probes, so the
 * spawn-env discipline stays one rule): locale-pinned as before, and now
 * time-zone-pinned too. Exported so the pin is asserted by test instead of
 * trusted across every call site (#5311).
 *
 * On Windows the TZ entry is inert — .NET's CIM conversion follows the system
 * zone, not the env — so the Windows token shape is unchanged by this helper.
 * The pin carries the darwin/BSD `ps lstart` reads, where the calling
 * process's zone used to leak straight into the token.
 */
export function startTokenProbeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
}

/**
 * Prefix stamped on every darwin/BSD `ps lstart` token captured since the TZ
 * pin, and the discriminator for migrating records written before it (#5311).
 *
 * `ps` prints `lstart` in the time zone of the calling process. The spawn env
 * used to pin only the locale (LC_ALL/LANG), so a worker and a later check
 * running under different zones captured different strings for the same
 * process. The ownership check then misread the skew as PID reuse, the PID
 * file resolved to null, and the version-mismatch recycle refused to kill the
 * stale worker — forever, because only that recycle could replace it.
 *
 * Pinning TZ going forward cannot repair records already on disk: they hold
 * local-time strings in the very same `EEE MMM d HH:mm:ss yyyy` shape,
 * indistinguishable from a UTC-pinned read. The prefix separates the eras, so
 * comparisons can tell two pinned tokens that differ (PID reuse) from a
 * cross-era mismatch, which counts as the same process only when the two times
 * differ by a possible UTC offset (see isSameProcessStartToken).
 *
 * Linux needs none of this — its token is the numeric /proc starttime,
 * already zone-independent — and Windows keeps its CIM format untouched, so
 * both stay unprefixed and keep comparing byte-for-byte across the upgrade.
 */
export const UTC_START_TOKEN_PREFIX = 'utc:';

/** True when `token` was captured under the TZ pin (see UTC_START_TOKEN_PREFIX). */
export function isUtcPinnedStartToken(token: string): boolean {
  return token.startsWith(UTC_START_TOKEN_PREFIX);
}

/** Stamps a raw `ps lstart` read with the UTC-pin prefix. */
export function withUtcStartTokenPrefix(rawToken: string): string {
  return `${UTC_START_TOKEN_PREFIX}${rawToken}`;
}

// Every UTC offset in use today is a whole multiple of 15 minutes (Nepal is +5:45).
const UTC_OFFSET_STEP_MS = 15 * 60_000;
// The largest UTC offset in use today is UTC+14 (Line Islands); the most negative is UTC-12.
const MAX_UTC_OFFSET_MS = 14 * 60 * 60_000;
const LSTART_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The wall-clock reading of `EEE MMM d HH:mm:ss yyyy` in ms, or null for any other shape. */
function parseLstartWallClockMs(rawToken: string): number | null {
  const match = rawToken.match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  if (!match) return null;
  const month = LSTART_MONTHS.indexOf(match[1]!);
  if (month === -1) return null;
  return Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
}

/**
 * True when two tokens from different eras can name one start instant: their
 * wall-clock readings differ by a possible UTC offset. A reused PID has its own
 * start time, so it passes only by coincidence (within 14 hours and on the same
 * second modulo 15 minutes). A token that does not parse is no proof, so it is
 * a mismatch; that covers Linux and Windows tokens, which never cross eras.
 */
function differsOnlyByUtcOffset(firstToken: string, secondToken: string): boolean {
  const first = parseLstartWallClockMs(firstToken.replace(UTC_START_TOKEN_PREFIX, ''));
  const second = parseLstartWallClockMs(secondToken.replace(UTC_START_TOKEN_PREFIX, ''));
  if (first === null || second === null) return false;
  const skewMs = Math.abs(first - second);
  return skewMs <= MAX_UTC_OFFSET_MS && skewMs % UTC_OFFSET_STEP_MS === 0;
}

/**
 * The ownership verdict for two captured start tokens.
 *
 * Fallback semantics match isSameProcess: an unreadable token (null) on either
 * side proceeds. Two readable tokens from the same era must be equal. Across
 * eras, a token without the prefix is a record written before the pin: a
 * local-time string that a UTC read can never reproduce, even for the same live
 * process. Calling every such mismatch reuse would strand the stale workers this
 * prefix exists to retire (#5311), and accepting every one would let a reused
 * PID pass for the worker, so it must prove it is the same instant.
 */
export function isSameProcessStartToken(currentToken: string | null, recordedToken: string | null): boolean {
  if (currentToken === null || recordedToken === null) return true;
  if (currentToken === recordedToken) return true;
  if (isUtcPinnedStartToken(currentToken) === isUtcPinnedStartToken(recordedToken)) return false;
  return differsOnlyByUtcOffset(currentToken, recordedToken);
}

function queryWindowsCreationDate(pid: number): string | null {
  // CreationDate is a CIM DATETIME (yyyyMMddHHmmss.ffffff±UTCoffset) that is
  // unique-enough per (pid, boot) to detect PID reuse. `-NoProfile` keeps it
  // fast; sanitizeEnv keeps the spawn-env discipline uniform (#2357/#2375).
  rawProbeCount += 1;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CreationDate.ToString('yyyyMMddHHmmss.ffffff')`
    ],
    {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
      env: startTokenProbeEnv(sanitizeEnv(process.env))
    }
  );
  return startTokenFromSpawnResult('powershell-cim', pid, result);
}

function captureWindowsStartToken(pid: number, bypassCache = false): string | null {
  if (!bypassCache) {
    const cached = windowsStartTokenCache.get(pid);
    // Our own PID cannot be reissued while we are running, so a token read for
    // it stays valid for the life of the process.
    if (cached && (pid === process.pid || Date.now() - cached.capturedAtMs < WINDOWS_START_TOKEN_CACHE_TTL_MS)) {
      return cached.token;
    }
  }

  let token: string | null = null;
  try {
    token = queryWindowsCreationDate(pid);
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'captureProcessStartToken: powershell CIM lookup failed', {
      pid,
      error: error instanceof Error ? error.message : String(error)
    });
    token = null;
  }

  // A failed read of our own PID is not cached: one slow CIM query would
  // otherwise make every self-read in the next TTL return null — including the
  // Chroma writer lock's, which then persists a token-less lock (#4239).
  if (token !== null || pid !== process.pid) {
    windowsStartTokenCache.set(pid, { token, capturedAtMs: Date.now() });
  }
  return token;
}

function readStartToken(pid: number, bypassCache: boolean): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (process.platform === 'linux') {
    rawProbeCount += 1;
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const tailStart = raw.lastIndexOf(') ');
      if (tailStart < 0) return null;
      const fields = raw.slice(tailStart + 2).split(' ');
      const starttime = fields[19];
      return starttime && /^\d+$/.test(starttime) ? starttime : null;
    } catch (error: unknown) {
      logger.debug('SYSTEM', 'captureProcessStartToken: /proc read failed', {
        pid,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  if (process.platform === 'win32') {
    return captureWindowsStartToken(pid, bypassCache);
  }

  rawProbeCount += 1;
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8',
      timeout: 2000,
      // Uniform spawn-env discipline: sanitize even for read-only system
      // binaries so the spawn-env CI check stays a single rule (#2357/#2375).
      // The TZ pin keeps the token off our time zone (#5311); the prefix
      // marks the pinned era so pre-pin records compare safely (see
      // isSameProcessStartToken).
      env: startTokenProbeEnv(sanitizeEnv(process.env))
    });
    const token = startTokenFromSpawnResult('ps-lstart', pid, result);
    return token === null ? null : withUtcStartTokenPrefix(token);
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'captureProcessStartToken: ps exec failed', {
      pid,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/**
 * True when `pid` still names the process that produced `snapshotToken`.
 *
 * Fallback semantics are deliberately asymmetric: refusing to kill must stay
 * strictly NARROWER than killing, or a token we simply could not read would
 * strand a live orphan and resurrect #2313. So only a token that was captured
 * successfully AND now differs proves reuse; an uncapturable token on either
 * side means "proceed". The comparison itself runs through
 * isSameProcessStartToken, which accepts a pre-UTC-pin token only when it
 * differs from the pinned read by a possible UTC offset (#5311).
 *
 * Windows caveat: captureProcessStartToken caches per-pid for 5s, so when the
 * snapshot and the revalidation fall inside one TTL this re-reads the cached
 * value and cannot detect reuse. It is therefore fully effective on POSIX
 * (/proc and ps are uncached) and best-effort on Windows — no worse than the
 * unchecked behavior it replaces.
 */
/**
 * Cached identity read. Windows caches per-pid for 5s (a CIM query is
 * ~100-300ms); POSIX always reads fresh, so the cache is Windows-only.
 *
 * Use this for OWNERSHIP checks that may run repeatedly inside one decision
 * window — verifyPidFileOwnership is the reason the cache exists. Do NOT use
 * it to authorize a kill: see isSameProcess below.
 */
export function captureProcessStartToken(pid: number): string | null {
  return readStartToken(pid, false);
}

/**
 * Lower-case executable name of `pid` without directory or `.exe` (e.g. "bun",
 * "node"), or null when it cannot be read. Uncached: used only where no start
 * token was recorded.
 */
export function captureProcessName(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // Linux reads /proc/<pid>/comm, the field `ps -o comm=` prints: BusyBox
  // `ps` has no `-p`, so the `ps` read always returned null there (#5098).
  if (process.platform === 'linux') {
    try {
      const name = normalizeProcessName(readFileSync(`/proc/${pid}/comm`, 'utf-8').trim());
      return name.length > 0 ? name : null;
    } catch {
      return null;
    }
  }
  try {
    const result = process.platform === 'win32'
      ? spawnSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).ProcessName`],
          { encoding: 'utf-8', timeout: 5000, windowsHide: true, env: startTokenProbeEnv(sanitizeEnv(process.env)) }
        )
      : spawnSync('ps', ['-p', String(pid), '-o', 'comm='], {
          encoding: 'utf-8',
          timeout: 2000,
          env: startTokenProbeEnv(sanitizeEnv(process.env))
        });
    if (result.status !== 0) return null;
    const name = normalizeProcessName(result.stdout.trim());
    return name.length > 0 ? name : null;
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'captureProcessName: lookup failed', {
      pid,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

/** "C:\\x\\Bun.EXE" / "/usr/bin/node" -> "bun" / "node" */
export function normalizeProcessName(nameOrPath: string): string {
  const base = nameOrPath.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.exe$/i, '').toLowerCase();
}

// Linux `ps -o comm=` reports at most TASK_COMM_LEN - 1 = 15 characters.
const LINUX_COMM_MAX_CHARS = 15;

/**
 * Compare a name read by captureProcessName with one recorded from an
 * executable path. On Linux the live name is truncated to 15 characters, so a
 * longer recorded name would never match and a live owner would look reused.
 */
export function isSameProcessName(
  currentName: string,
  recordedName: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'linux') return currentName === recordedName;
  return currentName.slice(0, LINUX_COMM_MAX_CHARS) === recordedName.slice(0, LINUX_COMM_MAX_CHARS);
}

export function isSameProcess(pid: number, snapshotToken: string | null): boolean {
  if (snapshotToken === null) return true;
  // DELIBERATELY BYPASSES THE CACHE.
  //
  // Every caller of this function is authorizing an irreversible kill, and the
  // cache makes that authorization a tautology on Windows: the snapshot
  // capture populates the entry, and this revalidation reads the SAME entry
  // back, so within the 5s TTL it always matches — 100% of the time, not as a
  // race. A reused PID is then certified as the original and handed to
  // `taskkill /PID <pid> /T /F`, taking an unrelated process AND its whole
  // descendant tree with it.
  //
  // The uncached reader is intentionally NOT exported: callers can obtain a
  // bypassing verdict only through this predicate or the stricter helper
  // below, not a raw probe that could be used where caching is wanted.
  const currentToken = readStartToken(pid, true);
  if (currentToken === null) return true;
  return isSameProcessStartToken(currentToken, snapshotToken);
}

/**
 * A fail-closed identity check for test cleanup of already snapshotted
 * children. Unlike isSameProcess, an uncapturable current token fails the
 * match (nothing to certify). Every readable token runs through
 * isSameProcessStartToken, so all token comparisons share one rule (#5311).
 */
export function hasMatchingProcessStartToken(pid: number, snapshotToken: string): boolean {
  const currentToken = readStartToken(pid, true);
  if (currentToken === null) return false;
  return isSameProcessStartToken(currentToken, snapshotToken);
}
