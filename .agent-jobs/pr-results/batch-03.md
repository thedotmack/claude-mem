# Batch 03 — 29 PRs routed, 3 closed

| PR | master | action | reason |
|---|---|---|---|
| 3441 | #3604 plan-16 | **closed** | Duplicate of open #3658, which makes the same package.json files + copyPluginToMarketplace() fix and also hardens isPluginInstalled(). |
| 3440 | #3605 plan-17 | commented | Session-init request budget bounded inside the 15s wire timeout; unique in the queue, now conflicting. |
| 3433 | #3606 plan-18 | commented | Mostly superseded by merged d13fc437f; only the query/fragment-preserving resolver + viewer panel remain. |
| 3431 | #3605 plan-17 | commented | Fail-open runtime hooks / fail-loud Setup at the wrapper layer. |
| 3428 | #3605 plan-17 | commented | Group-level stderr suppression on the plugin-root discovery pipe. |
| 3422 | #3610 plan-22 | commented | Names the sidecar's embedding function at collection creation; cross-flagged to plan-25. |
| 3421 | #3609 plan-21 | commented | Session finalize racing an in-flight summarize. |
| 3416 | #3603 plan-15 | commented | Two port oracles disagreeing on a Windows orphaned listener — sharpest statement of the plan-15 root cause. |
| 3414 | #2785 plan-12 | commented | ACT-R ranking; asked for a phase-1 split (29k lines incl. vendored chroma). |
| 3410 | #3608 plan-20 | commented | Context filter keys still dropped on main; MERGEABLE/CLEAN. |
| 3408 | #3603 plan-15 | commented | 15-fix Windows grab-bag whose port half overlaps 3416/3309; suggested splitting. |
| 3407 | #3609 plan-21 | commented | source_tool still referenced at SKILL.md:94/120/145 on main, still absent from the table. |
| 3403 | #3605 plan-17 | commented | Exec-form node launchers; collides with #3564 (same fix) — plan-17 must pick one. |
| 3401 | #3605 plan-17 | commented | SessionStart async / UserPromptSubmit sync scheduling split; only PR touching it. |
| 3400 | #3603 plan-15 | commented | Re-routed from plan-16: random fixed test port is a port-ownership problem. MERGEABLE/CLEAN. |
| 3397 | #3611 plan-23 | **closed** | Superseded by #4058, which reimplements the Antigravity-only fixes narrowly on current main and credits this PR. |
| 3393 | #3610 plan-22 | commented | Chroma child exit code/signal + fatal-exit counter in doctor; complements 3384. |
| 3384 | #3610 plan-22 | commented | chromadb== still unpinned under src/ on main; natural first commit of the plan-22 bundle. |
| 3376 | #2785 plan-12 | commented | New provider; flagged the six-way provider pile-up and #3942's preset-table shape as the upstream decision. |
| 3368 | #3606 plan-18 | commented | Empty-response classification on both worker and server paths; needs one shared classifier with #3467/#3460/#3635/#3624. |
| 3352 | #3606 plan-18 | commented | Prompt-side anti-repetition; complementary to write-time dedup (#3063). |
| 3339 | #3606 plan-18 | **closed** | Superseded by #3868, a strict superset (bounds OpenRouter history and re-anchors the schema), current against main. |
| 3323 | #2785 plan-12 | commented | CLAUDE_MEM_PUBLIC_URL honored only by the server runtime; worker viewer URLs still hardcode localhost. |
| 3322 | #2785 plan-12 | commented | Missed by the August pass — routed now; Endless Mode net-new, stale since July. |
| 3321 | #3607 plan-19 | commented | where.exe argv resolution in findClaudeExecutable/ProcessManager. |
| 3316 | #3605 plan-17 | commented | Console-window opt-out; escape hatch, not the cure. |
| 3311 | #3608 plan-20 | commented | Verified #4055 (e2d309b37) does not cover the non-git basename fallback. |
| 3310 | #3608 plan-20 | commented | Injection scope filter; should sequence behind #3410. |
| 3309 | #3603 plan-15 | commented | Clears HANDLE_FLAG_INHERIT at bind + dead-holder spawn.lock reclaim; regenerated .cjs bundles are a permanent-conflict blocker. |

## Next-PR candidates
- #3410 plan-20 — clean, mergeable, three files, verified live defect. The one #3310 should build on.
- #3407 plan-21 — three lines, clean, defect reproduced on main today.
- #3384 plan-22 — smallest correct change in the chroma cluster; natural step-1 commit.
- #3416 plan-15 — reference statement of the port-oracle disagreement, with #3309 as the upstream complement.
- #3400 plan-15 — test-only, clean, merge-now.
- #3368 plan-18 — only PR fixing empty-response classification on both worker and server paths.

## Notes
- 28 of 29 already carried an Aug 17 routing comment; this pass's comments add current merge state, supersession against merged main, duplicate evidence, sequencing.
- Routing corrections: #3400 moved plan-16 -> plan-15; #3322 routed for the first time.
- Unresolved collisions needing a maintainer call rather than a close: #3403 vs #3564 (identical exec-form fix); #3416 / #3408 / #3309 (three Windows port-reclaim routes); #3410 / #3310 (two context-filter routes).
