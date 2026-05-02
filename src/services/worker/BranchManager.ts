
import { execSync, spawnSync } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger.js';
import { MARKETPLACE_ROOT } from '../../shared/paths.js';

const INSTALLED_PLUGIN_PATH = MARKETPLACE_ROOT;

function isValidBranchName(branchName: string): boolean {
  if (!branchName || typeof branchName !== 'string') {
    return false;
  }
  const validBranchRegex = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
  return validBranchRegex.test(branchName) && !branchName.includes('..');
}

const GIT_COMMAND_TIMEOUT_MS = 300_000;
const NPM_INSTALL_TIMEOUT_MS = 600_000;

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

function execGit(args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: INSTALLED_PLUGIN_PATH,
    encoding: 'utf-8',
    timeout: GIT_COMMAND_TIMEOUT_MS,
    windowsHide: true,
    shell: false  
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Git command failed');
  }

  return result.stdout.trim();
}

function execNpm(args: string[], timeoutMs: number = NPM_INSTALL_TIMEOUT_MS): string {
  const isWindows = process.platform === 'win32';
  const npmCmd = isWindows ? 'npm.cmd' : 'npm';

  const result = spawnSync(npmCmd, args, {
    cwd: INSTALLED_PLUGIN_PATH,
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
    shell: false  
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'npm command failed');
  }

  return result.stdout.trim();
}

export function getBranchInfo(): BranchInfo {
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

  let branch: string;
  let status: string;
  try {
    branch = execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    status = execGit(['status', '--porcelain']);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('WORKER', 'Failed to get branch info', {}, error instanceof Error ? error : new Error(errorMessage));
    return {
      branch: null,
      isBeta: false,
      isGitRepo: true,
      isDirty: false,
      canSwitch: false,
      error: errorMessage
    };
  }

  const isDirty = status.length > 0;
  const isBeta = branch.startsWith('beta');

  return {
    branch,
    isBeta,
    isGitRepo: true,
    isDirty,
    canSwitch: true 
  };
}

export async function switchBranch(targetBranch: string): Promise<SwitchResult> {
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

    logger.debug('BRANCH', 'Discarding local changes');
    execGit(['checkout', '--', '.']);
    execGit(['clean', '-fd']); 

    logger.debug('BRANCH', 'Fetching from origin');
    execGit(['fetch', 'origin']);

    logger.debug('BRANCH', 'Checking out branch', { branch: targetBranch });
    try {
      execGit(['checkout', targetBranch]);
    } catch (error) {
      logger.debug('BRANCH', 'Branch not local, tracking remote', { branch: targetBranch, error: error instanceof Error ? error.message : String(error) });
      execGit(['checkout', '-b', targetBranch, `origin/${targetBranch}`]);
    }

    logger.debug('BRANCH', 'Pulling latest');
    execGit(['pull', 'origin', targetBranch]);

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

    try {
      if (info.branch && isValidBranchName(info.branch)) {
        execGit(['checkout', info.branch]);
      }
    } catch (recoveryError) {
      const recoveryErrorMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      logger.error('WORKER', 'Recovery checkout also failed', { originalBranch: info.branch }, recoveryError instanceof Error ? recoveryError : new Error(recoveryErrorMessage));
    }

    return {
      success: false,
      error: `Branch switch failed: ${(error as Error).message}`
    };
  }
}

export async function pullUpdates(): Promise<SwitchResult> {
  const info = getBranchInfo();

  if (!info.isGitRepo || !info.branch) {
    return {
      success: false,
      error: 'Cannot pull updates: not a git repository'
    };
  }

  if (!isValidBranchName(info.branch)) {
    return {
      success: false,
      error: `Invalid current branch name: ${info.branch}`
    };
  }

  logger.info('BRANCH', 'Pulling updates', { branch: info.branch });

  const installMarker = join(INSTALLED_PLUGIN_PATH, '.install-version');

  try {
    execGit(['checkout', '--', '.']);

    execGit(['fetch', 'origin']);
    execGit(['pull', 'origin', info.branch]);

    if (existsSync(installMarker)) {
      unlinkSync(installMarker);
    }
    execNpm(['install'], NPM_INSTALL_TIMEOUT_MS);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('WORKER', 'Pull failed', {}, error instanceof Error ? error : new Error(errorMessage));
    return {
      success: false,
      error: `Pull failed: ${errorMessage}`
    };
  }

  logger.success('BRANCH', 'Updates pulled', { branch: info.branch });

  return {
    success: true,
    branch: info.branch,
    message: `Updated ${info.branch}. Worker will restart automatically.`
  };
}

