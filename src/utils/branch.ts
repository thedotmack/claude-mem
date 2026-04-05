import { execSync } from 'child_process';
import { Database } from 'bun:sqlite';
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

export function detectOrphanedBranches(
  db: Database,
  project: string,
  cwd?: string
): { orphanedBranches: string[]; updatedCount: number } {
  try {
    // 1. Get all distinct branches from observations for this project
    const dbBranches = db.prepare(
      'SELECT DISTINCT branch FROM observations WHERE project = ? AND branch IS NOT NULL'
    ).all(project) as { branch: string }[];

    if (dbBranches.length === 0) {
      return { orphanedBranches: [], updatedCount: 0 };
    }

    // 2. Get current local branches from git
    const gitResult = execSync('git branch --list', {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true
    }).trim();

    const localBranches = gitResult
      .split('\n')
      .map(b => b.replace(/^\*?\s+/, '').trim())
      .filter(Boolean);

    if (localBranches.length === 0) {
      return { orphanedBranches: [], updatedCount: 0 };
    }

    // 3. Find orphaned branches (in DB but not in git)
    const localBranchSet = new Set(localBranches);
    const orphanedBranches = dbBranches
      .map(r => r.branch)
      .filter(b => !localBranchSet.has(b));

    if (orphanedBranches.length === 0) {
      return { orphanedBranches: [], updatedCount: 0 };
    }

    // 4. Mark orphaned observations as discarded
    let updatedCount = 0;
    for (const branch of orphanedBranches) {
      const result = db.prepare(
        "UPDATE observations SET status = 'discarded_by_llm' WHERE project = ? AND branch = ? AND status = 'active'"
      ).run(project, branch);
      updatedCount += result.changes;
    }

    logger.debug('BRANCH', `Detected ${orphanedBranches.length} orphaned branches, updated ${updatedCount} observations`, {
      orphanedBranches,
      updatedCount
    });

    return { orphanedBranches, updatedCount };
  } catch {
    // Git failure is non-fatal
    return { orphanedBranches: [], updatedCount: 0 };
  }
}
