# Batch 04 — 29 PRs routed, 2 closed

| PR | master | action | reason |
|---|---|---|---|
| 3306 | #3603 plan-15 | commented | Stale worker.pid claiming a live process that never answers /api/health. |
| 3297 | #3602 plan-14 | commented | Job Object kill-on-close for the SDK subprocess pool; base #3286 closed as superseded, WindowsJobObject.ts never landed. |
| 3291 | #3607 plan-19 | commented | findClaudeExecutable unspawnable-vs-ENOENT self-heal; cwd half redundant against merged #3727/#4054. |
| 3285 | #3982 plan-25 | commented | FTS5 fallback when Chroma yields nothing usable; recency-window trigger distinct from #3173. |
| 3284 | #3609 plan-21 | commented | FTS5 delete-marker bloat unreclaimable by VACUUM; no VALUES('optimize') under src/ on main. |
| 3269 | #3605 plan-17 | commented | Hook fail-open vs exit 2; permanent lockout already fixed on main by #4033's thresholdTripped latch. |
| 3264 | #3611 plan-23 | commented | Unbounded recursion in firstString over host-supplied platformSource from the HTTP surface. |
| 3263 | #3606 plan-18 | commented | litellm body-level parse errors inside HTTP 200 misclassified as unrecoverable. |
| 3261 | #3609 plan-21 | commented | Cloud-shaped array fields break bun SQLite binding and abort the whole import batch. |
| 3259 | #3982 plan-25 | commented | Filterless search throws instead of returning []; all three throw sites still on main. |
| 3258 | #3604 plan-16 | commented | Single-source allowScripts allowlist; does not fix the npm v12 EALLOWSCRIPTS symptom. |
| 3254 | #3604 plan-16 | commented | tree-sitter-cli left without its executable by --ignore-scripts bulk installs. |
| 3252 | #3602 plan-14 | commented | cross-spawn EPERM on an un-chdir-able inherited cwd; root cause largely removed by merged #3727/#4054, needs rebase. |
| 3250 | #3602 plan-14 | commented | ProcessRegistry.persist() still a bare unguarded writeFileSync on main (line 343). |
| 3243 | #3605 plan-17 | **closed** | Third open PR on the same worker-utils.ts path as #3269/#3225; lockout fixed by merged #4033, remaining delta ruled out by merge rubric §3. |
| 3228 | #2785 plan-12 | commented | Net-new dynamically-loaded custom server generation provider. |
| 3227 | #3618 plan-24 | commented | Server-runtime SessionStart injection never implemented; hooks unconditionally start a local worker. |
| 3226 | #3604 plan-16 | commented | Marketplace refresh wipes the untracked install marker; builds on merged #3210. |
| 3225 | #3605 plan-17 | commented | Fail-open half superseded by #4033, but the zod/bun.lock drift build guard (plan-16) is unique — asked for a split. |
| 3219 | #3603 plan-15 | commented | Bounded pre-spawn bind classifier serialized with the spawn lock; merged #4002 added only diagnosis. |
| 3208 | #3611 plan-23 | commented | Full OpenCode lifecycle capture/injection, live 1.17.18 verification; overlaps #3803 and #2985. |
| 3203 | #3610 plan-22 | commented | Frozen watermark re-sending batches forever at a permanently failed HNSW segment. |
| 3197 | #3606 plan-18 | commented | Auth-failure prose confirmed-and-dropped like idle, while dead ai.lastInteraction keeps health green. |
| 3192 | #3602 plan-14 | commented | chroma-mcp native memory leak in a live registered child — resource bound/recycle, not orphan reaping. |
| 3184 | #3606 plan-18 | commented | Empty-string lastAssistantMessage skips the whole session summary; !== undefined branch still on main (line 88). |
| 3178 | #3602 plan-14 | **closed** | Superseded by merged 22879ef5 "reap chroma-mcp trees no worker owns at boot" (orphan-chroma-sweep.ts, same init point). |
| 3173 | #3982 plan-25 | commented | The founding CJK repro; fixes the fallback in both duplicated pipelines. |
| 3168 | #3605 plan-17 | commented | Stop-loop broken by merged #4033's latch, but the "summarize never exits 2" invariant is strictly stronger and unimplemented. |
| 3165 | #2785 plan-12 | commented | Net-new advisor-call capture + viewer surface. |

## Next-PR candidates
- #3219 plan-15 — cleanest bind-classifier / one-bounded-pre-spawn-decision; reconcile with #3405 and merged #4002.
- #3173 plan-25 — the CJK repro that named the cluster; only PR fixing the fallback in both pipelines. Should absorb #3285's recency-window condition and drop unrelated telemetry files.
- #3203 plan-22 — already rewritten against docs/merge-rubric.md (656 -> 310 lines); right shape for the chroma sync-watermark fix.
- #3250 plan-14 — tiny, verified live, reuses the existing atomic-write helper; low-risk anchor for the supervisor half.
- #3168 plan-17 — keys the exemption on the handler rather than the platform event, the generalisation other fail-open PRs miss.
