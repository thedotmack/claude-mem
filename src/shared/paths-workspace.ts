/**
 * Workspace-Aware Path Configuration for claude-mem
 *
 * This module extends the original paths.ts to support workspace-based isolation.
 * When CLAUDE_MEM_WORKSPACE_ROOTS is configured, data is stored in separate
 * directories per workspace, preventing context leakage between different clients.
 *
 * BACKWARDS COMPATIBLE: If no workspace roots are configured, behaves exactly
 * like the original paths.ts (global data directory).
 *
 * Configuration:
 *   CLAUDE_MEM_WORKSPACE_ROOTS="/path/to/client1,/path/to/client2"
 *
 * Data Layout with Workspace Isolation:
 *   ~/.claude-mem/
 *   ├── workspaces/
 *   │   ├── client1/
 *   │   │   ├── claude-mem.db
 *   │   │   ├── settings.json
 *   │   │   └── ... (other data)
 *   │   └── client2/
 *   │       ├── claude-mem.db
 *   │       └── ...
 *   └── settings.json  (global settings, fallback)
 */

import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { logger } from '../utils/logger.js';
import {
  getWorkspace,
  getWorkspaceDataDir as computeWorkspaceDataDir,
  WorkspaceInfo
} from '../utils/workspace.js';

// Get __dirname that works in both ESM and CJS contexts
function getDirname(): string {
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  return dirname(fileURLToPath(import.meta.url));
}

const _dirname = getDirname();

/**
 * Base data directory (without workspace isolation)
 * This is the root for all claude-mem data
 */
export const BASE_DATA_DIR = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');

/**
 * Claude Code configuration directory
 */
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

/**
 * Plugin installation directory
 */
export const MARKETPLACE_ROOT = join(CLAUDE_CONFIG_DIR, 'plugins', 'marketplaces', 'thedotmack');

/**
 * Claude integration paths (global, not workspace-specific)
 */
export const CLAUDE_SETTINGS_PATH = join(CLAUDE_CONFIG_DIR, 'settings.json');
export const CLAUDE_COMMANDS_DIR = join(CLAUDE_CONFIG_DIR, 'commands');
export const CLAUDE_MD_PATH = join(CLAUDE_CONFIG_DIR, 'CLAUDE.md');

/**
 * Workspace-aware path resolver
 *
 * This class provides all data paths resolved for a specific workspace.
 * Use this instead of the static exports when you need workspace isolation.
 */
export class WorkspacePaths {
  public readonly workspace: WorkspaceInfo;
  public readonly dataDir: string;
  public readonly archivesDir: string;
  public readonly logsDir: string;
  public readonly trashDir: string;
  public readonly backupsDir: string;
  public readonly modesDir: string;
  public readonly userSettingsPath: string;
  public readonly dbPath: string;
  public readonly vectorDbDir: string;
  public readonly observerSessionsDir: string;

  constructor(cwd: string | null | undefined) {
    this.workspace = getWorkspace(cwd);
    this.dataDir = computeWorkspaceDataDir(BASE_DATA_DIR, this.workspace);

    // All paths derived from workspace-specific data directory
    this.archivesDir = join(this.dataDir, 'archives');
    this.logsDir = join(this.dataDir, 'logs');
    this.trashDir = join(this.dataDir, 'trash');
    this.backupsDir = join(this.dataDir, 'backups');
    this.modesDir = join(this.dataDir, 'modes');
    this.userSettingsPath = join(this.dataDir, 'settings.json');
    this.dbPath = join(this.dataDir, 'claude-mem.db');
    this.vectorDbDir = join(this.dataDir, 'vector-db');
    this.observerSessionsDir = join(this.dataDir, 'observer-sessions');
  }

  /**
   * Get project-specific archive directory
   */
  getProjectArchiveDir(projectName: string): string {
    return join(this.archivesDir, projectName);
  }

  /**
   * Get worker socket path for a session
   */
  getWorkerSocketPath(sessionId: number): string {
    return join(this.dataDir, `worker-${sessionId}.sock`);
  }

