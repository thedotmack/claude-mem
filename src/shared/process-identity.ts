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

function queryWindowsCreationDate(pid: number): string | null {
  // CreationDate is a CIM DATETIME (yyyyMMddHHmmss.ffffff±UTCoffset) that is
  // unique-enough per (pid, boot) to detect PID reuse. `-NoProfile` keeps it
  // fast; sanitizeEnv keeps the spawn-env discipline uniform (#2357/#2375).
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
      env: { ...sanitizeEnv(process.env), LC_ALL: 'C', LANG: 'C' }
    }
  );
  if (result.status === 0) {
    const trimmed = result.stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function captureWindowsStartToken(pid: number): string | null {
  const cached = windowsStartTokenCache.get(pid);
  if (cached && Date.now() - cached.capturedAtMs < WINDOWS_START_TOKEN_CACHE_TTL_MS) {
    return cached.token;
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

  windowsStartTokenCache.set(pid, { token, capturedAtMs: Date.now() });
  return token;
}

export function captureProcessStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (process.platform === 'linux') {
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
    return captureWindowsStartToken(pid);
  }

  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8',
      timeout: 2000,
      // Uniform spawn-env discipline: sanitize even for read-only system
      // binaries so the spawn-env CI check stays a single rule (#2357/#2375).
      env: { ...sanitizeEnv(process.env), LC_ALL: 'C', LANG: 'C' }
    });
    if (result.status !== 0) return null;
    const token = result.stdout.trim();
    return token.length > 0 ? token : null;
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
 * side means "proceed".
 *
 * Windows caveat: captureProcessStartToken caches per-pid for 5s, so when the
 * snapshot and the revalidation fall inside one TTL this re-reads the cached
 * value and cannot detect reuse. It is therefore fully effective on POSIX
 * (/proc and ps are uncached) and best-effort on Windows — no worse than the
 * unchecked behavior it replaces.
 */
export function isSameProcess(pid: number, snapshotToken: string | null): boolean {
  if (snapshotToken === null) return true;
  const currentToken = captureProcessStartToken(pid);
  if (currentToken === null) return true;
  return currentToken === snapshotToken;
}
