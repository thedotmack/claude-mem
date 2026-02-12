import { join, dirname, basename, sep } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { logger } from '../utils/logger.js';

// Get __dirname that works in both ESM (hooks) and CJS (worker) contexts
function getDirname(): string {
  // CJS context - __dirname exists
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  // ESM context - use import.meta.url
  return dirname(fileURLToPath(import.meta.url));
}

const _dirname = getDirname();

/**
 * Simple path configuration for claude-mem
 * Standard paths based on Claude Code conventions
 */

// Base directories
export const DATA_DIR = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
// Note: CLAUDE_CONFIG_DIR is a Claude Code setting, not claude-mem, so leave as env var
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

/**
 * Detect plugin installation directory dynamically
 * Works for any marketplace name, not just 'thedotmack'
 * 
 * Priority:
 * 1. CLAUDE_PLUGIN_ROOT env var (set by Claude Code when running hooks)
 * 2. Detect from script location (for both marketplaces/ and cache/ installs)
 * 3. Fallback to thedotmack for backwards compatibility
 */
function detectMarketplaceRoot(): string {
  // Priority 1: Use CLAUDE_PLUGIN_ROOT if available (most reliable)
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    return process.env.CLAUDE_PLUGIN_ROOT;
  }
  
  // Priority 2: Detect from current script location
  // This file is at: <plugin-root>/src/shared/paths.ts (compiled) or dist/shared/paths.js
  // So we go up 2-3 levels to find plugin root
  let currentDir = _dirname;
  
  // If we're in dist/, go up one more level
  if (basename(currentDir) === 'shared' && basename(dirname(currentDir)) === 'dist') {
    return dirname(dirname(currentDir)); // plugin root
  }
  
  // If we're in src/, go up two levels
  if (basename(currentDir) === 'shared' && basename(dirname(currentDir)) === 'src') {
    return dirname(dirname(currentDir)); // plugin root
  }
  
  // Priority 3: Fallback to original hardcoded path for backwards compatibility
  logger.warn('SYSTEM', 'Could not detect plugin root dynamically, using fallback', { dirname: _dirname });
  return join(CLAUDE_CONFIG_DIR, 'plugins', 'marketplaces', 'thedotmack');
}

// Plugin installation directory - dynamically detected
export const MARKETPLACE_ROOT = detectMarketplaceRoot();

// Data subdirectories
export const ARCHIVES_DIR = join(DATA_DIR, 'archives');
export const LOGS_DIR = join(DATA_DIR, 'logs');
export const TRASH_DIR = join(DATA_DIR, 'trash');
export const BACKUPS_DIR = join(DATA_DIR, 'backups');
export const MODES_DIR = join(DATA_DIR, 'modes');
export const USER_SETTINGS_PATH = join(DATA_DIR, 'settings.json');
export const DB_PATH = join(DATA_DIR, 'claude-mem.db');
export const VECTOR_DB_DIR = join(DATA_DIR, 'vector-db');

// Observer sessions directory - used as cwd for SDK queries
// Sessions here won't appear in user's `claude --resume` for their actual projects
export const OBSERVER_SESSIONS_DIR = join(DATA_DIR, 'observer-sessions');

// Claude integration paths
export const CLAUDE_SETTINGS_PATH = join(CLAUDE_CONFIG_DIR, 'settings.json');
export const CLAUDE_COMMANDS_DIR = join(CLAUDE_CONFIG_DIR, 'commands');
export const CLAUDE_MD_PATH = join(CLAUDE_CONFIG_DIR, 'CLAUDE.md');

/**
 * Get project-specific archive directory
 */
export function getProjectArchiveDir(projectName: string): string {
  return join(ARCHIVES_DIR, projectName);
}

/**
 * Get worker socket path for a session
 */
export function getWorkerSocketPath(sessionId: number): string {
  return join(DATA_DIR, `worker-${sessionId}.sock`);
}

/**
 * Ensure a directory exists
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

/**
 * Ensure all data directories exist
 */
export function ensureAllDataDirs(): void {
  ensureDir(DATA_DIR);
  ensureDir(ARCHIVES_DIR);
  ensureDir(LOGS_DIR);
  ensureDir(TRASH_DIR);
  ensureDir(BACKUPS_DIR);
  ensureDir(MODES_DIR);
}

/**
 * Ensure modes directory exists
 */
export function ensureModesDir(): void {
  ensureDir(MODES_DIR);
}

/**
 * Ensure all Claude integration directories exist
 */
export function ensureAllClaudeDirs(): void {
  ensureDir(CLAUDE_CONFIG_DIR);
  ensureDir(CLAUDE_COMMANDS_DIR);
}

/**
 * Get current project name from git root or cwd
 */
export function getCurrentProjectName(): string {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    }).trim();
    return basename(gitRoot);
  } catch (error) {
    logger.debug('SYSTEM', 'Git root detection failed, using cwd basename', {
      cwd: process.cwd()
    }, error as Error);
    return basename(process.cwd());
  }
}

/**
 * Find package root directory
 *
 * Works because bundled hooks are in plugin/scripts/,
 * so package root is always one level up (the plugin directory)
 */
export function getPackageRoot(): string {
  return join(_dirname, '..');
}

/**
 * Find commands directory in the installed package
 */
export function getPackageCommandsDir(): string {
  const packageRoot = getPackageRoot();
  return join(packageRoot, 'commands');
}

/**
 * Create a timestamped backup filename
 */
export function createBackupFilename(originalPath: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);

  return `${originalPath}.backup.${timestamp}`;
}
