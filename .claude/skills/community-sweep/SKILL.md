---
name: community-sweep
description: Land community pull requests as the contributor and answer community issues on thedotmack/claude-mem. Takes stock of every open non-maintainer PR and issue, triages each against the owner's merge philosophy and the cmem.ai hosted-service boundary, finishes somewhat-aligned PRs on the contributor's own branch, squash-merges so the contributor stays the commit author on main, thanks them by name, closes fixed issues with credit to reporter and fixer, keeps the private ledger and contributor roster current, and reports what needs the owner. Use when asked to "go through the PRs", "merge contributor PRs", "help contributors with their PRs", "land the new community PRs", "triage new issues and PRs", "run the community sweep", "keep the momentum", or "grow the community".
---

# Community Sweep

Grow the claude-mem community by merging people in. Every valuable contribution lands **as the contributor**: their PR, their name as the commit author on `main`. A PR that is only partly right gets finished on their branch instead of rejected. Issues get the same treatment, so the person who reported a bug and the person who fixed it both hear about it, by name.

This is the protocol from the 2026-09-30 open-PR merge sweep, which took 257 open PRs to 46 and merged 143 contributor PRs from 87 authors with their authorship intact. It is written down so every new batch of PRs and issues gets handled the same way.

## The owner's merge philosophy

