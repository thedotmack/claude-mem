# Phase 04: Resolve Conflicts and Merge PR #657 - CLI Generate/Clean Commands

PR #657 adds `claude-mem generate` and `claude-mem clean` CLI commands with cross-platform support. It also fixes validation gaps that caused deleted folders to be recreated from stale DB records, and adds automatic shell alias installation. This PR has merge conflicts.

## Tasks

- [ ] Checkout PR #657 and assess conflict scope:
  - `git fetch origin bugfix/jan10-bug-2`
  - `git checkout bugfix/jan10-bug-2`
  - `git merge main` to see conflicts
  - List all conflicting files

- [ ] Resolve merge conflicts:
  - Key files likely affected:
    - `src/services/worker-service.ts` (generate/clean command cases)
    - `plugin/scripts/smart-install.js` (CLI installation)
  - Preserve all existing functionality while adding CLI commands

- [ ] Run tests after conflict resolution:
  - `npm test`
  - All tests must pass
  - Report any failures with details

- [ ] Run build after conflict resolution:
  - `npm run build`
  - Verify no TypeScript errors

- [ ] Test the CLI commands manually:
  - `bun plugin/scripts/worker-service.cjs generate --dry-run`
  - `bun plugin/scripts/worker-service.cjs clean --dry-run`
  - Both should exit with code 0
  - Review output for sensible behavior

- [ ] Code review the CLI implementation:
  - Verify `src/cli/claude-md-commands.ts` exports generate/clean functions
  - Verify validation fixes in `regenerateFolder()` (folder existence check)
  - Verify path traversal prevention
  - Verify cross-platform path handling (`toDbPath()`, `toFsPath()`)

- [ ] Commit conflict resolution and push:
  - `git add .`
  - `git commit -m "chore: resolve merge conflicts with main"`
  - `git push origin bugfix/jan10-bug-2`

- [ ] Merge PR #657 to main:
  - Wait for CI to pass after push
  - `gh pr merge 657 --squash --delete-branch`
  - Verify merge succeeded

- [ ] Run post-merge verification:
  - `git checkout main && git pull origin main`
  - `npm test` to confirm tests pass
  - `npm run build` to confirm build works
  - Verify CLI commands still work: `bun plugin/scripts/worker-service.cjs generate --dry-run`
