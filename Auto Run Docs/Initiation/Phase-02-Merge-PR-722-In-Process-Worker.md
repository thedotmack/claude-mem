# Phase 02: Resolve Conflicts and Merge PR #722 - In-Process Worker Architecture

PR #722 replaces spawn-based worker startup with in-process architecture. Hook processes become the worker when port 37777 is free, eliminating Windows spawn issues. This PR has merge conflicts that must be resolved before merging.

## Tasks

- [ ] Checkout PR #722 and assess conflict scope:
  - `git fetch origin bugfix/claude-md-index`
  - `git checkout bugfix/claude-md-index`
  - `git merge main` to see conflicts
  - List all conflicting files

- [ ] Resolve merge conflicts in each affected file:
  - For each conflict, understand both sides:
    - Main branch changes (likely from PR #856 merge)
    - PR #722 changes (in-process worker architecture)
  - Preserve both sets of functionality where possible
  - Key files likely affected:
    - `src/services/worker-service.ts`
    - `src/services/queue/SessionQueueProcessor.ts`
    - `plugin/hooks/hooks.json`

- [ ] Run tests after conflict resolution:
  - `npm test`
  - All tests must pass (761+ expected)
  - Report any failures with details

- [ ] Run build after conflict resolution:
  - `npm run build`
  - Verify no TypeScript errors
  - Verify all artifacts are generated

- [ ] Code review the in-process worker changes:
  - Verify `worker-service.ts` hook case starts WorkerService in-process when port free
  - Verify `hook-command.ts` has `skipExit` option
  - Verify `hooks.json` uses single chained command
  - Verify `worker-utils.ts` `ensureWorkerRunning()` returns boolean

- [ ] Commit conflict resolution and push:
  - `git add .`
  - `git commit -m "chore: resolve merge conflicts with main"`
  - `git push origin bugfix/claude-md-index`

- [ ] Merge PR #722 to main:
  - Wait for CI to pass after push
  - `gh pr merge 722 --squash --delete-branch`
  - Verify merge succeeded

- [ ] Run post-merge verification:
  - `git checkout main && git pull origin main`
  - `npm test` to confirm tests pass on main
  - `npm run build` to confirm build works
