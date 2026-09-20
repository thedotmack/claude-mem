# Batch 05 — 27 PRs routed, 3 closed

| PR | master | action | reason |
|---|---|---|---|
| 3151 | #3606 plan-18 | commented | Bounds conversationHistory on the OpenAI-compatible path; complementary to #2957. |
| 3116 | #3608 plan-20 | commented | Folder CLAUDE.md absolute-vs-relative path query; Chroma half fixed on main by 38fc189b5. |
| 3113 | #3604 plan-16 | commented | .install-version marker nag; ensure-deps half landed as merged #3972 (d959572bd). |
| 3110 | #3604 plan-16 | commented | Marker path resolution for nested plugin/ roots; cacheDir P1 breaks TS build. |
| 3063 | #3606 plan-18 | commented | Opt-in near-dup observation dedup; main still only has content_hash. |
| 3040 | #3606 plan-18 | commented | Generic extra_body escape hatch; subsumes #3001's disable-reasoning case. |
| 3034 | #2785 plan-12 | commented | New agy-cli observation provider; awaiting product call. |
| 3027 | #2785 plan-12 | commented | Auto-memory default flip + migrate-memory; overlaps #2829, different mechanism. |
| 3001 | #3606 plan-18 | commented | Typed OpenRouter reasoning-effort knob; overlaps #3040, default none P1 open. |
| 2957 | #3606 plan-18 | commented | Agent SDK context cap; the other half of #3151. |
| 2951 | #3609 plan-21 | **closed** | Superseded — main's session-message-buffer.test.ts (61fe70a20) already asserts the resetClaimed re-yield. |
| 2925 | #2785 plan-12 | commented | Viewer delete UX; SQLite delete orphans Chroma vectors (P1). |
| 2892 | #3605 plan-17 | commented | Reported failure fixed by merged #4033 (bf25c8972); the "never exit 2" design delta remains. |
| 2867 | #3618 plan-24 | commented | UUID ref abbreviation driven by server-runtime Postgres ids. |
| 2835 | #3611 plan-23 | commented | claude platform alias; install pre-validation still rejects it end-to-end. |
| 2833 | #2785 plan-12 | commented | Transcript JSONL backfill (child #2690); sibling of #2829. |
| 2829 | #2785 plan-12 | commented | Zero-spend auto-memory import; overlaps #3027, opposite call on re-generation. |
| 2828 | #3605 plan-17 | commented | WORKER_AUTOSTART opt-out at the hook chokepoint. |
| 2827 | #3608 plan-20 | commented | Opt-in git-remote project slug — closest existing step-1 implementation; three P1s open. |
| 2810 | #3611 plan-23 | commented | Codex internal-prompt filter belongs in the Codex adapter, not shared tag-stripping. |
| 2770 | #3609 plan-21 | **closed** | Parent issue #2769 closed NOT_PLANNED; two of its files deleted from main; step 3 solves the join defect differently. |
| 2741 | #2785 plan-12 | commented | Subagent observation skip (child #2736). |
| 2737 | #3608 plan-20 | commented | Named environments + five path.basename bypass fixes; diverges from the .claude-mem-project marker shape. |
| 2616 | #2785 plan-12 | commented | Opt-in secret redaction; product decision pending. |
| 2598 | #3605 plan-17 | **closed** | Superseded by merged #3453 (7234951f2), which deleted the $SHELL -lc prelude from hooks.json and the template. |
| 2583 | #2785 plan-12 | commented | New PreCompact hook; hand-edits generated hooks.json, opt-in semantics inverted. |
| 2523 | #2785 plan-12 | commented | Vertex ADC backend; endpoint hostname dispute unresolved, stale against main's Gemini repoint. |

## Next-PR candidates
- #3151 + #2957 together for plan-18 — the two non-overlapping halves of the observer context bound (resent history for OpenAI-compatible/Gemini; fresh-SDK-session cap for ClaudeProvider). Both CLEAN-or-near, review threads addressed. Strongest bundle in the batch.
- #3063 for plan-18 step 5 — dedup design validated against a real 7,651-observation DB before code; Greptile P1 fixed; plan-18 step 5 already describes this shape.
- #2827 for plan-20 step 1 — the plan explicitly adopts the opt-in git-remote slug this PR implements; three known P1s.
- #2741 for plan-12 / #2736 — only tested implementation of subagent filtering, with real DB evidence.

## Note
Most of these already carried a routing note from a prior consolidation pass; the same master was kept in every case and the new comment adds the supersession/duplicate verdict rather than restating routing.
