/**
 * BranchManager: Git branch detection and switching for beta feature toggle
 *
 * Enables users to switch between stable (main) and beta branches via the UI.
 * The installed plugin at ~/.claude/plugins/marketplaces/thedotmack/ is a git repo.
 */

import { execSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../../utils/logger.js';

const INSTALLED_PLUGIN_PATH = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');

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
 * Execute git command in installed plugin directory
 */
function execGit(command: string): string {
  return execSync(`git ${command}`, {
    cwd: INSTALLED_PLUGIN_PATH,
    encoding: 'utf-8',
    timeout: 30000,
    windowsHide: true
  }).trim();
}

/**
 * Execute shell command in installed plugin directory
 */
function execShell(command: string, timeoutMs: number = 60000): string {
  return execSync(command, {
    cwd: INSTALLED_PLUGIN_PATH,
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true
  }).trim();
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
    const branch = execGit('rev-parse --abbrev-ref HEAD');

    // Check if dirty (has uncommitted changes)
    const status = execGit('status --porcelain');
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
    execGit('checkout -- .');
    execGit('clean -fd'); // Remove untracked files too

    // 2. Fetch latest
    logger.debug('BRANCH', 'Fetching from origin');
    execGit('fetch origin');

    // 3. Checkout target branch
    logger.debug('BRANCH', 'Checking out branch', { branch: targetBranch });
    try {
      execGit(`checkout ${targetBranch}`);
    } catch {
      // Branch might not exist locally, try tracking remote
      execGit(`checkout -b ${targetBranch} origin/${targetBranch}`);
    }

    // 4. Pull latest
    logger.debug('BRANCH', 'Pulling latest');
    execGit(`pull origin ${targetBranch}`);

    // 5. Clear install marker and run npm install
    const installMarker = join(INSTALLED_PLUGIN_PATH, '.install-version');
    if (existsSync(installMarker)) {
      unlinkSync(installMarker);
    }

    logger.debug('BRANCH', 'Running npm install');
    execShell('npm install', 120000); // 2 minute timeout for npm

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
      if (info.branch) {
        execGit(`checkout ${info.branch}`);
      }
    } catch {
      // Recovery failed, user needs manual intervention
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
    logger.info('BRANCH', 'Pulling updates', { branch: info.branch });

    // Discard local changes first
    execGit('checkout -- .');

    // Fetch and pull
    execGit('fetch origin');
    execGit(`pull origin ${info.branch}`);

    // Clear install marker and reinstall
    const installMarker = join(INSTALLED_PLUGIN_PATH, '.install-version');
    if (existsSync(installMarker)) {
      unlinkSync(installMarker);
    }
    execShell('npm install', 120000);

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
