# merge-singles — oh-my-issues merge-now singles

Run date: 2026-09-12. Worktree `work/merge-singles` off `origin/main` at
`6c1ecb54a`. All seven PRs on the triage list merged; none skipped.

Source of the list: `../oh-my-issues/.agent-jobs/oh-my-issues.report.md` and
the per-PR notes in `../oh-my-issues/.agent-jobs/pr-results/batch-0*.md`.

## Baseline before any merge

Dependencies installed with `bun install` (657 packages, no node_modules in
the fresh worktree). On clean `origin/main` @ `6c1ecb54a`:

| check | command | result |
|---|---|---|
| tests | `bun test tests` | 3716 pass, 28 skip, **2 fail** |
| typecheck (root) | `tsc --noEmit` | clean |
| typecheck (viewer) | `tsc --noEmit -p src/ui/viewer/tsconfig.json` | clean |
| lint | `npm run lint:hook-io`, `npm run lint:spawn-env` | OK |

The two failures are **pre-existing on main** and unrelated to every PR below.
They reproduce identically on every branch tested:

- `tests/worker/field-deadline-wire.test.ts:43` — "field deadline cancels real
  OpenRouter fetch and prevents retries". Expects `disconnected === true`;
  needs a real outbound OpenRouter fetch.
- `tests/infrastructure/plugin-distribution.test.ts:376` — "npm tarball
  includes generated runtime entries". Expects `dist/bug-report/index.js`,
  which only exists after a build; the worktree was never built.

Every "green" verdict below means: same 2 failures, no new ones, typecheck
clean.

## Results

| PR | Author | Plan master | Result | Merge commit |
|---|---|---|---|---|
| #3400 | @rodboev | #3603 plan-15 | merged | `bf35430c3` |
| #4064 | @trencho | #3603 plan-15 | merged | `685981cb6` |
| #3476 | @jbelke | #3603 plan-15 | merged | `c340932c2` |
| #3410 | @ChingEnLin | #3608 plan-20 | merged | `1ce59d484` |
| #3709 | @mamadou-wane | #3607 plan-19 | merged | `ed2b39b41` |
| #4058 | @thedotmack | #3611 plan-23 | merged | `b11034b6e` |
| #3407 | @JiataiWang | #3609 plan-21 | merged | `07ba05ae6` |

Each was merged with `gh pr merge N --squash --delete-branch=false` and a body
crediting the author and naming the plan master. After each merge the work
branch was fast-forwarded to the new `origin/main`, so every later PR was
tested against the updated tree.

---

### #3400 — test(cors): use OS-assigned ports in CORS restriction tests
**Merged `bf35430c3`.** Test-only, 1 file, 14+/4-, exactly as triaged
("test-only, clean, merge-now"). Replaces a guessed random port in
41000–51000 with `listen(0)` plus `server.address().port`, and only closes the
server when `server.listening`. No secrets, no dependency changes, no CI
changes.

Tested on a local merge of `origin/main` (`6c1ecb54a`):
`bun test tests` → 3716 pass, 28 skip, 2 fail (baseline only).
`tsc --noEmit` → clean.

Closes #3392 via the PR body.

