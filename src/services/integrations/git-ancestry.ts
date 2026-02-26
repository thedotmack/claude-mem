/**
 * Git ancestry resolution utility for branch memory feature.
 * Determines which commit SHAs are ancestors of the current HEAD,
 * enabling the "like how git works" visibility model — observations
 * from merged branches become visible automatically, while sibling
 * branch work stays invisible.
 */

import { execSync } from 'child_process';

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

/**
 * Given a current HEAD SHA and a list of candidate commit SHAs,
 * return the subset that are ancestors of currentHead.
 *
 * Uses `git merge-base --is-ancestor` which exits 0 if the candidate
 * IS an ancestor, non-zero if not. Each check runs concurrently.
 *
 * Per-SHA errors (e.g. SHA no longer exists after GC) are handled
 * gracefully — the SHA is excluded rather than failing the batch.
 */
export async function resolveAncestorCommits(
  currentHead: string,
  candidateCommitShas: string[],
  cwd: string
): Promise<string[]> {
  if (candidateCommitShas.length === 0) return [];

  const results = await Promise.all(
    candidateCommitShas.map(async (candidateSha) => {
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
        return null;
      }
    })
  );

  return results.filter((sha): sha is string => sha !== null);
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
  const currentHead = await getCurrentHead(cwd);
  if (currentHead === null) return null;

  if (candidateCommitShas.length === 0) return [];

  return resolveAncestorCommits(currentHead, candidateCommitShas, cwd);
}
