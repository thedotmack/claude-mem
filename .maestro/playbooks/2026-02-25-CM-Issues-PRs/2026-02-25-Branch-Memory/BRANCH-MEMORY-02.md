# Phase 02: Ancestor Resolution — Git Merge-Base Utility

This phase creates the core utility that powers branch isolation. Given a set of commit SHAs from stored observations, it uses `git merge-base --is-ancestor` to determine which are ancestors of the current HEAD. This enables the "like how git works" visibility model — observations from merged branches become visible automatically, while sibling branch work stays invisible. Both the context builder (Phase 03) and search system (Phase 04) depend on this utility.

## Tasks

- [x] Create git ancestry resolution utility:
  - Create new file `src/services/integrations/git-ancestry.ts`
  - Export `async function getCurrentHead(cwd: string): Promise<string | null>` — runs `git rev-parse HEAD`, returns full 40-char SHA or null on failure. Use the same spawn pattern established in `src/services/integrations/git-branch.ts` from Phase 01
  - Export `async function resolveAncestorCommits(currentHead: string, candidateCommitShas: string[], cwd: string): Promise<string[]>`
  - For each candidate SHA, run `git merge-base --is-ancestor <candidate> <currentHead>` — this command exits with code 0 if the candidate IS an ancestor, non-zero if not
  - Use `Promise.all` to run checks concurrently for performance (each git merge-base call is fast and independent)
  - Return the subset of `candidateCommitShas` that are ancestors of `currentHead`
  - Handle errors gracefully per-SHA: if `git merge-base` fails for a specific SHA (e.g., SHA no longer exists after garbage collection), exclude that SHA from results rather than failing the entire batch
  - If `candidateCommitShas` is empty, return empty array immediately (no git calls needed)

- [x] Create observation commit SHA query helper:
  - In `src/services/sqlite/observations/get.ts`, add a new exported function: `getUniqueCommitShasForProject(db: Database, project: string): string[]`
  - SQL: `SELECT DISTINCT commit_sha FROM observations WHERE project = ? AND commit_sha IS NOT NULL`
  - Return a flat array of commit SHA strings
  - This function will be called by both the context builder and search manager to get candidate SHAs before ancestry resolution

- [x] Create a combined branch resolution function:
  - In `src/services/integrations/git-ancestry.ts`, add: `async function resolveVisibleCommitShas(candidateCommitShas: string[], cwd: string): Promise<string[] | null>`
  - Get current HEAD via `getCurrentHead(cwd)` — if null (not a git repo), return `null` (the null convention means "no filtering, show everything")
  - If no candidates, return empty array
  - Run `resolveAncestorCommits(currentHead, candidateCommitShas, cwd)` to filter
  - Return the visible SHA list
  - This `null = unfiltered` convention lets callers distinguish "not in a git repo" (show all) from "in a git repo but no ancestors found" (show nothing from branches)

- [x] Write tests for the ancestry resolution utility:
  - Create test file `tests/git-ancestry.test.ts`
  - Test `getCurrentHead`: should return a 40-character hex string when run in this repo's directory
  - Test `resolveAncestorCommits` with this repo: the current HEAD's own SHA should be considered an ancestor of itself (git merge-base --is-ancestor returns 0 for same commit). Find an old commit SHA from `git log` to verify it's an ancestor of HEAD
  - Test with a fabricated non-existent SHA (e.g., `'0000000000000000000000000000000000000000'`) — should be excluded gracefully, not throw
  - Test `resolveVisibleCommitShas` with null-safety: call with a non-git directory like `/tmp` — should return `null`
  - Test empty candidates array: should return empty array without making git calls

- [x] Run tests and fix any failures:
  - Run the test suite targeting `tests/git-ancestry.test.ts`
  - Fix any issues that arise from the tests
  - Ensure the utility handles all edge cases cleanly
