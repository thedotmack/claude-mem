# Phase 03: Resolve Conflicts and Merge PR #700 - Windows Terminal Popup Fix

PR #700 eliminates Windows Terminal popups by removing spawn-based daemon startup. The worker `start` command now becomes daemon directly instead of spawning a child process. This PR has merge conflicts and may have significant overlap with PR #722 (in-process worker).

## Tasks

- [ ] Checkout PR #700 and assess conflict scope:
  - `git fetch origin bugfix/spawners`
  - `git checkout bugfix/spawners`
  - `git merge main` to see conflicts
  - List all conflicting files
  - Assess if changes overlap significantly with already-merged PR #722

- [ ] Evaluate if PR #700 is still needed:
  - PR #722 (in-process worker) may have already addressed the same Windows spawn issues
  - Compare the changes in both PRs
  - If #722 fully supersedes #700, close #700 with explanation
  - Otherwise proceed with conflict resolution

- [ ] If proceeding, resolve merge conflicts:
  - Key files likely affected:
    - `src/services/worker-service.ts` (daemon startup changes)
    - `src/services/sync/ChromaSync.ts` (windowsHide removal)
    - `plugin/hooks/hooks.json` (command changes)
  - Preserve functionality from main while adding non-spawn daemon behavior

- [ ] Run tests after conflict resolution:
  - `npm test`
  - All tests must pass
  - Report any failures with details

- [ ] Run build after conflict resolution:
  - `npm run build`
  - Verify no TypeScript errors

- [ ] Code review the Windows-specific changes:
  - Verify worker `start` command becomes daemon directly (no child spawn)
  - Verify `restart` command removal (users do stop then start)
  - Verify windowsHide removal from ChromaSync

- [ ] Commit conflict resolution and push:
  - `git add .`
  - `git commit -m "chore: resolve merge conflicts with main"`
  - `git push origin bugfix/spawners`

- [ ] Merge PR #700 to main:
  - Wait for CI to pass after push
  - `gh pr merge 700 --squash --delete-branch`
  - Verify merge succeeded

- [ ] Run post-merge verification:
  - `git checkout main && git pull origin main`
  - `npm test` to confirm tests pass
  - `npm run build` to confirm build works
