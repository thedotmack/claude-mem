# oh-my-issues run — thedotmack/claude-mem, 2026-09-12

Branch `work/oh-my-issues`, worktree `.claude/worktrees/oh-my-issues`.
PR: **[#4067](https://github.com/thedotmack/claude-mem/pull/4067)** `docs(plans): oh-my-issues cluster pass`.

## Counts

| | |
|---|---|
| Open issues read in full (body + every comment) | 26 |
| Open PRs read in full (body, files, review threads) | 172 |
| Clusters | 13 (all pre-existing) |
| New masters opened | **0** |
| Masters given a Round-N consolidation comment | 7 |
| Children closed as *not planned* | 11 |
| Issues left open as genuinely independent | 2 |
| Open issues after | **26 → 15** (13 masters + 2 independent) |
| PRs commented | 172 |
| PRs closed (duplicate or superseded) | 11 |
| Open PRs after | **172 → 162** (171 triaged + the new #4067) |
| Plans docs written | 13 + `plans/README.md` |
| PRs merged | **0** (out of scope this run) |

## The one judgment call

The brief asked for a Mode 1 cluster pass. The backlog **had already been consolidated**: #3602–#3611,
#3618, #3982 and #2785 were open plan masters (plan-12 … plan-25) already carrying children. Opening a
second set of masters would have duplicated them, so this ran as **Mode 2 steady-state triage** against
the existing thirteen. The skill points the same way — *"Resist this. Most bugs are children of existing
plans."* Every residual issue mapped to an existing master; none was novel enough to need its own.

What the pass did surface is real drift, of the kind the skill's own health check names: **every master's
body references a `plans/NN-*.md` design doc, and not one of those files existed on disk.** The design
half of the issue/doc pair had never been written, so the only copy of each architectural defect lived in
a GitHub issue body. That is what #4067 fixes.

## Clusters and children routed this round

| Plan | Master | Children closed into it |
|---|---|---|
| plan-12 | #2785 Provider & Extensibility Roadmap | #4060, #3833, #3845 |
| plan-14 | #3602 Child Process Ownership | — |
| plan-15 | #3603 Worker Port & Liveness Authority | #4059, #4063 |
| plan-16 | #3604 Canonical Install Identity & Bundle Integrity | — |
| plan-17 | #3605 Hook Wrapper Contract | — |
| plan-18 | #3606 Observer Response Pipeline | #4066, #3897, + residual half of #4062 |
| plan-19 | #3607 Observer Subprocess Isolation | #4065 |
| plan-20 | #3608 Project Identity & Injection Scope | #4061 |
| plan-21 | #3609 SQLite Schema Evolution & Queue State Integrity | #4062 |
| plan-22 | #3610 Chroma Sidecar Contract | — |
| plan-23 | #3611 Host Integration Contracts | #4057 |
| plan-24 | #3618 Server Runtime & Cloud Sync Contract | — |
| plan-25 | #3982 Search Read Path (FTS/CJK) | — |

Each Round-N comment carries the symptom, a concrete fix sketch, and the new test-matrix cells the
report exposes. Routing notes worth keeping:

- **#4062** splits. The `NOT NULL memory_session_id` crash is plan-21 and is **already fixed on main**
  (`cd8258f` / PR #3629, 13.24.16) — the NULL was written by the id reset before a fresh SDK spawn and
  cascaded into the children via `ON UPDATE CASCADE`, which is why the guard before the storage call never
  helped. Its two *unfixed* asks — a non-`auth:`/`quota:` throw finalizing the session instead of pausing
  it, and no backoff on an unrefreshable credential retried for 10.5 h — went to plan-18.
- **#4065** raises a cross-cutting ask (warn on any unknown `CLAUDE_MEM_*` key in settings.json) that also
  retires plan-20's decorative-config finding. Whichever plan ships the settings registry first owns it.
- **#3897** carries an open A/B the reporter and a commenter both raised. Recommendation recorded on the
  master: ship **(A)** a provisional/`unverified` marker (prompt + validator, lands in plan-18) before
  **(B)** a `supersedes` column (plan-21 migration + plan-25 rendering).

## Issues left open, and why

- **#3763** — a CMEM Pro support question: which model powers the hosted `cmem-observer`, and whether
  memories created before subscribing can be imported into CMEM Cloud. Not a symptom of any architectural
  defect, so a redirect comment would be the wrong instrument. It needs an answer, and both facts are
  product/pricing decisions I cannot verify from the repo — **flagged for you**. Open since 2026-08-27
  with a reporter ping on 09-05.
- **#3372** — 🏥 The Merge Clinic, the standing contributor guide on getting a PR merged. A reference doc,
  not a tracked defect.

## PRs

All 172 open PRs were read and commented, each naming its master. Distribution:

| Master | PRs |
|---|---|
| plan-12 #2785 (net-new capability) | 41 |
| plan-18 #3606 (observer response pipeline) | 28 |
| plan-23 #3611 (host adapters) | 18 |
| plan-17 #3605 (hook wrapper) | 17 |
| plan-21 #3609 (sqlite / queue state) | 11 |
| plan-15 #3603 (port & liveness) | 10 |
| plan-20 #3608 (project identity & injection) | 9 |
| plan-22 #3610 (chroma sidecar) | 8 |
| plan-16 #3604 (install identity) | 8 |
| plan-14 #3602 (process ownership) | 7 |
| plan-24 #3618 (server & sync) | 6 |
| plan-25 #3982 (search read path) | 5 |
| plan-19 #3607 (observer subprocess) | 4 |

Two facts stand out. **plan-12 takes 41 of 172** — nearly a quarter of the open queue is net-new
capability, not defect repair, and most of it is providers: six competing provider PRs alone. And
**plan-18 takes 28**, all circling one missing classifier; roughly a dozen of them would collapse into
#3624 plus #3151/#2957 if that contract landed first.

### PRs closed (11)

| PR | Closed because |
|---|---|
| #3742 | Superseded by #4058 — same four Antigravity adapter fixes, plus hooks.json and transcript-parser, on clean main. |
| #3397 | Superseded by #4058, which reimplements the Antigravity-only fixes narrowly and credits it. |
| #3674 | Superseded by #3882, a source-only Codex provider on current main that explicitly builds on this branch. |
| #3634 | Quota breaker already merged as `7a7ada5f6`; `SessionRoutes.ts:266` literally cites "#3634". |
| #3441 | Duplicate of #3658, which makes the same manifest fix and also hardens `isPluginInstalled()`. |
| #3339 | Superseded by #3868, a strict superset (bounds OpenRouter history *and* re-anchors the schema). |
| #3243 | Third open PR on the same `worker-utils.ts` path; lockout fixed by merged #4033, remaining delta ruled out by the merge rubric. |
| #3178 | Superseded by merged `22879ef5` (`orphan-chroma-sweep.ts` at the same supervisor init point). |
| #2951 | Superseded — `session-message-buffer.test.ts` on main (`61fe70a20`) already asserts the `resetClaimed` re-yield. |
| #2770 | Parent issue #2769 closed NOT_PLANNED; two of its files deleted from main. |
| #2598 | Superseded by merged #3453 (`7234951f2`), which deleted the `$SHELL -lc` prelude from hooks.json and the template. |

Closures required a named merged commit, a named superseding PR, or a NOT_PLANNED parent. Overlapping
pairs that did *not* meet that bar were left open and flagged instead.

## Next PRs — one per cluster, to be written in a later run

Not written in this run, as instructed. Where an existing community PR is already the best implementation
of a cluster's fix, it is named rather than duplicated.

| Plan | Next PR | Basis |
|---|---|---|
| plan-14 #3602 | Supervisor process-ownership anchor | Start from **#3250** (`ProcessRegistry.persist()` is still a bare unguarded `writeFileSync` at line 343 on main; tiny, reuses the existing atomic-write helper), then **#3297** Job Object kill-on-close and **#3192** child resource bound/recycle. |
| plan-15 #3603 | One liveness authority: owner record + start token, port owner reclaimable | **#3416** is the reference statement of the port-oracle disagreement; **#3309** the upstream complement (`HANDLE_FLAG_INHERIT` at bind + dead-holder `spawn.lock` reclaim); **#3219** the bounded pre-spawn bind classifier. Merge-now singles: **#3400** (test-only, clean), **#4064** (closes the #4063 logger latch), **#3476** (healthy-but-never-ready). |
| plan-16 #3604 | Canonical `resolvePluginRoot()` used by every resolver | **#3535** carries the primitive; **#3658** the marketplace manifest half; **#3254** the `--ignore-scripts` dependency-completeness half. |
| plan-17 #3605 | Exec-form node launchers + a wrapper that cannot return a blocking exit code | **Pick one of #3564 / #3403** — identical fix, needs a maintainer call. **#3168** generalises the fail-open exemption by keying on the handler rather than the platform event; rebase it on merged #4033's latch. |
| plan-18 #3606 | One output classifier with one policy table | **#3624** is the spine (confirm-only-after-storage; main's `output-classifier.ts` still documents "prose is confirmed and dropped"). **#3151 + #2957** are the two non-overlapping halves of the context bound. **#3368** is the only shared worker+server empty-response classifier. Then **#3619** (double-append, +168/-3, live double-billing) and **#3063** (near-dup dedup, validated against a 7,651-observation DB). New scope from this round: budget-counts-answered-history + no-abort-in-flight (#4066), and the provisional-observation marker (#3897). |
| plan-19 #3607 | Declared spawn contract for the headless generator | **#3709** first — 51 lines, closes a live proxy-privilege hole (`SendMessage`/`ListAgents` still absent from `OBSERVER_DISALLOWED_TOOLS` on main). Then **#3615** tool lockdown, **#3291**/**#3321** binary resolution. New scope: settings-reachable generator config (#4065). |
| plan-20 #3608 | One `resolveProjectIdentity()` + a `ContextScope` built once | **#3410** is clean and mergeable and should land first; **#3310** sequences behind it rather than adding a second config route. **#3643** fixes the worktree key and `merged_into_project` at the resolver; **#2827** is the closest existing step-1 git-remote slug; **#3536** the case-collation half. New scope: no injection on `resume`, idempotent per launch (#4061). |
| plan-21 #3609 | One schema authority + one settings-document boundary | **#3472** is the only PR building a single fail-closed `settings.json` boundary — **#3518** and **#3498** should rebase onto it rather than add competing write paths. **#3407** is three lines and reproduces on main today. |
| plan-22 #3610 | **Step 0 is a decision, not a PR** | Keep-vs-retire the sidecar gates the whole cluster. If keep: **#3384** (pin `chromadb`, still unpinned on main) is the step-1 commit, then **#3203** (watermark, already rewritten to the merge rubric at 656→310 lines) and **#3571**. If retire: **#3694** is the most complete in-worker index, and **#3675** is mooted. Five PRs are blocked on this call. |
| plan-23 #3611 | A checked-in host-schema fixture per adapter, validated in CI | **#4058** lands the Antigravity contract (clean, on main, compat test, already the survivor of three attempts). **#3803** and **#3621** are the best contract-test pattern in the repo and should be the template the other adapters copy. **#3494** is the best worked example of an adapter failing silently against a real host — the argument the cluster rests on. |
| plan-24 #3618 | One generation pipeline shared by worker and server | **#3635** (server generation max_tokens/passthrough/empty-response), **#3537** (bounded sync — unbounded `.all()` drain + per-prompt `prepare()`), **#3227** (server-runtime SessionStart injection; hooks unconditionally starting a local worker). |
| plan-25 #3982 | CJK-aware matching on one read path | **#3173** is the founding repro and the only PR fixing the fallback in *both* duplicated pipelines; it should absorb **#3285**'s recency-window trigger and shed its unrelated telemetry files. **#3693** (day headers) and **#3259** (filterless search throwing instead of returning `[]`) are small and confirmed live. |
| plan-12 #2785 | Ship per sub-area | **#3846** closes the brainbeats child (#3845). **#2741** is the only tested subagent-filter implementation. The six-way provider pile-up (#3942/#3941/#3882/#3581/#3623/#3376) needs one preset-table shape chosen first — **#3942**'s is the candidate. |

## Escalations — decisions only you can make

1. **#3614 is jammed and holding eight PRs hostage.** It is a `--no-ff` bundle of eight community branches,
   now conflicting at +4772/−868, and its sources (#3519, #3460, #2985, #3405, #3291 among them) are being
   held open waiting for it. It needs a bundle-or-re-cut call soon; right now it is the single biggest
   blocker in the queue.
2. **plan-22 keep-or-retire.** The master already records that you signalled Chroma may be scrapped
   (#3138). Until that is answered, five PRs cannot be sequenced and #3694 cannot be justified a rebase.
3. **Three unresolved collisions**, each two or three PRs implementing the same fix differently — a pick,
   not a close: **#3564 vs #3403** (exec-form node launchers, identical), **#3416 / #3408 / #3309** (Windows
   port reclaim), **#3410 / #3310** (context-filter routes).
4. **#4050 is in the wrong repo** — "FACE CARD", a standalone ~10k-line Next.js app under `facecard/` that
   shares nothing with claude-mem. Commented, not closed; it is someone's real work and deserves a word
   from you rather than a silent close.
5. **#3763 needs an answer from you** (see above) — which model powers hosted `cmem-observer`, and whether
   pre-subscription memories can be imported.

## Provenance

Full per-batch PR triage in `.agent-jobs/pr-results/batch-0{0..5}.md`; the routing map handed to the six
triage agents is `.agent-jobs/cluster-map.md`. Issue bodies and comment threads were read in full from a
443 KB dump (not committed).
