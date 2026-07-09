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
 * Write JSON to disk with crash-safe atomic-rename semantics.
 *
 * Sequence: resolve symlinks at the destination, write payload to a uniquely
 * named temp file in the same directory as the resolved target, loop writeSync
 * until the full payload is on disk, fsync the fd, close, rename over the
 * resolved target, then fsync the parent directory for crash durability. A
 * crash mid-write leaves either the old contents or the new contents, never a
 * truncated file.
 */
export function writeJsonFileAtomic(filepath: string, data: any): void {
  let resolved = filepath;
  try {
    if (lstatSync(filepath).isSymbolicLink()) {
      try {
        resolved = realpathSync(filepath);
      } catch (realpathErr) {
        const realpathError = realpathErr instanceof Error ? realpathErr : new Error(String(realpathErr));
        emitDiagnostic(`claude-mem: realpathSync failed for ${filepath}, resolving symlink manually: ${realpathError.message}\n`);
        const linkTarget = readlinkSync(filepath);
        resolved = resolve(dirname(filepath), linkTarget);
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw err;
    }
  }

  ensureDirectoryExists(dirname(resolved));

  const dir = dirname(resolved);
  const base = basename(resolved);
  const tmpPath = join(dir, `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const payload = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf-8');

  let mode: number | undefined;
  try {
    mode = statSync(resolved).mode & 0o777;
  } catch {
    // File does not exist yet; let openSync apply the process umask.
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
    renameSync(tmpPath, resolved);

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
