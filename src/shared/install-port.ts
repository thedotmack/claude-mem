import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, win32 } from 'path';
import { expandHome } from './expand-home.js';

const WORKER_PORT_BASE = 37700;
const SERVER_PORT_BASE = 37877;
const LEGACY_WINDOWS_WORKER_PORT = '37777';
const LEGACY_WINDOWS_PORT_OFFSET = 77;
const LEGACY_WINDOWS_SERVER_PORT = 37954;

function defaultDataDir(): string {
  return process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
}

function readSettings(dataDir: string): Record<string, unknown> | null {
  const settingsPath = join(expandHome(dataDir), 'settings.json');
  if (!existsSync(settingsPath)) return null;

  try {
    const document = JSON.parse(readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const nested = document.env;
    return nested && typeof nested === 'object' && !Array.isArray(nested)
      && Object.keys(nested).some(key => key.startsWith('CLAUDE_MEM_'))
      ? nested as Record<string, unknown>
      : document;
  } catch {
    return null;
  }
}

function hasLegacyWindowsWorkerPort(dataDir: string): boolean {
  return readSettings(dataDir)?.CLAUDE_MEM_WORKER_PORT === LEGACY_WINDOWS_WORKER_PORT;
}

function hasLegacyWindowsServerPort(dataDir: string): boolean {
  const settings = readSettings(dataDir);
  return ['CLAUDE_MEM_SERVER_URL', 'CLAUDE_MEM_SERVER_BETA_URL'].some(key => {
    const value = settings?.[key];
    if (typeof value !== 'string') return false;

    try {
      return new URL(value).port === String(LEGACY_WINDOWS_SERVER_PORT);
    } catch {
      return false;
    }
  });
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

  const expandedDataDir = expandHome(dataDir, platform);
  let normalizedDataDir = platform === 'win32'
    ? win32.resolve(expandedDataDir)
    : resolve(expandedDataDir);
  if (platform === 'win32') normalizedDataDir = normalizedDataDir.toLowerCase();
  return createHash('sha256').update(normalizedDataDir, 'utf8').digest().readUInt32BE(0) % 100;
}

export function getDefaultWorkerPort(dataDir?: string, options?: { platform?: NodeJS.Platform; uid?: number | null }): number {
  return WORKER_PORT_BASE + getInstallPortOffset(dataDir, options);
}

export function getDefaultServerPort(dataDir = defaultDataDir(), options: { platform?: NodeJS.Platform; uid?: number | null } = {}): number {
  const platform = options.platform ?? process.platform;
  const uid = options.uid === undefined
    ? (typeof process.getuid === 'function' ? process.getuid() : null)
    : options.uid;
  if (platform === 'win32' && uid === null && hasLegacyWindowsServerPort(dataDir)) {
    return LEGACY_WINDOWS_SERVER_PORT;
  }

  return SERVER_PORT_BASE + getInstallPortOffset(dataDir, options);
}
