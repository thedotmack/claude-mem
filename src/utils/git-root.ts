/**
 * Git Root Detection Utility
 *
 * Walks up the directory tree from a given path to find the nearest
 * git repository root (directory containing a .git entry).
 */
import { statSync } from 'fs';
import path from 'path';

/**
 * Find the git repository root by walking up the directory tree.
 *
 * @param cwd - Starting directory (absolute path)
 * @returns Absolute path to the git root, or null if not in a git repo
 */
export function findGitRoot(cwd: string | null | undefined): string | null {
  if (!cwd || cwd.trim() === '') return null;

  let current = path.resolve(cwd);

  while (true) {
    const gitPath = path.join(current, '.git');
    try {
      statSync(gitPath);
      // .git exists (file or directory) - this is the repo root
      return current;
    } catch {
      // .git not found here, walk up
    }

    const parent = path.dirname(current);
    // Reached filesystem root with no .git found
    if (parent === current) return null;
    current = parent;
  }
}
