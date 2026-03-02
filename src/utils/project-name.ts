import path from 'path';
import fs from 'fs';
import { logger } from './logger.js';
import { detectWorktree } from './worktree.js';

// ============================================================================
// Hub Mode Configuration
// ============================================================================

/**
 * Hub mode config file structure (.claude-mem-hub.json)
 * When present in the CWD, enables file-path-based project detection
 * instead of the default basename(cwd) approach.
 */
export interface HubConfig {
  hub_mode: boolean;
  default_project: string;
  project_patterns: Record<string, string>;
  /**
   * Absolute path patterns for files outside the vault.
   * Key: absolute path prefix (e.g. "/home/user/claude-mem")
   * Value: project name
   */
  absolute_patterns?: Record<string, string>;
}

// Cache hub config per cwd to avoid repeated filesystem reads
const hubConfigCache = new Map<string, { config: HubConfig | null; mtime: number }>();

/**
 * Load hub mode configuration from .claude-mem-hub.json in the given directory.
 * Returns null if the file doesn't exist or hub_mode is false.
 * Results are cached and invalidated when the file's mtime changes.
 */
export function loadHubConfig(cwd: string | null | undefined): HubConfig | null {
  if (!cwd) return null;

  const configPath = path.join(cwd, '.claude-mem-hub.json');

  try {
    const stat = fs.statSync(configPath);
    const cached = hubConfigCache.get(cwd);
    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.config;
    }

    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as HubConfig;

    if (!parsed.hub_mode) {
      hubConfigCache.set(cwd, { config: null, mtime: stat.mtimeMs });
      return null;
    }

    if (!parsed.default_project || !parsed.project_patterns) {
      logger.warn('HUB_CONFIG', 'Invalid hub config: missing default_project or project_patterns', { configPath });
      hubConfigCache.set(cwd, { config: null, mtime: stat.mtimeMs });
      return null;
    }

    logger.info('HUB_CONFIG', 'Hub mode config loaded', {
      defaultProject: parsed.default_project,
      patternCount: Object.keys(parsed.project_patterns).length
    });

    hubConfigCache.set(cwd, { config: parsed, mtime: stat.mtimeMs });
    return parsed;
  } catch {
    // File doesn't exist or can't be read — not hub mode
    hubConfigCache.set(cwd, { config: null, mtime: 0 });
    return null;
  }
}

/**
 * Resolve a file path to a project name using hub config patterns.
 *
 * Strategy:
 * 1. Normalize the file path relative to CWD
 * 2. Try to resolve symlinks via fs.realpathSync (fallback to original path)
 * 3. Do longest-prefix match against project_patterns
 * 4. Return matched project name or default_project
 */
export function resolveProjectFromFilePath(
  filePath: string,
  cwd: string,
  hubConfig: HubConfig
): string {
  if (!filePath) return hubConfig.default_project;

  // Make path relative to cwd for pattern matching
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const relativePath = path.relative(cwd, absolutePath);

  // Also try resolved symlink path
  let resolvedRelativePath: string | null = null;
  try {
    const realPath = fs.realpathSync(absolutePath);
    resolvedRelativePath = path.relative(cwd, realPath);
  } catch {
    // Symlink resolution failed — use original relative path
  }

  // Check absolute_patterns first (files outside the vault accessed by real path)
  // Sort by length (longest first) for correct prefix matching
  if (hubConfig.absolute_patterns) {
    const sortedAbsolute = Object.entries(hubConfig.absolute_patterns)
      .sort(([a], [b]) => b.length - a.length);
    for (const [absPattern, projectName] of sortedAbsolute) {
      const normalized = absPattern.replace(/\/$/, '');
      if (absolutePath.startsWith(normalized + '/') || absolutePath === normalized) {
        return projectName;
      }
    }
  }

  // Longest-prefix match against project_patterns (vault-relative paths)
  // Sort patterns by length (longest first) for correct matching
  const sortedPatterns = Object.entries(hubConfig.project_patterns)
    .sort(([a], [b]) => b.length - a.length);

  for (const [pattern, projectName] of sortedPatterns) {
    const normalizedPattern = pattern.replace(/\/$/, '');

    if (relativePath.startsWith(normalizedPattern + '/') || relativePath === normalizedPattern) {
      return projectName;
    }

    // Also check against symlink-resolved path
    if (resolvedRelativePath &&
      (resolvedRelativePath.startsWith(normalizedPattern + '/') || resolvedRelativePath === normalizedPattern)) {
      return projectName;
    }
  }

  return hubConfig.default_project;
}

/**
 * Clear the hub config cache (for testing)
 */
export function clearHubConfigCache(): void {
  hubConfigCache.clear();
}

/**
 * Extract project name from working directory path
 * Handles edge cases: null/undefined cwd, drive roots, trailing slashes
 *
 * @param cwd - Current working directory (absolute path)
 * @returns Project name or "unknown-project" if extraction fails
 */
export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  // Extract basename (handles trailing slashes automatically)
  const basename = path.basename(cwd);

  // Edge case: Drive roots on Windows (C:\, J:\) or Unix root (/)
  // path.basename('C:\') returns '' (empty string)
  if (basename === '') {
    // Extract drive letter on Windows, or use 'root' on Unix
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const driveMatch = cwd.match(/^([A-Z]):\\/i);
      if (driveMatch) {
        const driveLetter = driveMatch[1].toUpperCase();
        const projectName = `drive-${driveLetter}`;
        logger.info('PROJECT_NAME', 'Drive root detected', { cwd, projectName });
        return projectName;
      }
    }
    logger.warn('PROJECT_NAME', 'Root directory detected, using fallback', { cwd });
    return 'unknown-project';
  }

  return basename;
}

/**
 * Project context with worktree awareness
 */
export interface ProjectContext {
  /** The current project name (worktree or main repo) */
  primary: string;
  /** Parent project name if in a worktree, null otherwise */
  parent: string | null;
  /** True if currently in a worktree */
  isWorktree: boolean;
  /** All projects to query: [primary] for main repo, [parent, primary] for worktree */
  allProjects: string[];
}

/**
 * Get project context with worktree and hub mode detection.
 *
 * Priority:
 * 1. Hub mode — returns all known projects from hub config
 * 2. Worktree — returns parent + primary project
 * 3. Default — returns single project from basename(cwd)
 *
 * @param cwd - Current working directory (absolute path)
 * @returns ProjectContext with worktree/hub info
 */
export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const primary = getProjectName(cwd);

  if (!cwd) {
    return { primary, parent: null, isWorktree: false, allProjects: [primary] };
  }

  // Check hub mode first — takes priority over worktree detection
  // In hub mode, only return default_project in allProjects to avoid context dilution.
  // Project selection is handled by the context handler (hub projects table) and /focus skill.
  const hubConfig = loadHubConfig(cwd);
  if (hubConfig) {
    return {
      primary: hubConfig.default_project,
      parent: null,
      isWorktree: false,
      allProjects: [hubConfig.default_project]
    };
  }

  const worktreeInfo = detectWorktree(cwd);

  if (worktreeInfo.isWorktree && worktreeInfo.parentProjectName) {
    // In a worktree: include parent first for chronological ordering
    return {
      primary,
      parent: worktreeInfo.parentProjectName,
      isWorktree: true,
      allProjects: [worktreeInfo.parentProjectName, primary]
    };
  }

  return { primary, parent: null, isWorktree: false, allProjects: [primary] };
}
