/**
 * Git ancestry resolution utility for branch memory feature.
 * Determines which commit SHAs are ancestors of the current HEAD,
 * enabling the "like how git works" visibility model — observations
 * from merged branches become visible automatically, while sibling
 * branch work stays invisible.
 */

import { execSync } from 'child_process';
import { isGitRepository } from './git-branch.js';
import { logger } from '../../utils/logger.js';

/**
 * Get the current HEAD commit SHA for a working directory.
 * Returns the full 40-character hex SHA, or null if not in a git repo.
 */
export async function getCurrentHead(cwd: string): Promise<string | null> {
  try {
    const sha = execSync('git rev-parse HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000
    }).trim();

    return sha || null;
  } catch {
    return null;
  }
}

/** Batch size for concurrent git merge-base checks */
const MERGE_BASE_BATCH_SIZE = 100;

/** Threshold above which we switch to git-log-based ancestor resolution */
const GIT_LOG_OPTIMIZATION_THRESHOLD = 500;

/**
 * Given a current HEAD SHA and a list of candidate commit SHAs,
 * return the subset that are ancestors of currentHead.
 *
 * Uses `git merge-base --is-ancestor` which exits 0 if the candidate
 * IS an ancestor, non-zero if not.
 *
 * Performance:
 * - <= 100 candidates: all checked concurrently
 * - 101-500 candidates: batched in groups of 100
 * - > 500 candidates: uses `git log --format=%H` to get all ancestors in one call, then intersects (falls back to batched merge-base on failure)
 *
 * Per-SHA errors (e.g. SHA no longer exists after GC, shallow clone truncated history)
 * are handled gracefully — the SHA is excluded rather than failing the batch.
 */
export async function resolveAncestorCommits(
  currentHead: string,
  candidateCommitShas: string[],
  cwd: string
): Promise<string[]> {
  if (candidateCommitShas.length === 0) return [];

  // For very large candidate sets, use git log optimization
  if (candidateCommitShas.length > GIT_LOG_OPTIMIZATION_THRESHOLD) {
    logger.debug('DB', `resolveAncestorCommits: using git-log optimization for ${candidateCommitShas.length} candidates`);
    const result = resolveViaGitLog(currentHead, candidateCommitShas, cwd);
    if (result !== null) {
      logger.debug('DB', `resolveAncestorCommits: ${result.length}/${candidateCommitShas.length} candidates visible`);
      return result;
    }
    // git log failed (e.g. shallow clone) — fall back to batched merge-base
    logger.debug('DB', `resolveAncestorCommits: git-log failed, falling back to batched merge-base for ${candidateCommitShas.length} candidates`);
  }

  // For moderate sets, batch the merge-base checks
  if (candidateCommitShas.length > MERGE_BASE_BATCH_SIZE) {
    logger.debug('DB', `resolveAncestorCommits: batching ${candidateCommitShas.length} candidates in groups of ${MERGE_BASE_BATCH_SIZE}`);
    const allResults: string[] = [];
    for (let i = 0; i < candidateCommitShas.length; i += MERGE_BASE_BATCH_SIZE) {
      const batch = candidateCommitShas.slice(i, i + MERGE_BASE_BATCH_SIZE);
      const batchResults = await checkAncestryBatch(currentHead, batch, cwd);
      allResults.push(...batchResults);
    }
    logger.debug('DB', `resolveAncestorCommits: ${allResults.length}/${candidateCommitShas.length} candidates visible`);
    return allResults;
  }

  // Small sets: check all concurrently
  const results = await checkAncestryBatch(currentHead, candidateCommitShas, cwd);
  logger.debug('DB', `resolveAncestorCommits: ${results.length}/${candidateCommitShas.length} candidates visible`);
  return results;
}

/**
 * Check ancestry for a batch of candidates concurrently using git merge-base.
 * Handles shallow clone failures gracefully (treats as "not an ancestor").
 */
async function checkAncestryBatch(
  currentHead: string,
  candidates: string[],
  cwd: string
): Promise<string[]> {
  const results = await Promise.all(
    candidates.map(async (candidateSha) => {
      try {
        execSync(`git merge-base --is-ancestor ${candidateSha} ${currentHead}`, {
          cwd,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000
        });
        // Exit code 0 means candidate IS an ancestor
        return candidateSha;
      } catch {
        // Non-zero exit or error means not an ancestor (or SHA doesn't exist)
        // This also gracefully handles shallow clones where history is truncated
        return null;
      }
    })
  );

  return results.filter((sha): sha is string => sha !== null);
}

/**
 * Resolve ancestors by fetching the full commit history with `git log`
 * and intersecting with candidates via a Set. O(n) instead of O(n) git calls.
 * Used when candidate count exceeds GIT_LOG_OPTIMIZATION_THRESHOLD.
 */
function resolveViaGitLog(
  currentHead: string,
  candidateCommitShas: string[],
  cwd: string
): string[] | null {
  try {
    const allAncestors = execSync(`git log --format=%H ${currentHead}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      maxBuffer: 50 * 1024 * 1024  // 50MB buffer for large repos
    }).trim();

    const ancestorSet = new Set(allAncestors.split('\n'));
    return candidateCommitShas.filter(sha => ancestorSet.has(sha));
  } catch {
    // Return null to signal failure — caller falls back to batched merge-base
    logger.debug('DB', 'resolveViaGitLog failed, signaling caller to use batched merge-base');
    return null;
  }
}

/**
 * Combined branch resolution: get current HEAD and filter candidate SHAs
 * to only those that are ancestors of HEAD.
 *
 * Returns null if not in a git repo (meaning "no filtering, show everything").
 * Returns an empty array if in a git repo but no ancestors found.
 * This null = unfiltered convention lets callers distinguish between
 * "not in a git repo" (show all) and "in a git repo but no ancestors" (show nothing from branches).
 */
export async function resolveVisibleCommitShas(
  candidateCommitShas: string[],
  cwd: string
): Promise<string[] | null> {
  // Early guard: skip expensive ancestry checks when not in a git repo
  const isRepo = await isGitRepository(cwd);
  if (!isRepo) return null;

  const currentHead = await getCurrentHead(cwd);
  if (currentHead === null) return null;

  if (candidateCommitShas.length === 0) return [];

  return resolveAncestorCommits(currentHead, candidateCommitShas, cwd);
}
