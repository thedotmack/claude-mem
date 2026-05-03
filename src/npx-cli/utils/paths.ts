import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
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
 * Sequence: write payload to a uniquely named temp file in the same directory,
 * fsync the file descriptor, close, then rename over the destination. The
 * rename is atomic on POSIX and on Windows Vista+ (Node uses
 * MoveFileExW/MOVEFILE_REPLACE_EXISTING under the hood). A crash mid-write
 * leaves either the old contents or the new contents — never a truncated file.
 *
 * Preserves the destination file's mode bits when the file already exists so
 * we don't accidentally widen permissions on user-owned configs like
 * ~/.claude/settings.json.
 */
export function writeJsonFileAtomic(filepath: string, data: any): void {
  ensureDirectoryExists(dirname(filepath));

  const dir = dirname(filepath);
  const base = basename(filepath);
  const tmpPath = join(dir, `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const payload = JSON.stringify(data, null, 2) + '\n';

  // Preserve existing mode if the destination already exists; otherwise let
  // the OS apply the standard new-file default (0o666 minus umask via openSync).
  let mode: number | undefined;
  try {
    mode = statSync(filepath).mode & 0o777;
  } catch {
    // File doesn't exist yet — fall through to default mode.
  }

  let fd: number | undefined;
  try {
    fd = mode !== undefined ? openSync(tmpPath, 'w', mode) : openSync(tmpPath, 'w');
    writeSync(fd, payload, 0, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, filepath);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close-after-error */ }
    }
    try { unlinkSync(tmpPath); } catch { /* tempfile may not exist */ }
    throw err;
  }
}