1. **Merge as many valuable contributions as possible.** This is looser than the Merge Clinic (#3372, `docs/merge-rubric.md`). Opt-in features are welcome, as are extensibility (providers, hosts, hooks, settings knobs) and anything that cuts token spend (bounding, batching, dedup, filtering).
2. **Finish, don't reject.** If the intent is right but the fix is partial or buggy, finish it on the contributor's branch, or land only its additive piece (a trim). Either way the credit stays with them.
3. **No band-aids, but no bleeding.** A fix walks the issue down to its root cause. A band-aid that stops active user harm ships only with a written post-plan: the root-cause follow-up, specified well enough to execute.
4. **The contributor is the author.** A merge that puts the maintainer's name on someone else's work is a failed merge.
5. **Respect the hosted-service boundary** (step 2). Anything that touches cmem.ai cloud sync or the gateway's sign-in and trial path goes to the owner.
6. **Security and privacy regressions block a merge.** That covers secrets in logs, data sent to third parties, and injection.

Count humans, not tools. A PR written with Claude, Codex, Cursor or Copilot is credited to the human who opened it. Bot PRs (PostHog, Copilot agent, Dependabot) land on merit, but they never go on the roster.

## Private state: never commit, never upload

Run state lives in the main checkout's gitignored `.scratch/`, so every worktree shares it:

```bash
MAIN_CHECKOUT="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
STATE="$MAIN_CHECKOUT/.scratch/community"
RUN_ID="CS-$(date -u +%F)"; RUN="$STATE/runs/$RUN_ID"; mkdir -p "$RUN"
```

| File | What it is |
|---|---|
| `$STATE/ledger.tsv` | One row per outcome. The last row for a number wins. It is the source of truth for what already happened; never redo a number it shows as done. |
| `$STATE/ROSTER.md` | Every human with a merged PR or a co-author credit, kept for the owner's outreach. It holds emails, so never commit it, upload it, or quote it. |
| `$RUN/` | This run's snapshots, triage reports, test baseline and `REPORT.md`. |

To append a ledger row (tab-separated; PR and issue numbers share one namespace):

```bash
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" <number> "$RUN_ID" <action> <merge_sha|-> <author> <coauthors|-> "<one-line note>" >> "$STATE/ledger.tsv"
```

- **Actions for PRs:** `merged`, `closed`, `held`, `blocked`, `skipped`.
- **Actions for issues:** `issue-closed`, `issue-answered`, `issue-routed`, `issue-held`.
- **New ledger:** if `ledger.tsv` doesn't exist, create it with the header `ts pr phase action merge_sha pr_author coauthors note` (tab-separated).

## 1. Take stock

```bash
gh pr list --repo thedotmack/claude-mem --state open --limit 500 --json number,title,author,isDraft,createdAt,updatedAt,mergeable,mergeStateStatus,maintainerCanModify,headRefName,headRepositoryOwner,baseRefName,additions,deletions > "$RUN/open-prs.json"
gh issue list --repo thedotmack/claude-mem --state open --limit 500 --json number,title,author,createdAt,updatedAt,labels,comments > "$RUN/open-issues.json"
```

Put every open PR in exactly one bucket, using its last ledger row:

| Bucket | Rule | What to do |
|---|---|---|
| Maintainer | author is `thedotmack` | Never touch it. |
| Held | last row is `held` | Never comment, push, close or approve CI. Report any new activity to the owner. |
| Blocked | last row is `blocked` | Re-triage only if the author pushed or replied after that row. |
| Done | last row is `merged` or `closed` | It shouldn't be open, so find out why. |
| New | no row | Triage it (step 2). |

For issues, skip the maintainer-authored ones: the `[plan-NN]` masters and the Merge Clinic. Triage community issues created or updated since the last run (the ledger's latest `ts`). On a first run, triage all of them.

**Test baseline.** Take it once per run, before landing anything. Use a clean `origin/main` worktree and the same Bun as CI (`bun-version: latest`), because an older local Bun can fail subprocess tests that CI passes. If local Bun is behind, run every suite in the run (baseline, per-PR and gate) as `npx -y bun@<latest> test …`. `npm view bun version` gives the latest version.

```bash
npm install --no-audit --no-fund && npm run build
env -u CLAUDE_MEM_LLM_TIMEOUT_MS bun test tests 2>&1 | tee "$RUN/baseline-suite.log"
grep -E '^\(fail\)' "$RUN/baseline-suite.log" | sort -u > "$RUN/baseline-failures.txt"
```

## 2. Triage each new PR (read-only)

```bash
gh pr view <N> --repo thedotmack/claude-mem --json title,body,author,headRefOid,headRefName,headRepositoryOwner,maintainerCanModify,mergeable,mergeStateStatus,isDraft,closingIssuesReferences,commits,files
gh pr diff <N> --repo thedotmack/claude-mem
gh pr checks <N> --repo thedotmack/claude-mem
gh api repos/thedotmack/claude-mem/pulls/<N>/comments --paginate   # inline review findings (Greptile, Cursor Bugbot, CodeRabbit)
gh api repos/thedotmack/claude-mem/issues/<N>/comments --paginate  # the conversation
```

Read main's code with `git show origin/main:<path>`. Leave generated bundles out of diff sizing (the list is in step 3); they're noise and get stripped at merge. If the PR maps to a plan master (`plans/NN-*.md`), read that section first. A PR that implements the master's intended fix is a strong candidate. A PR that contradicts the master needs a reason.

**Evidence per PR:**
- **Facts:** author, draft, `mergeable`, `maintainerCanModify`, CI state, non-bundle diff size, linked issues.
- **CI:** a failure that also shows up on main's recent runs (`gh run list --repo thedotmack/claude-mem --branch main --limit 5`) is not the PR's.
- **Root cause and change:** the root cause in one or two lines, and what the PR changes.
- **Still needed on main?** Cite `file:line` or a commit as evidence.
- **Review findings:** unresolved bot and maintainer findings (P0/P1/P2), and whether the contributor addressed them.
- **Quality:** tests added, and whether it's a band-aid.
- **Boundary flags.**
- **Overlaps:** other PRs on the same area, including maintainer PRs.
- **Verdict and confidence.**

**Verdicts (exactly one per PR):**

| Verdict | Meaning | What happens |
|---|---|---|
| `MERGE` | Correct, complete and aligned; mergeable now or after a mechanical merge of main | Land it (step 3). |
| `MERGE+POSTPLAN` | Stops real bleeding but isn't the root fix | Land it and write the post-plan into the report. |
| `REWORK` | Right intent, but incomplete, buggy or a band-aid | A numbered gap list is the spec. Finish it on their branch (step 4), then land it. |
| `TRIM` | Only part of it is additive | Keep that part on their branch and land it as their PR. Say what was dropped and why. |
| `CONSOLIDATE→#M` | Overlaps #M | Prefer landing the additive piece as its own trimmed PR. Otherwise fold it into #M with credit (step 4). |
| `SUPERSEDED` | `main` already fixes it | Cite the commit or `file:line`. Close with precise credit. |
| `HOLD` | Crosses the hosted-service boundary, or needs a product call | Leave it untouched for the owner to decide. |
| `DECLINE` | Wrong direction, harmful, or not worth finishing | Close with thanks and the reason. |
| `SPAM` / `EMPTY` | Unrelated to claude-mem, or no code. This includes rewrites of SECURITY.md, README or LICENSE with someone else's details, and CLAUDE.md or AGENTS.md replaced with a tool's generated output | Close with one neutral line. |

### The hosted-service boundary (verdict `HOLD`)

claude-mem is open source. cmem.ai is the hosted service: cloud sync, plus the inference gateway with its sign-in and trial. Leave a PR for the owner if it does any of the following:

1. Changes the installer's provider screen or defaults, exempts a provider from sign-in, or changes the cmem.ai sign-in, trial or activation steps (`src/npx-cli/commands/install.ts`, `src/npx-cli/cmem-memory-credentials.ts`, `src/npx-cli/cmem-pro-costs.ts`).
2. Lets the cmem.ai memory key reach any host but the gateway, or loosens gateway detection (`src/shared/cmem-gateway.ts`, the `keysForEndpoint` lock).
3. Routes gateway quota or key failures to another provider before the gateway's own trial-expiry fallback runs (`src/services/worker/provider-dispatch.ts`).
4. Removes, hides or defaults off a cmem.ai notice or link: installer next steps, the session-start line, the context banner, the viewer header, or renewal notices. Their copy lives in `src/shared/pro-promo.ts`.
5. Adds another sync, backup or remote-memory destination, or a turnkey hosted port of the server runtime.
6. Changes cloud-sync semantics: data loss, a weaker ack contract, or sync without entitlement (`src/services/sync/`, `services/sync-api/`).
7. Adds a new default-on path that spends model tokens, such as extra observer calls, backfills or new ingestion. The same feature as an opt-in that defaults off is fine.

These are not conflicts, so judge them on merit: opt-in bring-your-own providers, hosts and knobs that leave the gateway path first; token-spend optimizations; correct fixes to our own sync client; IDE and host integrations; and fixes to the self-hosted server runtime. A new provider preset never goes above cmem.ai and never edits the installer, sign-in or cost files. If you're unsure, use `HOLD` with one line saying why. Don't guess.

## 3. Land as the contributor

Work in your own worktree, never the user's current one: an Agent with `isolation: "worktree"`, or `git worktree add --detach "$MAIN_CHECKOUT/.claude/worktrees/community-<name>" origin/main`. Then run `npm install --no-audit --no-fund`.

```bash
gh pr view <N> --repo thedotmack/claude-mem --json state,isDraft,mergeable,baseRefName,headRefName,maintainerCanModify   # merged or closed meanwhile? ledger it `skipped`
gh pr edit <N> --repo thedotmack/claude-mem --base main          # only if the base isn't main
gh pr checkout <N> --repo thedotmack/claude-mem --branch pr-<N>  # sets the push remote to their fork
git merge --no-edit origin/main                                   # a merge commit; never rebase their commits
```

**Generated bundles never land from a PR**; they're rebuilt at release. The generated set is:
- `plugin/scripts/{worker-service,server-service,mcp-server,context-generator,transcript-watcher}.cjs` and their `.map` files;
- `plugin/sqlite/**`;
- `plugin/ui/viewer-bundle.js`;
- `plugin/package.json`.

If the PR changed any of them, restore them with `git checkout origin/main -- <paths>` (or `git rm` any the PR added) and commit `chore: drop generated bundles (rebuilt at release)`. Hand-written files under `plugin/` stay: `plugin/scripts/{bun-runner.js,statusline-counts.js,version-check.js,worker-wrapper.cjs}`, hooks, skills, modes, manifests and UI assets.

**Apply the verdict.** `MERGE` needs nothing more. For `REWORK` and `TRIM`, follow the gap list (step 4). Our commits use conventional messages and end with the attribution trailers your session specifies.

**Verify on the exact head you will merge:**
1. Run `npm run typecheck`.
2. Commit everything first. Then run `npm run build` (the bundle-size guardrail) and `git checkout -- plugin/`, so build output is never committed.
3. Run the PR's targeted tests.
4. For any non-trivial change, run `env -u CLAUDE_MEM_LLM_TIMEOUT_MS bun test tests` and compare it with `$RUN/baseline-failures.txt`. For a failure that isn't in the baseline, re-run that file alone first. If it passes alone and in CI, it was load from parallel suites. If it still fails, it's the PR's to fix.
5. If `openclaw/` is touched, run `bun test openclaw`.
6. A PR that adds a SessionStore migration takes the next free schema version on main at merge time. Two PRs raced for one version during the sweep.

**Push to their branch**, which is needed only if you merged main with conflicts or added commits. Never force-push.

```bash
remote=$(git config branch.pr-<N>.pushRemote || git config branch.pr-<N>.remote)
head=$(git config branch.pr-<N>.merge); head=${head#refs/heads/}
git push "$remote" "HEAD:$head"    # a bare `git push` is refused: the local name pr-<N> differs from their branch
```

If the push is rejected as non-fast-forward, they pushed meanwhile. Run `git pull --no-rebase "$remote" "$head"`, re-verify and push again. If their new head already does what you did, drop yours.

**CI.**
- First-time contributors' runs sit in `action_required`. Read the whole diff for anything that executes in CI (workflows, package scripts, postinstall, tests that shell out). Then approve the `CI` and `Windows` runs for the PR head. Look them up by head SHA: `gh run list --branch` misses fork PRs.

  ```bash
  sha=$(gh pr view <N> --repo thedotmack/claude-mem --json headRefOid --jq .headRefOid)
  gh api "repos/thedotmack/claude-mem/actions/runs?head_sha=$sha" --jq '.workflow_runs[] | "\(.id) \(.name) \(.conclusion)"'
  gh api -X POST repos/thedotmack/claude-mem/actions/runs/<id>/approve
  ```

- Never approve CI for `SPAM`, `DECLINE` or `HOLD`.
- Never approve the "Claude Code" runs. Those are the `@claude` responder (`.github/workflows/claude.yml`); they carry a secret and aren't needed to merge.
- Watch with `gh pr checks <N> --repo thedotmack/claude-mem --watch --interval 60`.
- Rerun a flake once (`gh run rerun <id> --failed`). Fix a real failure.
- If a draft is ready by your verdict, run `gh pr ready <N>`.

**Merge one PR at a time:**
1. Run `git fetch origin`.
2. If main moved, do a trial `git merge --no-edit origin/main` locally, then run typecheck and the PR's targeted tests again. Push only if the merge needed a conflict resolution.
3. Merge:

   ```bash
   gh pr merge <N> --repo thedotmack/claude-mem --squash        # NEVER --admin, --body or --author-email
   git fetch origin && git log -1 --format='%H | %an <%ae> | %s' origin/main
   ```

   Add `--subject "<type>(<scope>): <summary> (#<N>)"` only when the PR title would mislead, for example on a trimmed or re-scoped PR.

The author on main must be the contributor. If it isn't, stop and tell the owner. Then comment (step 6), ledger the merge with the full SHA, and close any issue the PR fixed that GitHub didn't auto-close (step 5).

## 4. Help the PRs that aren't ready

- **Rework on their branch.** The gap list is the spec. Add tests that fail before the fix and pass after it. When you push, comment on the PR with 1–3 bullets on what changed and why ("merged main; moved X into Y because Z; added a test for W"). If the rework turns out to need a redesign, don't half-land it. Post a friendly review comment with the concrete plan, ledger it `blocked`, and move on.
- **No edit access** (`maintainerCanModify=false`). Post a review comment with the exact changes needed, ask them to enable "Allow edits by maintainers", and ledger it `blocked`.
- **Rehost.** Only when there's no edit access and the PR can't merge as-is: cherry-pick their commits with `git cherry-pick -x` onto a branch in `thedotmack/claude-mem` (that keeps their authorship). Open `<title> (rehost #<N>)` crediting `@author`, land it with `gh pr merge --rebase`, and close the original with thanks and a link.
- **Fold another contributor's work in.**
  - Prefer landing a duplicate as its own trimmed PR. Close a PR only when nothing additive is left.
  - When you do fold, run `git fetch origin pull/<M>/head:pr-<M>` and `git cherry-pick -x <sha>`. That keeps their authorship, and GitHub adds `Co-authored-by` to the squash.
  - For a partial adoption, add `Co-authored-by: <Name> <email from their commit>` to our commit message.
- **Blocked PRs whose author came back.** Re-triage them from scratch on the new head.

## 5. Issues

```bash
gh issue view <N> --repo thedotmack/claude-mem --json title,body,author,comments,labels,createdAt
gh pr list --repo thedotmack/claude-mem --state all --search "<N>" --json number,title,state,author,mergedAt
git log origin/main --oneline --grep="#<N>\b"
```

| Verdict | Test | Action |
|---|---|---|
| `FIXED` | A merged PR fixes it. Prove it on main with `file:line`. | Comment, then `gh issue close <N> --reason completed`. Comment even when a merge already auto-closed it, because the auto-close says nothing. |
| `HAS-PR` | An open PR addresses it. | Triage and land that PR this run, then close the issue as `FIXED`. If the PR can't land yet, comment once linking it so the reporter can try it. |
| `PLAN` | It's a symptom of an open plan master. | Route it with the `oh-my-issues` skill, Mode 2: a Round-N comment on the master, then the standard redirect. |
| `CONFIRMED` | A real bug on main with no PR. | Reply with the root cause (`file:line` on main) and invite a PR ("happy to help land it"). Alternatively, fix it in our own PR that credits the reporter. |
| `NEEDS-INFO` | Can't be reproduced or located from the report. | Ask once for exactly what's missing: version, OS, the log lines. |
| `DUPLICATE→#M` | The same defect as #M. | Comment "Duplicate of #M", then close it as not planned. |
| `OWNER` | Billing, cmem.ai, the roadmap, or a product call. | No comment. List it for the owner. |
| `SPAM` | Unrelated to claude-mem. | Close with one neutral line. |

Before posting, reconcile the claims. If a PR's triage and an issue's triage disagree about what fixes an issue (for example `project=` versus `projects=`), read main yourself. Never credit the wrong person.

Release status matters to reporters. `git tag --contains <sha>` names the first release with the fix. If no tag contains it, say "it's on main and ships in the next release". Never promise a date.

## 6. Comments

Make them warm, specific and short: name the person, and say what changed for users in plain words. Don't use marketing language, and never mention any reward, outreach or business reasoning. These are real examples:

- **Merge:** "Merged, thank you @Screddyice! Codex hook events now keep `tool_use_id`, `agent_id` and `agent_type`, so tool calls dedupe properly and the subagent capture settings apply to Codex as well. I merged main and left the README paragraph out; the README stays a user-facing overview."
  - If we pushed, say what we changed and why.
  - Where it's true, praise something concrete: tests that fail on main, live measurements, an upfront disclosure.
- **Rework pushed:** what changed and why, in 1–3 bullets.
- **Close (superseded, consolidated or declined):** thank them and link what landed. State the credit precisely ("your commits are included as co-author on #M", or "main already fixed this in `<sha>` (#X)"), and invite the next contribution.
- **Issue fixed:** "Fixed by #4162 (6cec29395): the SDK child now keeps `CLAUDE_CODE_TMPDIR`, so pointing it at a private directory works for the Observer too. Thanks @reporter for the report and @fixer for the fix."
- **Spam:** "Closing — this doesn't relate to claude-mem."
- **Held PRs and `OWNER` issues:** no comment. The owner handles them.

## 7. Record and report

1. **Ledger.** Add a row for every merge, close, hold, block, skip and issue action, as it happens.
2. **Roster.** Add new merged human authors to `$STATE/ROSTER.md`: login, public name (the squash commit's author), PRs and short SHAs. Add co-author-only credits from `Co-authored-by` trailers, then recount the totals. One person can have two git identities; map them to one login.
3. **Gate.** After the run's last merge, verify in a fresh `origin/main` worktree:
   - typecheck, build, and the full suite against the baseline;
   - `git diff <run-start>..origin/main --stat -- 'plugin/scripts/*.cjs' plugin/sqlite plugin/ui/viewer-bundle.js CHANGELOG.md` is empty;
   - `git log <run-start>..origin/main --format='%an' | sort | uniq -c` shows contributors, not only the maintainer.

   Fix any regression forward in our own PR, test-first.
4. **Report.** Write `$RUN/REPORT.md`, then post a short version in chat:
   - a table of outcomes `| # | author | verdict | outcome | merge SHA | author on main | note |`;
   - the issue actions;
   - **decisions for the owner:** every `HOLD`/`OWNER` item with one line on why, plus new activity on held PRs;
   - post-plans owed, follow-ups, incidents;
   - the roster delta (new authors, new PRs, totals).

## Scaling up (more than about 8 PRs)

- **Triage in parallel** with read-only subagents, about 5 PRs each, grouped by area. Give each one step 2 of this skill and its PR list. Its only writable file is `$RUN/triage/<group>.md`, and it returns a compact table: `| # | author | verdict | conf | one-line reason | canModify | mergeable | CI |`.
- **Land in parallel** with executor subagents (`isolation: "worktree"`), one per group. Merges into main stay serialized by a lock:

  ```bash
  until mkdir "$STATE/merge.lock" 2>/dev/null; do sleep 20; done
  echo "<executor> #<N> $(date -u +%FT%TZ)" > "$STATE/merge.lock/owner"
  # … fetch, trial merge, gh pr merge, confirm author …
  rm -f "$STATE/merge.lock/owner"; rmdir "$STATE/merge.lock"
  ```

  Hold the lock for 5 minutes at most. Never break someone else's lock; if it has been held for more than 20 minutes, tell the orchestrator.
- **GitHub's API budget is shared:** 5,000 requests an hour each for REST and GraphQL. Poll CI no faster than every 60 seconds, batch fields into one `--json` call, and on a rate-limit error wait for the reset (`gh api rate_limit`) instead of retrying.
- **Keep helper scripts in each executor's own subdirectory.** During the sweep, shared helpers at a common root were overwritten by another executor.
- **Stop cleanly on a spend or usage limit:** release the lock, stop making changes, and report what is mid-flight.
- **Watch the disk:** each worktree is about 1 GB of `node_modules`. Remove run worktrees when the run ends.

## Never

- Touch a maintainer (`thedotmack`) PR, or comment on, push to, close, or approve CI for a held PR.
- Force-push, rebase, or rewrite a contributor's commits.
- Override the squash author or body: no `--admin`, `--body` or `--author-email`.
- Commit generated bundles or `CHANGELOG.md`, bump the version, or publish. Releases are a separate owner step.
- Merge a band-aid without a written post-plan.
- Approve CI for a diff you haven't read.
- Close a PR without saying exactly how its author is credited.
- Mention any contributor reward or outreach in public, or quote the roster.
