/**
 * Git-aware project identity resolution
 *
 * Resolves project identity using a cascade:
 * 1. .claude-mem config file in repo root (explicit override)
 * 2. Git remote origin URL (normalized)
 * 3. Git repo root basename
 * 4. Folder basename (fallback for non-git directories)
 */

import path from 'path';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { logger } from './logger.js';

const GIT_COMMAND_TIMEOUT_MS = 5000;

export interface ProjectIdentity {
  name: string;
  source: 'config' | 'remote' | 'git-root' | 'folder';
  cwd: string;
}

// Module-level cache (per-process, no TTL needed)
const identityCache = new Map<string, ProjectIdentity>();

/**
 * Execute git command safely with argument array
 * Returns null on any failure (graceful degradation)
 */
function execGit(args: string[], cwd: string): string | null {
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: GIT_COMMAND_TIMEOUT_MS,
      windowsHide: true,
      shell: false, // CRITICAL: Never use shell
      stdio: ['pipe', 'pipe', 'ignore'], // Suppress stderr
    });

    if (result.error || result.status !== 0) {
      return null;
    }

    return result.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Get git repository root for a directory
 * Returns null if not a git repo or git not available
 */
export function getGitRoot(cwd: string): string | null {
  return execGit(['rev-parse', '--show-toplevel'], cwd);
}

/**
 * Get git remote origin URL
 * Returns null if no remote or git not available
 */
export function getGitRemoteOrigin(cwd: string): string | null {
  return execGit(['remote', 'get-url', 'origin'], cwd);
}

/**
 * Normalize git remote URL to a consistent project identity
 *
 * Examples:
 * - https://github.com/user/repo.git -> github.com/user/repo
 * - git@github.com:user/repo.git -> github.com/user/repo
 * - ssh://git@github.com/user/repo.git -> github.com/user/repo
 */
export function normalizeRemoteUrl(url: string): string {
  // Remove trailing .git suffix
  let normalized = url.replace(/\.git$/, '');

  // Handle SSH format: git@github.com:user/repo
  const sshMatch = normalized.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  // Handle HTTPS format: https://github.com/user/repo
  const httpsMatch = normalized.match(/^https?:\/\/([^/]+)\/(.+)$/);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  // Handle SSH URL format: ssh://git@github.com/user/repo
  const sshUrlMatch = normalized.match(/^ssh:\/\/[^@]+@([^/]+)\/(.+)$/);
  if (sshUrlMatch) {
    return `${sshUrlMatch[1]}/${sshUrlMatch[2]}`;
  }

  // Fallback: return as-is (rare edge case)
  return normalized;
}

/**
 * Read .claude-mem config from repo root
 * Returns project name if configured, null otherwise
 */
export function getConfigProjectName(gitRoot: string): string | null {
  const configPath = path.join(gitRoot, '.claude-mem');

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    if (typeof config.projectName === 'string' && config.projectName.trim()) {
      return config.projectName.trim();
    }

    return null;
  } catch (error) {
    // Invalid JSON or read error - silently fall through to next cascade level
    logger.debug('GIT_IDENTITY', 'Failed to read .claude-mem config', { gitRoot }, error as Error);
    return null;
  }
}

/**
 * Get folder basename (original fallback logic)
 */
function getFolderBasename(cwd: string): string {
  const basename = path.basename(cwd);

  // Edge case: Drive roots on Windows (C:\) or Unix root (/)
  if (basename === '') {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const driveMatch = cwd.match(/^([A-Z]):\\/i);
      if (driveMatch) {
        return `drive-${driveMatch[1].toUpperCase()}`;
      }
    }
    return 'unknown-project';
  }

  return basename;
}

/**
 * Resolve project identity using the cascade (uncached)
 */
function resolveIdentityUncached(cwd: string): ProjectIdentity {
  // Try git-based identity first
  const gitRoot = getGitRoot(cwd);

  if (gitRoot) {
    // 1. Check for .claude-mem config
    const configName = getConfigProjectName(gitRoot);
    if (configName) {
      return { name: configName, source: 'config', cwd };
    }

    // 2. Try git remote origin
    const remoteUrl = getGitRemoteOrigin(cwd);
    if (remoteUrl) {
      const normalized = normalizeRemoteUrl(remoteUrl);
      return { name: normalized, source: 'remote', cwd };
    }

    // 3. Use git root basename
    const gitRootBasename = path.basename(gitRoot);
    if (gitRootBasename) {
      return { name: gitRootBasename, source: 'git-root', cwd };
    }
  }

  // 4. Fallback to folder basename
  return { name: getFolderBasename(cwd), source: 'folder', cwd };
}

/**
 * Resolve project identity using the cascade (cached)
 *
 * Priority:
 * 1. .claude-mem config file in repo root
 * 2. Git remote origin URL (normalized)
 * 3. Git repo root basename
 * 4. Folder basename (fallback)
 */
export function resolveProjectIdentity(cwd: string): ProjectIdentity {
  // Check cache first
  const cached = identityCache.get(cwd);
  if (cached) {
    return cached;
  }

  // Resolve identity using cascade
  const identity = resolveIdentityUncached(cwd);

  // Cache the result
  identityCache.set(cwd, identity);

  logger.debug('GIT_IDENTITY', 'Resolved project identity', {
    cwd,
    name: identity.name,
    source: identity.source,
  });

  return identity;
}

/**
 * Clear the identity cache (for testing)
 */
export function clearIdentityCache(): void {
  identityCache.clear();
}