  /**
   * Ensure all data directories exist
   */
  ensureAllDirs(): void {
    ensureDir(this.dataDir);
    ensureDir(this.archivesDir);
    ensureDir(this.logsDir);
    ensureDir(this.trashDir);
    ensureDir(this.backupsDir);
    ensureDir(this.modesDir);
  }

  /**
   * Check if this is an isolated workspace
   */
  get isIsolated(): boolean {
    return this.workspace.isolated;
  }

  /**
   * Get workspace name (for logging/display)
   */
  get workspaceName(): string {
    return this.workspace.name;
  }
}

// ============================================================================
// LEGACY EXPORTS (for backwards compatibility)
// These use the global/default paths without workspace isolation
// ============================================================================

/** @deprecated Use WorkspacePaths class for workspace-aware paths */
export const DATA_DIR = BASE_DATA_DIR;

/** @deprecated Use WorkspacePaths class for workspace-aware paths */
export const ARCHIVES_DIR = join(DATA_DIR, 'archives');

/** @deprecated Use WorkspacePaths class for workspace-aware paths */
export const LOGS_DIR = join(DATA_DIR, 'logs');

/** @deprecated Use WorkspacePaths class for workspace-aware paths */
export const TRASH_DIR = join(DATA_DIR, 'trash');

/** @deprecated Use WorkspacePaths class for workspace-aware paths */
export const BACKUPS_DIR = join(DATA_DIR, 'backups');

/** @deprecated Use WorkspacePaths class for workspace-aware paths */
export const MODES_DIR = join(DATA_DIR, 'modes');

/** @deprecated Use WorkspacePaths class for workspace-aware paths */
export const USER_SETTINGS_PATH = join(DATA_DIR, 'settings.json');

/** @deprecated Use WorkspacePaths class for workspace-aware paths */
export const DB_PATH = join(DATA_DIR, 'claude-mem.db');

/** @deprecated Use WorkspacePaths class for workspace-aware paths */
export const VECTOR_DB_DIR = join(DATA_DIR, 'vector-db');

/** @deprecated Use WorkspacePaths class for workspace-aware paths */
export const OBSERVER_SESSIONS_DIR = join(DATA_DIR, 'observer-sessions');

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Ensure a directory exists
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

/**
 * Ensure all data directories exist (legacy, global)
 * @deprecated Use WorkspacePaths.ensureAllDirs() for workspace-aware initialization
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
 * Get current project name from git root or cwd.
 * Includes parent directory to avoid collisions.
 */
export function getCurrentProjectName(): string {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    }).trim();
    return basename(dirname(gitRoot)) + '/' + basename(gitRoot);
  } catch (error) {
    logger.debug('SYSTEM', 'Git root detection failed, using cwd basename', {
      cwd: process.cwd()
    }, error as Error);
    const cwd = process.cwd();
    return basename(dirname(cwd)) + '/' + basename(cwd);
  }
}

/**
 * Find package root directory
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

/**
 * Get workspace-aware database path
 * This is the primary function to use when you need the correct DB path
 *
 * @param cwd - Current working directory
 * @returns Path to the workspace-specific database
 */
export function getWorkspaceDbPath(cwd: string | null | undefined): string {
  const paths = new WorkspacePaths(cwd);
  return paths.dbPath;
}

/**
 * Get workspace-aware data directory
 *
 * @param cwd - Current working directory
 * @returns Path to the workspace-specific data directory
 */
export function getWorkspaceDataDir(cwd: string | null | undefined): string {
  const paths = new WorkspacePaths(cwd);
  return paths.dataDir;
}

/** @deprecated Use getProjectArchiveDir from WorkspacePaths */
export function getProjectArchiveDir(projectName: string): string {
  return join(ARCHIVES_DIR, projectName);
}

/** @deprecated Use getWorkerSocketPath from WorkspacePaths */
export function getWorkerSocketPath(sessionId: number): string {
  return join(DATA_DIR, `worker-${sessionId}.sock`);
}
