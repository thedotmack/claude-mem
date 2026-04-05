import { execSync } from 'child_process';
import { logger } from './logger.js';

const MAX_MERGED_BRANCHES = 50;

export function getCurrentBranch(cwd?: string): string | null {
  try {
    const result = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true
    }).trim();
    return result === 'HEAD' ? null : result;  // detached HEAD → null
  } catch {
    return null;  // not a git repo
  }
}

export function getMergedBranches(cwd?: string): string[] {
  try {
    const result = execSync('git branch --merged HEAD', {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true
    }).trim();
    if (!result) return [];
    return result
      .split('\n')
      .map(b => b.replace(/^\*?\s+/, '').trim())
      .filter(Boolean)
      .slice(0, MAX_MERGED_BRANCHES);
  } catch {
    return [];
  }
}
