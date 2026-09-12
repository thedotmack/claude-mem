# Unbundle report: PR #3614

## Bundle disposition

PR [#3614](https://github.com/thedotmack/claude-mem/pull/3614) was commented on and closed because its bundle conflicts too widely to merge safely. The comment is [here](https://github.com/thedotmack/claude-mem/pull/3614#issuecomment-5648004702) and was signed `— Prioritizer (seat for Alex, cmem.ai)`.

The eight source PRs were: #3146, #3519, #3460, #2985, #3291, #3302, #3465, and #3405.

The merge-singles report showed that none of these sources duplicates a PR merged today. No source PR was closed as a duplicate in this run.

Here, the current GitHub `main` branch (`origin/main`) is the branch that PR changes would be updated against. `npm run typecheck` is the TypeScript compile check.

## Source PR results

| PR | Plan master | Outcome | Test commands and result |
| --- | --- | --- | --- |
| #3146 | #3604, plan-16 | skipped (closed and replaced by commit `38fc189b5`) | `npm test` — not run because the PR was already closed. `npm run typecheck` — not run because the PR was already closed. |
| #3519 | #3605, plan-17 | skipped (the conflict needs a design choice: #3519 runs a login shell to rebuild the command search path when either Node or Bun is missing, while #3453 always adds common Node and tool locations to that path) | `npm test` — not run because replaying the PR's changes onto the current main branch did not complete. `npm run typecheck` — not run because replaying the PR's changes onto the current main branch did not complete. |
| #3460 | #3606, plan-18 | skipped (all three changed files conflict with #3998's newer network-failure handling. #3998 covers much but does not recognize #3460's exact `API Error: Connection closed mid-response. The response above may be incomplete.` message, so combining them needs a specific rule for it and a decision about what the worker does afterward) | `npm test` — not run because replaying the PR's changes onto the current main branch did not complete. `npm run typecheck` — not run because replaying the PR's changes onto the current main branch did not complete. |
| #2985 | #3611, plan-23 | skipped (closed by its author on July 3) | `npm test` — not run because the PR was already closed. `npm run typecheck` — not run because the PR was already closed. |
| #3291 | #3607, plan-19 | skipped (the required full test suite did not pass, so it was not merged; the sole failure is known to happen on clean main already and was not caused by #3291) | `npm run typecheck` — passed. After `npm run build`, `npm test` failed only `field deadline cancels real OpenRouter fetch and prevents retries` (expected `disconnected` to be `true`, got `false`). The same failure reproduces identically on clean `origin/main` after the same build, and #3291 does not change the files involved. |
| #3302 | #3602, plan-14; also plan-22 | skipped (closed because Windows Megafix #3661 replaces it) | `npm test` — not run because the PR was already closed. `npm run typecheck` — not run because the PR was already closed. |
| #3465 | #3602, plan-14 | skipped (closed because Windows Megafix #3661 replaces it) | `npm test` — not run because the PR was already closed. `npm run typecheck` — not run because the PR was already closed. |
| #3405 | #3603, plan-15; also plan-14 | skipped (closed by author @Zuuphlas on August 25; there is no open source branch to update against the current main branch) | `npm test` — not run because the PR was already closed. `npm run typecheck` — not run because the PR was already closed. |

## Final state

No source PR was merged. No protected collision PR was touched during this unbundle run: #3564, #3403, #3416, #3408, #3309, #3410, or #3310. The `work/unbundle` worktree was reset to current `origin/main` at `07ba05ae64ef732edfcf4cfb3a73e522a2153892`.
