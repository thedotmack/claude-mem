import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { randomBytes } from 'crypto';
import { basename, dirname, join, resolve } from 'path';
import { emitDiagnostic } from './hook-io.js';

export const IS_WINDOWS_PLATFORM = process.platform === 'win32';

export function stripUtf8Bom(raw: string): string {
  return raw.replace(/^\uFEFF/, '');
}

export function parseJsonWithBom<T = unknown>(raw: string): T {
  return JSON.parse(stripUtf8Bom(raw)) as T;
}

export function readJsonFileWithBom<T = unknown>(filepath: string): T {
  return parseJsonWithBom<T>(readFileSync(filepath, 'utf-8'));
}

export function ensureDirectoryExists(directoryPath: string): void {
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { recursive: true });
  }
}

/**
 * The realpath of `filePath`, or, when it doesn't exist yet, the realpath of
 * its deepest existing ancestor with the missing tail appended. Relative link
 * targets must resolve against this physical location, not the logical path
 * the link was reached through.
 */
function physicalPathOf(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const parent = dirname(filePath);
    if (parent === filePath) return filePath;
    return join(physicalPathOf(parent), basename(filePath));
  }
}

/**
 * Where an atomic write to `filePath` must land so a symlink at that path
 * stays a symlink: the final target of the link chain, also when that target
 * doesn't exist yet. Renaming a temp file over the link itself would replace
 * it with a regular file and orphan the file it pointed to.
 *
 * A loop throws ELOOP, and any resolution failure other than a missing target
 * is thrown: those must never turn a link into a regular file.
 */
export function resolveSymlinkWriteTarget(filePath: string): string {
  let resolved = filePath;
  const followed = new Set<string>();
  try {
    while (lstatSync(resolved).isSymbolicLink()) {
      const absolute = resolve(resolved);
      if (followed.has(absolute)) {
        throw Object.assign(new Error(`Symlink loop at ${resolved}`), { code: 'ELOOP' });
      }
      followed.add(absolute);
      try {
        return realpathSync(resolved);
      } catch (realpathErr) {
        // A missing final target can be created. Loops, permission errors and
        // other resolution failures must never turn a link into a regular file.
        if ((realpathErr as NodeJS.ErrnoException).code !== 'ENOENT') throw realpathErr;
        const realpathError = realpathErr instanceof Error ? realpathErr : new Error(String(realpathErr));
        emitDiagnostic(`claude-mem: realpathSync failed for ${resolved}, resolving symlink manually: ${realpathError.message}\n`);
        const linkTarget = readlinkSync(resolved);
        resolved = resolve(physicalPathOf(dirname(resolve(resolved))), linkTarget);
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw err;
    }
  }
  return resolved;
}

const WINDOWS_RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** About 0.6 s in total, the same order as graceful-fs's Windows rename retry. */
const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320];

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename `from` over `to`. On Windows, a rename over a file that antivirus,
 * the search indexer or a sync client holds open for a moment fails with
 * EPERM, EBUSY or EACCES, so retry those with a short bounded backoff.
 */
export function renameWithWindowsRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => void = renameSync,
  onWindows: boolean = IS_WINDOWS_PLATFORM
): void {
  if (!onWindows) return rename(from, to);
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= WINDOWS_RENAME_RETRY_DELAYS_MS.length || !WINDOWS_RENAME_RETRY_CODES.has(code)) {
        throw err;
      }
      sleepSync(WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Write JSON to disk with crash-safe atomic-rename semantics.
 *
 * Sequence: resolve symlinks at the destination, write payload to a uniquely
 * named temp file in the same directory as the resolved target, loop writeSync
 * until the full payload is on disk, fsync the fd, close, rename over the
 * resolved target, then fsync the parent directory for crash durability. A
 * crash mid-write leaves either the old contents or the new contents, never a
 * truncated file.
 */
export interface AtomicJsonWriteOptions {
  /** Force the destination mode from the first byte written (for secrets). */
  mode?: number;
}

export function writeJsonFileAtomic(
  filepath: string,
  data: any,
  options: AtomicJsonWriteOptions = {}
): void {
  const resolved = resolveSymlinkWriteTarget(filepath);

  ensureDirectoryExists(dirname(resolved));

  const dir = dirname(resolved);
  const base = basename(resolved);
  const tmpPath = join(dir, `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const payload = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf-8');

  let mode = options.mode;
  if (mode === undefined) {
    try {
      mode = statSync(resolved).mode & 0o777;
    } catch {
      // File does not exist yet; let openSync apply the process umask.
    }
  }

  let fd: number | undefined;
  try {
    fd = mode !== undefined ? openSync(tmpPath, 'w', mode) : openSync(tmpPath, 'w');

    let written = 0;
    while (written < payload.length) {
      const n = writeSync(fd, payload, written, payload.length - written);
      if (n === 0) {
        throw new Error(`writeSync stalled at ${written}/${payload.length} bytes`);
      }
      written += n;
    }

    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameWithWindowsRetry(tmpPath, resolved);

    if (!IS_WINDOWS_PLATFORM) {
      let dirFd: number | undefined;
      try {
        dirFd = openSync(dir, 'r');
        fsyncSync(dirFd);
      } catch (dirSyncErr) {
        const dirSyncError = dirSyncErr instanceof Error ? dirSyncErr : new Error(String(dirSyncErr));
        emitDiagnostic(`claude-mem: directory fsync failed for ${dir}: ${dirSyncError.message}\n`);
      } finally {
        if (dirFd !== undefined) {
          try { closeSync(dirFd); } catch { /* ignore */ }
        }
      }
    }
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close-after-error */ }
    }
    try { unlinkSync(tmpPath); } catch { /* tempfile may not exist */ }
    throw err;
  }
}
