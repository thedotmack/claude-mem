/**
 * BranchManager: Git branch detection and switching for beta feature toggle
 *
 * Enables users to switch between stable (main) and beta branches via the UI.
 * The installed plugin at ~/.claude/plugins/marketplaces/thedotmack/ is a git repo.
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';

// Alias for code clarity - this is the installed plugin path
const INSTALLED_PLUGIN_PATH = MARKETPLACE_ROOT;

/**
 * Validate branch name to prevent command injection
 * Only allows alphanumeric, hyphens, underscores, forward slashes, and dots
 */
function isValidBranchName(branchName: string): boolean {
  if (!branchName || typeof branchName !== 'string') {
    return false;
  }
  // Git branch name validation: alphanumeric, hyphen, underscore, slash, dot
  // Must not start with dot, hyphen, or slash
  // Must not contain double dots (..)
  const validBranchRegex = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
  return validBranchRegex.test(branchName) && !branchName.includes('..');
}

// Timeout constants (increased for slow systems)
const GIT_COMMAND_TIMEOUT_MS = 300_000;
const NPM_INSTALL_TIMEOUT_MS = 600_000;
const DEFAULT_SHELL_TIMEOUT_MS = 60_000;

export interface BranchInfo {
  branch: string | null;
  isBeta: boolean;
  isGitRepo: boolean;
  isDirty: boolean;
  canSwitch: boolean;
  error?: string;
}

export interface SwitchResult {
  success: boolean;
  branch?: string;
  message?: string;
  error?: string;
}

/**
 * Execute git command in installed plugin directory using safe array-based arguments
 * SECURITY: Uses spawnSync with argument array to prevent command injection
 */
function execGit(args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: INSTALLED_PLUGIN_PATH,
    encoding: 'utf-8',
    timeout: GIT_COMMAND_TIMEOUT_MS,
    windowsHide: true,
    shell: false  // CRITICAL: Never use shell with user input
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Git command failed');
  }

  return result.stdout.trim();
}

/**
 * Execute npm command in installed plugin directory using safe array-based arguments
 * SECURITY: Uses spawnSync with argument array to prevent command injection
 */
function execNpm(args: string[], timeoutMs: number = NPM_INSTALL_TIMEOUT_MS): string {
  const isWindows = process.platform === 'win32';
  const npmCmd = isWindows ? 'npm.cmd' : 'npm';

  const result = spawnSync(npmCmd, args, {
    cwd: INSTALLED_PLUGIN_PATH,
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
    shell: false  // CRITICAL: Never use shell with user input
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'npm command failed');
  }

  return result.stdout.trim();
}

/**
 * Get current branch information
 */
export function getBranchInfo(): BranchInfo {
  // Check if git repo exists
  const gitDir = join(INSTALLED_PLUGIN_PATH, '.git');
  if (!existsSync(gitDir)) {
    return {
      branch: null,
      isBeta: false,
      isGitRepo: false,
      isDirty: false,
      canSwitch: false,
      error: 'Installed plugin is not a git repository'
    };
  }

  try {
    // Get current branch
    const branch = execGit(['rev-parse', '--abbrev-ref', 'HEAD']);

    // Check if dirty (has uncommitted changes)
    const status = execGit(['status', '--porcelain']);
    const isDirty = status.length > 0;

    // Determine if on beta branch
    const isBeta = branch.startsWith('beta');

    return {
      branch,
      isBeta,
      isGitRepo: true,
      isDirty,
      canSwitch: true // We can always switch (will discard local changes)
    };
  } catch (error) {
    logger.error('BRANCH', 'Failed to get branch info', {}, error as Error);
    return {
      branch: null,
      isBeta: false,
      isGitRepo: true,
      isDirty: false,
      canSwitch: false,
      error: (error as Error).message
    };
  }
}

/**
 * Switch to a different branch
 *
 * Steps:
 * 1. Discard local changes (from rsync syncs)
 * 2. Fetch latest from origin
 * 3. Checkout target branch
 * 4. Pull latest
 * 5. Clear install marker and run npm install
 * 6. Restart worker (handled by caller after response)
 */
