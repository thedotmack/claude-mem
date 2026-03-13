/**
 * Workspace Detection and Isolation
 *
 * Detects workspace boundaries based on configurable root directories.
 * Enables complete data isolation between different workspaces (e.g., different clients).
 *
 * @example
 * // With CLAUDE_MEM_WORKSPACE_ROOTS="/Users/djonatas/projetos/CFD,/Users/djonatas/projetos/DJ Company"
 * // Working in /Users/djonatas/projetos/CFD/pulse-back
 * getWorkspace(cwd) // Returns { name: "CFD", root: "/Users/djonatas/projetos/CFD", isolated: true }
 *
 * // Working in /Users/djonatas/projetos/personal/my-project
 * getWorkspace(cwd) // Returns { name: "global", root: null, isolated: false }
 */

import path from 'path';
import { logger } from './logger.js';

/**
 * Workspace information
 */
export interface WorkspaceInfo {
  /** Workspace name (sanitized for filesystem) */
  name: string;
  /** Workspace root directory (null if global) */
  root: string | null;
  /** Whether this workspace is isolated (has its own data directory) */
  isolated: boolean;
  /** Original cwd that was analyzed */
  cwd: string;
}

/**
 * Configuration for workspace roots
 * Can be set via:
 * 1. Environment variable: CLAUDE_MEM_WORKSPACE_ROOTS (comma-separated paths)
 * 2. Settings file: workspaceRoots array
 */
let workspaceRootsCache: string[] | null = null;

/**
 * Get configured workspace roots
 * Returns array of absolute paths that define workspace boundaries
 */
export function getWorkspaceRoots(): string[] {
  if (workspaceRootsCache !== null) {
    return workspaceRootsCache;
  }

  const envRoots = process.env.CLAUDE_MEM_WORKSPACE_ROOTS;

  if (envRoots) {
    workspaceRootsCache = envRoots
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0)
      .map(p => path.resolve(p)); // Normalize to absolute paths

    logger.info('WORKSPACE', 'Loaded workspace roots from environment', {
      roots: workspaceRootsCache
    });
  } else {
    workspaceRootsCache = [];
  }

  return workspaceRootsCache;
}

/**
 * Clear workspace roots cache (for testing)
 */
export function clearWorkspaceRootsCache(): void {
  workspaceRootsCache = null;
}

/**
 * Set workspace roots programmatically (for testing or runtime configuration)
 */
export function setWorkspaceRoots(roots: string[]): void {
  workspaceRootsCache = roots.map(p => path.resolve(p));
}

/**
 * Sanitize workspace name for filesystem use
 * Replaces spaces and special characters with underscores
 */
export function sanitizeWorkspaceName(name: string): string {
  return name
    .trim()
    .replace(/[<>:"/\\|?*\s]+/g, '_')  // Replace invalid chars and spaces
    .replace(/^_+|_+$/g, '')            // Trim leading/trailing underscores
    .toLowerCase();                      // Normalize to lowercase
}

/**
 * Detect which workspace a directory belongs to
 *
 * @param cwd - Current working directory (absolute path)
 * @returns WorkspaceInfo with workspace details
 */
export function getWorkspace(cwd: string | null | undefined): WorkspaceInfo {
  const defaultResult: WorkspaceInfo = {
    name: 'global',
    root: null,
    isolated: false,
    cwd: cwd || process.cwd()
  };

  if (!cwd) {
    logger.debug('WORKSPACE', 'No cwd provided, using global workspace');
    return defaultResult;
  }

  const normalizedCwd = path.resolve(cwd);
  const roots = getWorkspaceRoots();

  if (roots.length === 0) {
    logger.debug('WORKSPACE', 'No workspace roots configured, using global workspace', { cwd });
    return { ...defaultResult, cwd: normalizedCwd };
  }

  // Find which workspace root contains this cwd
  for (const root of roots) {
    // Check if cwd is inside this workspace root
    const relative = path.relative(root, normalizedCwd);

    // If relative path doesn't start with '..', cwd is inside or equal to root
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      const workspaceName = sanitizeWorkspaceName(path.basename(root));

      logger.debug('WORKSPACE', 'Detected isolated workspace', {
        cwd: normalizedCwd,
        workspaceRoot: root,
        workspaceName
      });

      return {
        name: workspaceName,
        root,
        isolated: true,
        cwd: normalizedCwd
      };
    }
  }

  logger.debug('WORKSPACE', 'Directory not in any configured workspace, using global', {
    cwd: normalizedCwd,
    configuredRoots: roots
  });

  return { ...defaultResult, cwd: normalizedCwd };
}

/**
 * Get workspace-specific data directory
 *
 * @param baseDataDir - Base data directory (e.g., ~/.claude-mem)
 * @param workspace - Workspace info from getWorkspace()
 * @returns Path to workspace-specific data directory
 */
export function getWorkspaceDataDir(baseDataDir: string, workspace: WorkspaceInfo): string {
  if (!workspace.isolated) {
    // Global workspace uses base directory directly
    return baseDataDir;
  }

  // Isolated workspace gets its own subdirectory
  return path.join(baseDataDir, 'workspaces', workspace.name);
}

/**
 * Check if workspace isolation is enabled
 * Returns true if any workspace roots are configured
 */
export function isWorkspaceIsolationEnabled(): boolean {
  return getWorkspaceRoots().length > 0;
}
