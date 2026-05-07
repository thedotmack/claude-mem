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
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

export const IS_WINDOWS = process.platform === 'win32';

export function claudeConfigDirectory(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function marketplaceDirectory(): string {
  return join(claudeConfigDirectory(), 'plugins', 'marketplaces', 'thedotmack');
}

export function pluginsDirectory(): string {
  return join(claudeConfigDirectory(), 'plugins');
}

export function knownMarketplacesPath(): string {
  return join(pluginsDirectory(), 'known_marketplaces.json');
}

export function installedPluginsPath(): string {
  return join(pluginsDirectory(), 'installed_plugins.json');
}

export function claudeSettingsPath(): string {
  return join(claudeConfigDirectory(), 'settings.json');
}

export function pluginCacheDirectory(version: string): string {
  return join(pluginsDirectory(), 'cache', 'thedotmack', 'claude-mem', version);
}

export function npmPackageRootDirectory(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const root = join(dirname(currentFilePath), '..', '..');
  if (!existsSync(join(root, 'package.json'))) {
    throw new Error(
      `npmPackageRootDirectory: expected package.json at ${root}. ` +
      `Bundle structure may have changed — update the path walk.`,
    );
  }
  return root;
}

export function npmPackagePluginDirectory(): string {
  return join(npmPackageRootDirectory(), 'plugin');
}

export function readPluginVersion(): string {
  const pluginJsonPath = join(npmPackagePluginDirectory(), '.claude-plugin', 'plugin.json');
  if (existsSync(pluginJsonPath)) {
    try {
      const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
      if (pluginJson.version) return pluginJson.version;
    } catch {
      // Fall through to package.json
    }
  }

  const packageJsonPath = join(npmPackageRootDirectory(), 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      if (packageJson.version) return packageJson.version;
    } catch {
      // Unable to read
    }
  }

  return '0.0.0';
}

export function isPluginInstalled(): boolean {
  const marketplaceDir = marketplaceDirectory();
  return existsSync(join(marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json'));
}

export function ensureDirectoryExists(directoryPath: string): void {
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { recursive: true });
  }
}

export { readJsonSafe } from '../../utils/json-utils.js';

/**
 * Write JSON to disk with crash-safe atomic-rename semantics.
 *
 * Sequence: resolve symlinks at the destination, write payload to a uniquely
 * named temp file in the same directory as the resolved target, loop writeSync
 * until the full payload is on disk, fsync the fd, close, rename over the
 * resolved target, then fsync the parent directory for crash durability. The
 * rename is atomic on POSIX and on Windows Vista+ (Node uses
 * MoveFileExW/MOVEFILE_REPLACE_EXISTING under the hood). A crash mid-write
 * leaves either the old contents or the new contents — never a truncated file.
 *
 * Symlink-safe: POSIX rename(2) replaces the symlink itself rather than the
 * target file, so a naive rename over a symlinked destination would break the
 * link. We lstat/realpath up front so the temp file lives next to the real
 * target and the rename writes through the link.
 *
 * Preserves the destination file's mode bits when the file already exists so
 * we don't accidentally widen permissions on user-owned configs like
 * ~/.claude/settings.json.
 */
export function writeJsonFileAtomic(filepath: string, data: any): void {
  // POSIX rename(2) operates on the symlink itself, so an atomic rename over
  // a symlinked destination would replace the link rather than writing through
  // it. Resolve up front so temp + rename both live on the real target's fs.
  let resolved = filepath;
  try {
    if (lstatSync(filepath).isSymbolicLink()) {
      try {
        resolved = realpathSync(filepath);
      } catch {
        const linkTarget = readlinkSync(filepath);
        resolved = resolve(dirname(filepath), linkTarget);
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw err;
    }
    // Destination doesn't exist yet - write directly to the literal path.
  }

  ensureDirectoryExists(dirname(resolved));

  const dir = dirname(resolved);
  const base = basename(resolved);
  const tmpPath = join(dir, `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const payload = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf-8');

  // Preserve existing mode if the destination already exists; otherwise let
  // the OS apply the standard new-file default (0o666 minus umask via openSync).
  let mode: number | undefined;
  try {
    mode = statSync(resolved).mode & 0o777;
  } catch {
    // File doesn't exist yet — fall through to default mode.
  }

  let fd: number | undefined;
  try {
    fd = mode !== undefined ? openSync(tmpPath, 'w', mode) : openSync(tmpPath, 'w');

    // writeSync wraps POSIX write(2), which may short-write — loop until the
    // full payload is committed before fsync.
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

    // fsync the parent directory so the rename's directory-entry change
    // survives a crash. Best-effort: Windows can't fsync a directory and
    // some filesystems disallow it — skip silently in those cases.
    if (!IS_WINDOWS) {
      let dirFd: number | undefined;
      try {
        dirFd = openSync(dir, 'r');
        fsyncSync(dirFd);
      } catch {
        // Best-effort durability.
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