### #4064 — fix(logger): recompute the log filename when the UTC date changes
**Merged `685981cb6`.** 1 file, 8+/2- in `src/utils/logger.ts`, matching the
triage note (logger latch, closes #4063). `ensureLogFileInitialized()`
computed the date inside the boolean latch, so a long-lived worker froze
`logFilePath` at its start day. The date is now computed before the latch and
compared against it. No secrets, no dependency changes, no CI changes.

Tested on a local merge of `origin/main` (`bf35430c3`):
`bun test tests` → 3716 pass, 28 skip, 2 fail (baseline only).
`tsc --noEmit` → clean.

Closes #4063 via the PR body.

### #3476 — fix(worker): recycle a worker that is healthy but never becomes ready
**Merged `c340932c2`.** 4 files, 111+/15-. Implements plan-15's named
"healthy but never ready" recycle with the 7.15-day wedge evidence from the
triage note, plus the two things that caused that wedge: a `.iterate()` →
`.all()` fallback in schema migration v46 for Bun < 1.1.31, and `engines.bun`
corrected from `>=1.0.0` to `>=1.1.31` in `package.json` and
`plugin/package.json`. The engines fields are advisory metadata, not
dependency additions. No secrets, no CI changes.

**Conflict resolved.** The PR was `CONFLICTING` against main. Merging
`origin/main` conflicted in `src/shared/worker-utils.ts`: main had added the
`alreadyRecycledBundle` guard to the version-mismatch recycle while the branch
had split that block into wedged-worker vs version-mismatch branches. Resolved
by keeping both, with main's guard on the version-mismatch branch only — a
wedged worker's bundle is not stale, so each recycle of it is a fresh attempt.
`recycleBuildKey` therefore stays null on the wedged path, which only means
`warnIfVersionStillMismatched` skips persisting, the correct behaviour there.
The resolved merge was pushed to the contributor's branch
(`jbelke:fix/recycle-wedged-worker`, `maintainer_can_modify: true`) so GitHub
could merge it.

Tested after that resolution:
`bun test tests` → 3716 pass, 28 skip, 2 fail (baseline only).
`tsc --noEmit` → clean. `lint:hook-io` and `lint:spawn-env` → OK.

### #3410 — fix(context): honor CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES on session-start injection
**Merged `1ce59d484`.** 3 files, 101+/2-, review state APPROVED — matches the
triage note ("clean, mergeable, three files, verified live defect"). The two
documented settings keys were missing from `SettingsDefaultsManager.DEFAULTS`
so `loadFromFile` dropped them, and `loadContextConfig` built both sets from
the mode file alone. Adds the keys with empty defaults and parses them as CSV
with a mode-wide fallback. Ships 5 new tests covering both halves. No secrets,
no dependency changes, no CI changes.

Tested on a local merge of `origin/main` (`c340932c2`):
`bun test tests` → 3721 pass (+5 from this PR), 28 skip, 2 fail (baseline only).
`tsc --noEmit` → clean.

Closes #3409 via the PR body. Its rival #3310 was left untouched.

### #3709 — harden(observer): deny SendMessage and ListAgents to Observer sessions
**Merged `ed2b39b41`.** 3 files, 51+/8-, exactly the 51 lines the triage note
described. Adds the two peer-session tools to `OBSERVER_DISALLOWED_TOOLS`,
syncs the shipped `plugin/scripts/worker-service.cjs` bundle to the same
14-entry array, and documents that the layered guarantee holds on the SDK path
only — on the CLI spawn path the deny-list is the sole enforcement. No
secrets, no dependency changes, no CI changes.

**Note on the head.** `gh pr checkout 3709` fetched a stale
`refs/pull/3709/head` (`a09fff27e`); merging main conflicted in the generated
bundle, which was resolved by taking main's regenerated bundle and re-applying
the two-entry addition. The push was then rejected as a non-fast-forward
because the author had meanwhile rebased the branch onto current main
(`fd76767b7`). That real head has an **identical tree** to the locally
resolved merge (`767444a0934eb3514814e639692e0c21d524617c` both), so the test
run below covers the merged code exactly, and nothing was pushed to the
contributor's branch.

Tested:
`bun test tests` → 3722 pass, 28 skip, 2 fail (baseline only).
`tsc --noEmit` → clean.

### #4058 — fix(antigravity): align hooks/adapter/transcript with agy 1.2.1 contract
**Merged `b11034b6e`.** 5 files, 571+/216-. Larger than the other singles but
confined to the Antigravity adapter, its installer, its compat tests and its
docs page, plus one shared file: `src/shared/transcript-parser.ts` gains an
additive Antigravity node-type branch. Matches the triage note ("narrow, on
main, clean, compat test; survivor of three attempts"). No secrets, no
dependency changes, no CI changes.

One shared-path behaviour note worth recording: the extracted `contentToText`
helper now also accepts content-array items whose `type` is `undefined` (as
long as they carry a string `text`), where the old code required
`type === 'text'`. That is a deliberate loosening for the Antigravity shape;
the existing Claude/Cursor transcript tests all still pass.

Tested on a local merge of `origin/main` (`ed2b39b41`):
`bun test tests` → 3732 pass, 28 skip, 2 fail (baseline only).
`tsc --noEmit` → clean. `lint:hook-io` and `lint:spawn-env` → OK.

Closes #4057 via the PR body. No version bump was made here.

### #3407 — fix(skills): correct the timeline-report example SQL schema
**Merged `07ba05ae6`.** 1 file, 3+/3- in
`plugin/skills/timeline-report/SKILL.md` — the three lines the triage note
promised. Verified independently before merging: `source_tool` has **zero**
occurrences anywhere under `src/`, and all fifteen columns the PR substitutes
in do exist in the SQLite `observations` table. `plugin/skills/` is the only
copy of this file in the tree, so there is no un-fixed source elsewhere. No
secrets, no dependency changes, no CI changes.

**Flaky first run, re-run to confirm.** The first `bun test tests` on this
branch reported 9 fail in 567s, the 7 extra being `ChromaMcpManager singleton
enforcement` cases and one worktree-adoption Chroma hydration case, one of
them taking 334s. A markdown-only change cannot affect `ChromaMcpManager`, so
the run was repeated: 3732 pass, 28 skip, 2 fail in 161s — identical to
baseline. Treated as an environmental Chroma/uvx stall, not a PR defect.

`tsc --noEmit` → clean.

Closes #3332 via the PR body.

## Not touched

Per the brief, nothing outside the seven was merged, and these were left
alone: #3614, #3564 / #3403, #3416 / #3408 / #3309, #3310 (#3410's rival),
#4050. Nothing was pushed to `main` directly; every landing went through
`gh pr merge --squash`.

## Follow-ups worth someone's attention

1. **Two tests fail on a clean main.** Neither is anyone's regression, but
   both make "is the suite green?" cost a judgement call on every future
   merge. `plugin-distribution` needs a build to have run;
   `field-deadline-wire` needs live network. Both could be gated on an env
   flag or moved out of the default `bun test tests` target.
2. **The Chroma tests are flaky under load** — see #3407 above, where six of
   them failed once and passed on re-run with a 3.5x wall-clock difference.
3. **Generated bundles conflict by construction.** #3709 hit a conflict in
   `plugin/scripts/worker-service.cjs` purely because both sides regenerated
   it. The triage report already flags this as a permanent blocker for #3309;
   it will keep costing manual resolutions until the bundle is either built in
   CI or excluded from PR diffs.