export async function switchBranch(targetBranch: string): Promise<SwitchResult> {
  // SECURITY: Validate branch name to prevent command injection
  if (!isValidBranchName(targetBranch)) {
    return {
      success: false,
      error: `Invalid branch name: ${targetBranch}. Branch names must be alphanumeric with hyphens, underscores, slashes, or dots.`
    };
  }

  const info = getBranchInfo();

  if (!info.isGitRepo) {
    return {
      success: false,
      error: 'Installed plugin is not a git repository. Please reinstall.'
    };
  }

  if (info.branch === targetBranch) {
    return {
      success: true,
      branch: targetBranch,
      message: `Already on branch ${targetBranch}`
    };
  }

  try {
    logger.info('BRANCH', 'Starting branch switch', {
      from: info.branch,
      to: targetBranch
    });

    // 1. Discard local changes (safe - user data is at ~/.claude-mem/)
    logger.debug('BRANCH', 'Discarding local changes');
    execGit(['checkout', '--', '.']);
    execGit(['clean', '-fd']); // Remove untracked files too

    // 2. Fetch latest
    logger.debug('BRANCH', 'Fetching from origin');
    execGit(['fetch', 'origin']);

    // 3. Checkout target branch
    logger.debug('BRANCH', 'Checking out branch', { branch: targetBranch });
    try {
      execGit(['checkout', targetBranch]);
    } catch (error) {
      // Branch might not exist locally, try tracking remote
      logger.debug('BRANCH', 'Branch not local, tracking remote', { branch: targetBranch, error: error instanceof Error ? error.message : String(error) });
      execGit(['checkout', '-b', targetBranch, `origin/${targetBranch}`]);
    }

    // 4. Pull latest
    logger.debug('BRANCH', 'Pulling latest');
    execGit(['pull', 'origin', targetBranch]);

    // 5. Clear install marker and run npm install
    const installMarker = join(INSTALLED_PLUGIN_PATH, '.install-version');
    if (existsSync(installMarker)) {
      unlinkSync(installMarker);
    }

    logger.debug('BRANCH', 'Running npm install');
    execNpm(['install'], NPM_INSTALL_TIMEOUT_MS);

    logger.success('BRANCH', 'Branch switch complete', {
      branch: targetBranch
    });

    return {
      success: true,
      branch: targetBranch,
      message: `Switched to ${targetBranch}. Worker will restart automatically.`
    };
  } catch (error) {
    logger.error('BRANCH', 'Branch switch failed', { targetBranch }, error as Error);

    // Try to recover by checking out original branch
    try {
      if (info.branch && isValidBranchName(info.branch)) {
        execGit(['checkout', info.branch]);
      }
    } catch (recoveryError) {
      // [POSSIBLY RELEVANT]: Recovery checkout failed, user needs manual intervention - already logging main error above
      logger.error('BRANCH', 'Recovery checkout also failed', { originalBranch: info.branch }, recoveryError as Error);
    }

    return {
      success: false,
      error: `Branch switch failed: ${(error as Error).message}`
    };
  }
}

/**
 * Pull latest updates for current branch
 */
export async function pullUpdates(): Promise<SwitchResult> {
  const info = getBranchInfo();

  if (!info.isGitRepo || !info.branch) {
    return {
      success: false,
      error: 'Cannot pull updates: not a git repository'
    };
  }

  try {
    // SECURITY: Validate branch name before use
    if (!isValidBranchName(info.branch)) {
      return {
        success: false,
        error: `Invalid current branch name: ${info.branch}`
      };
    }

    logger.info('BRANCH', 'Pulling updates', { branch: info.branch });

    // Discard local changes first
    execGit(['checkout', '--', '.']);

    // Fetch and pull
    execGit(['fetch', 'origin']);
    execGit(['pull', 'origin', info.branch]);

    // Clear install marker and reinstall
    const installMarker = join(INSTALLED_PLUGIN_PATH, '.install-version');
    if (existsSync(installMarker)) {
      unlinkSync(installMarker);
    }
    execNpm(['install'], NPM_INSTALL_TIMEOUT_MS);

    logger.success('BRANCH', 'Updates pulled', { branch: info.branch });

    return {
      success: true,
      branch: info.branch,
      message: `Updated ${info.branch}. Worker will restart automatically.`
    };
  } catch (error) {
    logger.error('BRANCH', 'Pull failed', {}, error as Error);
    return {
      success: false,
      error: `Pull failed: ${(error as Error).message}`
    };
  }
}

/**
 * Get installed plugin path (for external use)
 */
export function getInstalledPluginPath(): string {
  return INSTALLED_PLUGIN_PATH;
}
