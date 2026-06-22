import { join, dirname, basename, sep } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { logger } from '../utils/logger.js';

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
      const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
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

export const ARCHIVES_DIR = join(DATA_DIR, 'archives');
export const LOGS_DIR = join(DATA_DIR, 'logs');
export const TRASH_DIR = join(DATA_DIR, 'trash');
export const BACKUPS_DIR = join(DATA_DIR, 'backups');
export const MODES_DIR = join(DATA_DIR, 'modes');
export const USER_SETTINGS_PATH = join(DATA_DIR, 'settings.json');
export const DB_PATH = join(DATA_DIR, 'claude-mem.db');
export const VECTOR_DB_DIR = join(DATA_DIR, 'vector-db');

export const OBSERVER_SESSIONS_DIR = join(DATA_DIR, 'observer-sessions');

export const OBSERVER_SESSIONS_PROJECT = basename(OBSERVER_SESSIONS_DIR);

export const CLAUDE_SETTINGS_PATH = join(CLAUDE_CONFIG_DIR, 'settings.json');
export const CLAUDE_COMMANDS_DIR = join(CLAUDE_CONFIG_DIR, 'commands');
export const CLAUDE_MD_PATH = join(CLAUDE_CONFIG_DIR, 'CLAUDE.md');

export function getProjectArchiveDir(projectName: string): string {
  return join(ARCHIVES_DIR, projectName);
}

export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

export function ensureAllDataDirs(): void {
  ensureDir(DATA_DIR);
  ensureDir(ARCHIVES_DIR);
  ensureDir(LOGS_DIR);
  ensureDir(TRASH_DIR);
  ensureDir(BACKUPS_DIR);
  ensureDir(MODES_DIR);
}

export function ensureModesDir(): void {
  ensureDir(MODES_DIR);
}

export function ensureAllClaudeDirs(): void {
  ensureDir(CLAUDE_CONFIG_DIR);
  ensureDir(CLAUDE_COMMANDS_DIR);
}

export function getCurrentProjectName(): string {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    }).trim();
    return basename(dirname(gitRoot)) + '/' + basename(gitRoot);
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Git root detection failed, using cwd basename', {
      cwd: process.cwd()
    }, error instanceof Error ? error : new Error(String(error)));
    const cwd = process.cwd();
    return basename(dirname(cwd)) + '/' + basename(cwd);
  }
}

export function getPackageRoot(): string {
  return join(_dirname, '..');
}

export function getPackageCommandsDir(): string {
  const packageRoot = getPackageRoot();
  return join(packageRoot, 'commands');
}

function resolveDataPath(...segments: string[]): string {
  return join(resolveDataDir(), ...segments);
}

export const paths = {
  dataDir: () => resolveDataDir(),
  workerPid: () => resolveDataPath('worker.pid'),
  serverBetaPid: () => resolveDataPath('.server-beta.pid'),
  serverBetaPort: () => resolveDataPath('.server-beta.port'),
  serverBetaRuntime: () => resolveDataPath('.server-beta.runtime.json'),
  settings: () => resolveDataPath('settings.json'),
  database: () => resolveDataPath('claude-mem.db'),
  chroma: () => resolveDataPath('chroma'),
  combinedCerts: () => resolveDataPath('combined_certs.pem'),
  transcriptsConfig: () => resolveDataPath('transcript-watch.json'),
  transcriptsState: () => resolveDataPath('transcript-watch-state.json'),
  corpora: () => resolveDataPath('corpora'),
  supervisorRegistry: () => resolveDataPath('supervisor.json'),
  envFile: () => resolveDataPath('.env'),
  logsDir: () => resolveDataPath('logs'),
  archives: () => resolveDataPath('archives'),
  trash: () => resolveDataPath('trash'),
  backups: () => resolveDataPath('backups'),
  modes: () => resolveDataPath('modes'),
  vectorDb: () => resolveDataPath('vector-db'),
  observerSessions: () => resolveDataPath('observer-sessions'),
} as const;
