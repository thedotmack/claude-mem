import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { expandHome } from './expand-home.js';

const WORKER_PORT_BASE = 37700;
const SERVER_PORT_BASE = 37877;
const LEGACY_WINDOWS_WORKER_PORT = '37777';
const LEGACY_WINDOWS_PORT_OFFSET = 77;

function defaultDataDir(): string {
  return process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
}

function hasLegacyWindowsWorkerPort(dataDir: string): boolean {
  const settingsPath = join(expandHome(dataDir), 'settings.json');
  if (!existsSync(settingsPath)) return false;

  try {
    const document = JSON.parse(readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const nested = document.env;
    const settings = nested && typeof nested === 'object' && !Array.isArray(nested)
      && Object.keys(nested).some(key => key.startsWith('CLAUDE_MEM_'))
      ? nested as Record<string, unknown>
      : document;
    return settings.CLAUDE_MEM_WORKER_PORT === LEGACY_WINDOWS_WORKER_PORT;
  } catch {
    return false;
  }
}

export function getInstallPortOffset(
  dataDir = defaultDataDir(),
  options: { platform?: NodeJS.Platform; uid?: number | null } = {},
): number {
  const platform = options.platform ?? process.platform;
  const uid = options.uid === undefined
    ? (typeof process.getuid === 'function' ? process.getuid() : null)
    : options.uid;
  if (uid !== null) return ((uid % 100) + 100) % 100;

  // Keep server URLs aligned with Windows installs that saved the old default.
  if (platform === 'win32' && hasLegacyWindowsWorkerPort(dataDir)) return LEGACY_WINDOWS_PORT_OFFSET;

  let normalizedDataDir = resolve(expandHome(dataDir));
  if (platform === 'win32') normalizedDataDir = normalizedDataDir.toLowerCase();
  return createHash('sha256').update(normalizedDataDir, 'utf8').digest().readUInt32BE(0) % 100;
}

export function getDefaultWorkerPort(dataDir?: string, options?: { platform?: NodeJS.Platform; uid?: number | null }): number {
  return WORKER_PORT_BASE + getInstallPortOffset(dataDir, options);
}

export function getDefaultServerPort(dataDir?: string, options?: { platform?: NodeJS.Platform; uid?: number | null }): number {
  return SERVER_PORT_BASE + getInstallPortOffset(dataDir, options);
}
