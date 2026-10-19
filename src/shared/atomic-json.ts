import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
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

export interface AtomicJsonWriteOptions {
  /** Force the destination mode from the first byte written (for secrets). */
  mode?: number;
}

/** Write JSON (2-space indent, trailing newline) through writeFileAtomic. */
export function writeJsonFileAtomic(
  filepath: string,
  data: any,
  options: AtomicJsonWriteOptions = {}
): void {
  writeFileAtomic(filepath, Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf-8'), options);
}

export type AtomicFileWriteOptions = AtomicJsonWriteOptions;

/**
 * A temp file a crashed or failed write left beside its target is removed by
 * the next successful write once it is this old. A write takes milliseconds,
 * so a temp file this old belongs to no write still going on (magpie
 * internal/edit/file.go:238-266 `staleTemp`/`removeStaleTemps`, MIT,
 * Copyright (c) 2026 yetone).
 */
export const STALE_ATOMIC_TEMP_FILE_AGE_MS = 10 * 60 * 1000;

function atomicTempFilePath(resolvedTargetPath: string): string {
  return join(dirname(resolvedTargetPath), `.${basename(resolvedTargetPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
}

/** Our own temp names only: `.<base>.<pid>.<hex>.tmp`. */
function isAtomicTempFileNameOf(fileName: string, targetBaseName: string): boolean {
  const prefix = `.${targetBaseName}.`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith('.tmp')) return false;
  const middle = fileName.slice(prefix.length, fileName.length - '.tmp'.length);
  const separator = middle.indexOf('.');
  if (separator <= 0) return false;
  const pidPart = middle.slice(0, separator);
  const hexPart = middle.slice(separator + 1);
  return /^[0-9]+$/.test(pidPart) && /^[0-9a-f]+$/.test(hexPart);
}

function removeStaleAtomicTempFiles(resolvedTargetPath: string): void {
  const dir = dirname(resolvedTargetPath);
  const base = basename(resolvedTargetPath);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // Cleanup is best effort; the write itself already succeeded.
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!isAtomicTempFileNameOf(entry, base)) continue;
    try {
      const entryPath = join(dir, entry);
      if (now - statSync(entryPath).mtimeMs > STALE_ATOMIC_TEMP_FILE_AGE_MS) unlinkSync(entryPath);
    } catch {
      // Another writer removed or is still using it.
    }
  }
}

function writeAllBytes(fd: number, payload: Uint8Array, position: number | null): void {
  let written = 0;
  while (written < payload.length) {
    const n = writeSync(fd, payload, written, payload.length - written, position === null ? null : position + written);
    if (n === 0) {
      throw new Error(`writeSync stalled at ${written}/${payload.length} bytes`);
    }
    written += n;
  }
}

function fsyncDirectory(dir: string): void {
  if (IS_WINDOWS_PLATFORM) return;
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

/** Write `payload` to a fresh same-directory temp file and fsync it; returns the temp path. */
function writeSyncedTempFile(resolvedTargetPath: string, payload: Uint8Array, mode: number | undefined): string {
  const tmpPath = atomicTempFilePath(resolvedTargetPath);
  let fd: number | undefined;
  try {
    fd = mode !== undefined ? openSync(tmpPath, 'w', mode) : openSync(tmpPath, 'w');
    writeAllBytes(fd, payload, null);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    return tmpPath;
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close-after-error */ }
    }
    try { unlinkSync(tmpPath); } catch { /* tempfile may not exist */ }
    throw err;
  }
}

/**
 * A file with other hard links is written in place, so every name sees the
 * write (a rename would split this name from the others). Not atomic, so the
 * text first goes to a synced temp file beside it; a write that fails part
 * way keeps that temp and names it in the error (magpie
 * internal/edit/file.go:170-236 `writeInPlace`, MIT, Copyright (c) 2026
 * yetone). Returns false when the file cannot be opened for writing, so the
 * caller falls back to the rename path.
 */
function writeHardLinkedFileInPlace(resolvedTargetPath: string, payload: Uint8Array, mode: number | undefined, modeIsForced: boolean): boolean {
  let targetFd: number;
  try {
    targetFd = openSync(resolvedTargetPath, 'r+');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return false;
    throw err;
  }
  let tmpPath: string;
  try {
    tmpPath = writeSyncedTempFile(resolvedTargetPath, payload, mode);
  } catch (err) {
    try { closeSync(targetFd); } catch { /* ignore */ }
    throw err;
  }
  try {
    writeAllBytes(targetFd, payload, 0);
    ftruncateSync(targetFd, payload.length);
    if (modeIsForced && mode !== undefined) fchmodSync(targetFd, mode);
    fsyncSync(targetFd);
  } catch (err) {
    try { closeSync(targetFd); } catch { /* ignore */ }
    const error = err instanceof Error ? err : new Error(String(err));
    throw new Error(`${error.message}; the new text is kept in ${tmpPath}`, { cause: error });
  }
  closeSync(targetFd);
  try { unlinkSync(tmpPath); } catch { /* already gone */ }
  return true;
}

/**
 * Write bytes to disk with crash-safe atomic-rename semantics.
 *
 * Sequence: resolve symlinks at the destination (the link stays a link),
 * write the payload to a uniquely named temp file `.<base>.<pid>.<hex>.tmp`
 * in the same directory as the resolved target, loop writeSync until the full
 * payload is on disk, fsync the fd, close, rename over the resolved target,
 * then fsync the parent directory (skipped on Windows). A crash mid-write
 * leaves either the old contents or the new contents, never a truncated file.
 * The existing mode is kept unless `options.mode` forces one. A file with
 * other hard links is written in place instead. Temp files older than
 * STALE_ATOMIC_TEMP_FILE_AGE_MS that earlier writes left are removed after.
 */
export function writeFileAtomic(
  filepath: string,
  payload: Uint8Array,
  options: AtomicFileWriteOptions = {}
): void {
  const resolved = resolveSymlinkWriteTarget(filepath);
  const dir = dirname(resolved);
  ensureDirectoryExists(dir);

  let existing: ReturnType<typeof statSync> | undefined;
  try {
    existing = statSync(resolved);
  } catch {
    // File does not exist yet; let openSync apply the process umask.
  }

  const mode = options.mode ?? (existing ? Number(existing.mode) & 0o777 : undefined);
  // The side temp file takes the target's mode too: it holds the same (maybe secret) text.
  if (existing && existing.isFile() && existing.nlink > 1 && writeHardLinkedFileInPlace(resolved, payload, mode, options.mode !== undefined)) {
    removeStaleAtomicTempFiles(resolved);
    return;
  }

  const tmpPath = writeSyncedTempFile(resolved, payload, mode);
  try {
    renameWithWindowsRetry(tmpPath, resolved);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* tempfile may not exist */ }
    throw err;
  }
  fsyncDirectory(dir);
  removeStaleAtomicTempFiles(resolved);
}
