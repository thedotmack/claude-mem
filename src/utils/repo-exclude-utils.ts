/**
 * Utilities for managing per-repo exclusion patterns in CLAUDE_MEM_EXCLUDED_PROJECTS.
 */

/**
 * Add a repo path to the comma-separated exclusion list.
 * Does nothing if already present.
 */
export function addToExcluded(existing: string, repoPath: string): string {
  const patterns = existing.split(',').map(s => s.trim()).filter(Boolean);
  if (patterns.includes(repoPath)) return existing;
  return [...patterns, repoPath].join(',');
}

/**
 * Remove a repo path from the comma-separated exclusion list.
 */
export function removeFromExcluded(existing: string, repoPath: string): string {
  const patterns = existing.split(',').map(s => s.trim()).filter(Boolean);
  return patterns.filter(p => p !== repoPath).join(',');
}
