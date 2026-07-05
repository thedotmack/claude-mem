
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

const IS_WINDOWS = process.platform === 'win32';

export function stripJsonBom(contents: string): string {
  return contents.replace(/^\uFEFF/, '');
}

export function parseJsonText<T>(contents: string): T {
  return JSON.parse(stripJsonBom(contents)) as T;
}

export function readJsonSafe<T>(filePath: string, defaultValue: T): T {
  if (!existsSync(filePath)) return defaultValue;
  try {
    return parseJsonText<T>(readFileSync(filePath, 'utf-8'));
  } catch (error: unknown) {
    throw new Error(`Corrupt JSON file, refusing to overwrite: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeJsonFileAtomic(filepath: string, data: unknown): void {
  let resolved = filepath;
  try {
    if (lstatSync(filepath).isSymbolicLink()) {
      try {
        resolved = realpathSync(filepath);
      } catch (realpathErr) {
        const realpathError = realpathErr instanceof Error ? realpathErr : new Error(String(realpathErr));
        console.warn(`claude-mem: realpathSync failed for ${filepath}, resolving symlink manually:`, realpathError);
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

  mkdirSync(dirname(resolved), { recursive: true });

  const dir = dirname(resolved);
  const base = basename(resolved);
  const tmpPath = join(dir, `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const payload = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf-8');

  let mode: number | undefined;
  try {
    mode = statSync(resolved).mode & 0o777;
  } catch {
    // File does not exist yet; use the process umask through openSync.
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

    if (!IS_WINDOWS) {
      let dirFd: number | undefined;
      try {
        dirFd = openSync(dir, 'r');
        fsyncSync(dirFd);
      } catch (dirSyncErr) {
        const dirSyncError = dirSyncErr instanceof Error ? dirSyncErr : new Error(String(dirSyncErr));
        console.warn(`claude-mem: directory fsync failed for ${dir}:`, dirSyncError);
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
