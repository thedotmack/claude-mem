import { join, dirname, basename, sep } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { parseJsonWithBom } from './atomic-json.js';

function getDirname(): string {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  return dirname(fileURLToPath(import.meta.url));
}

const _dirname = getDirname();

export function resolveDataDir(): string {
  if (process.env.CLAUDE_MEM_DATA_DIR) {
    return process.env.CLAUDE_MEM_DATA_DIR;
  }

  const defaultDataDir = join(homedir(), '.claude-mem');
  const settingsPath = join(defaultDataDir, 'settings.json');
  try {
    if (existsSync(settingsPath)) {
      const raw = parseJsonWithBom<Record<string, any>>(readFileSync(settingsPath, 'utf-8'));
      const settings = raw.env ?? raw; 
      if (settings.CLAUDE_MEM_DATA_DIR) {
        return settings.CLAUDE_MEM_DATA_DIR;
      }
    }
  } catch {
    // settings file missing or corrupt — fall through to default
  }

  return defaultDataDir;
}

export const DATA_DIR = resolveDataDir();
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

export const MARKETPLACE_ROOT = join(CLAUDE_CONFIG_DIR, 'plugins', 'marketplaces', 'thedotmack');

export const LOGS_DIR = join(DATA_DIR, 'logs');
export const USER_SETTINGS_PATH = join(DATA_DIR, 'settings.json');
export const DB_PATH = join(DATA_DIR, 'claude-mem.db');

export const OBSERVER_SESSIONS_DIR = join(DATA_DIR, 'observer-sessions');

export const OBSERVER_SESSIONS_PROJECT = basename(OBSERVER_SESSIONS_DIR);

export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

export function getPackageRoot(): string {
  return join(_dirname, '..');
}

export const paths = {
  dataDir: () => DATA_DIR,
  workerPid: () => join(DATA_DIR, 'worker.pid'),
  // Phase 1b: identifier renamed to `server*`; the on-disk file basenames
  // remain `.server-beta.*` so existing installations keep finding their
  // pid/port/runtime state. Plan §1d will migrate the basenames.
  serverPid: () => join(DATA_DIR, '.server-beta.pid'),
  serverPort: () => join(DATA_DIR, '.server-beta.port'),
  serverRuntime: () => join(DATA_DIR, '.server-beta.runtime.json'),
  settings: () => join(DATA_DIR, 'settings.json'),
  database: () => join(DATA_DIR, 'claude-mem.db'),
  chroma: () => join(DATA_DIR, 'chroma'),
  combinedCerts: () => join(DATA_DIR, 'combined_certs.pem'),
  transcriptsConfig: () => join(DATA_DIR, 'transcript-watch.json'),
  transcriptsState: () => join(DATA_DIR, 'transcript-watch-state.json'),
  cloudSyncState: () => join(DATA_DIR, 'cloud-sync-state.json'),
  corpora: () => join(DATA_DIR, 'corpora'),
  supervisorRegistry: () => join(DATA_DIR, 'supervisor.json'),
  envFile: () => join(DATA_DIR, '.env'),
  logsDir: () => LOGS_DIR,
} as const;
