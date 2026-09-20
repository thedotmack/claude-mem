# Batch 00 — 29 PRs routed, 1 closed

| PR | master | action | reason |
|---|---|---|---|
| 4064 | #3603 plan-15 | commented | Log-filename latch pins a long-lived worker to its boot date; confirmed still on main. |
| 4058 | #3611 plan-23 | commented | Antigravity adapter/hooks/transcript aligned to the real agy contract; only clean one of three. |
| 4051 | #3609 plan-21 | commented | NOT NULL memory_session_id aborting a whole import batch. |
| 4050 | #2785 plan-12 | commented | Standalone 10k-line Next.js app under facecard/; wrong repo. |
| 3958 | #2785 plan-12 | commented | Grok house-wide inject infra — net-new, self-held, conflicting. |
| 3954 | #2785 plan-12 | commented | Docs/specs only under plans/. |
| 3942 | #2785 plan-12 | commented | openai-compatible provider + NVIDIA NIM preset. |
| 3941 | #2785 plan-12 | commented | Multi-key rotation; bottom of the 3941->3942 stack. |
| 3925 | #2785 plan-12 | commented | Skill telemetry plan doc. |
| 3924 | #2785 plan-12 | commented | Stop-hook auto-clear; Plan A's polling hook fights plan-17. |
| 3882 | #2785 plan-12 | commented | Codex subscription provider; needs rebase. |
| 3868 | #3606 plan-18 | commented | Unbounded history + unanchored schema -> idle-class discards. |
| 3853 | #3611 plan-23 | commented | Copilot CLI lifecycle hooks + compat test; mergeable. |
| 3851 | #3609 plan-21 | commented | manual-${project} vs manual-${project}-${platform} collapses sessions. |
| 3846 | #2785 plan-12 | commented | Grok brainbeat webhook; draft, not a dupe of 3958. |
| 3827 | #2785 plan-12 | commented | Install-funnel reorder / Pro billing; collides with 3687. |
| 3803 | #3611 plan-23 | commented | OpenCode export-contract load failure + session attribution. |
| 3751 | #2785 plan-12 | commented | Pro Backups add-on; ~5k lines, needs re-cutting. |
| 3750 | #2785 plan-12 | commented | HelixDB backend; sequence after plan-22 decides the search layer. |
| 3748 | #2785 plan-12 | commented | New /handoff skill; body overclaims vs the diff. |
| 3742 | #3611 plan-23 | **closed** | Superseded by #4058 (same four adapter fixes plus hooks.json + transcript-parser, on clean main). |
| 3709 | #3607 plan-19 | commented | SendMessage/ListAgents still absent from OBSERVER_DISALLOWED_TOOLS on main. |
| 3707 | #2785 plan-12 | commented | Cowork plugin; gated on plan-24's server contract. |
| 3694 | #3610 plan-22 | commented | Retires the Chroma sidecar into an in-worker index — plan-22's "or retire it" branch. |
| 3693 | #3982 plan-25 | commented | searchObservations renders undated rows; groupByDate gap confirmed on main. |
| 3691 | #3611 plan-23 | commented | DeepSeek Harness zstd multi-frame transcripts invisible to the watcher. |
| 3687 | #2785 plan-12 | commented | 30-day trial + fallback provider; overlaps 3827, neither supersedes. |
| 3676 | #3611 plan-23 | commented | Kimi Code CLI harness; plugin bundles drive the conflict. |
| 3675 | #3610 plan-22 | commented | Chroma where-clause post-filtering; mooted if 3694 lands. |

## Next-PR candidates
- #4058 plan-23 Antigravity — narrow, on main, clean, compat test; survivor of three attempts.
- #3803 plan-23 OpenCode — best contract-test pattern in the repo; template for other adapters.
- #3709 plan-19 — 51 lines, closes a real proxy-privilege hole open on main.
- #3868 plan-18 — best-evidenced of three competing observer-context PRs; also fixes schema anchoring.
- #3694 plan-22 — most complete answer to the sidecar question; needs keep-vs-retire decided first.
- #3693 plan-25 / #4064 plan-15 — both tiny, both confirmed live on main, both mergeable or near it.
