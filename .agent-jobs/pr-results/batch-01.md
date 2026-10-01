# Batch 01 — 29 PRs routed, 2 closed

| PR | master | action | reason |
|---|---|---|---|
| 3674 | #2785 plan-12 | **closed** | Codex CLI provider; superseded by #3882, a source-only Codex provider on current main that explicitly builds on this branch. |
| 3668 | #3606 plan-18 | commented | SSE-default gateway breaks response.json() + discovery-token accounting. |
| 3667 | #3605 plan-17 | commented | Module-scope asset reads run in every hook spawn. |
| 3662 | #3606 plan-18 | commented | Deprecated OpenRouter default 404 misclassified; still shipping xiaomi/mimo-v2-flash:free on main. |
| 3658 | #3604 plan-16 | commented | Missing root marketplace.json + blind isPluginInstalled(); superset of #3441. |
| 3655 | #3611 plan-23 | commented | Codex native-hook vs transcript-watch ownership drops thread_spawn rollouts. |
| 3654 | #3611 plan-23 | commented | Transcript adapter never writes user_prompts, so prompt 0 breaks observer init. |
| 3643 | #3608 plan-20 | commented | Doubled worktree project key + FTS filter ignoring merged_into_project. |
| 3642 | #3611 plan-23 | commented | Unguarded fs.watch ENOENT in the transcript watcher kills the worker. |
| 3635 | #3618 plan-24 | commented | All files under src/server/generation/; hardcoded max_tokens + dropped empty responses. |
| 3634 | #3606 plan-18 | **closed** | Quota breaker already on main via 7a7ada5f6 (SessionRoutes.ts:266 cites "#3634"), hardened by 4 follow-ups. |
| 3632 | #3609 plan-21 | commented | Settings write path; Express 5 req.body undefined yields opaque 500. |
| 3626 | #3606 plan-18 | commented | Claude SDK context rollover; complementary to 3625, not a duplicate. |
| 3625 | #3606 plan-18 | commented | OpenAI-compatible history compaction; conversation-window.ts gone from main so no bound exists. |
| 3624 | #3606 plan-18 | commented | Confirm-only-on-storage; main still confirms prose and drops the batch. |
| 3623 | #2785 plan-12 | commented | Net-new OpenCode Zen/Go provider; carries plan-23 files + regenerated bundles it should shed. |
| 3621 | #3611 plan-23 | commented | OpenCode installer never writes an mcp["claude-mem"] block. |
| 3620 | #3606 plan-18 | commented | finish_reason: length unread; truncated observation reported as model failure. |
| 3619 | #3606 plan-18 | commented | Assistant reply double-pushed (live at OpenAICompatibleProvider.ts:234 + ResponseProcessor.ts:311). |
| 3617 | #2785 plan-12 | commented | The plan-master/skill docs PR itself; only clean-mergeable PR in the batch. |
| 3615 | #3607 plan-19 | commented | SDK tool lockdown surface for the headless observer. |
| 3614 | #3602 plan-14 | commented | 8-PR bundle; largest share is shutdown/supervisor/process-registry ownership. |
| 3600 | #2785 plan-12 | commented | Markdown-only make-plan skill change. |
| 3581 | #2785 plan-12 | commented | Net-new OrcaRouter provider; only open OrcaRouter PR. |
| 3571 | #3610 plan-22 | commented | Pinned chroma-mcp, mutation deadlines, watermarks — plan-22's fix list in one branch. |
| 3564 | #3605 plan-17 | commented | Windows bash->node->bun console flash; same 4 files as #3403, better base. |
| 3562 | #2785 plan-12 | commented | New CLAUDE_MEM_SKIP_BASH_PATTERNS filtering knob. |
| 3558 | #3603 plan-15 | commented | Worker exits 0 without binding 37777, no signal at all. |
| 3556 | #3611 plan-23 | commented | New OMP hooks adapter; third hand-rolled copy of the same conventions. |

## Next-PR candidates
- #3624 plan-18 — confirm-only-after-storage contract; main's output-classifier.ts still documents "prose is confirmed and dropped". The spine the rest of plan-18 hangs off.
- #3643 plan-20 — shared buildWorktreeProjectKey on write + migration paths plus merged_into_project in buildFilterClause; neither on main.
- #3564 plan-17 — exec-form node launchers; best diagnosis of the Windows console cluster (#3559/#3521/#3396/#3248). Fold #3403 into it.
- #3621 plan-23 — narrow, absolute-path-resolved, fixture-backed contract test; cleanest template for a host adapter.
- #3619 plan-18 — +168/-3, confirmed-live double-billing bug; should land ahead of #3625.

## Escalations
- #3614 is a --no-ff bundle of eight branches, now conflicting at +4772/-868, and those eight PRs are held open waiting for it. Needs a bundle-or-re-cut decision.
- Duplicate pairs where the WORSE half sits outside this batch: #3658 supersedes #3441; #3564 supersedes #3403. Left both halves open.
