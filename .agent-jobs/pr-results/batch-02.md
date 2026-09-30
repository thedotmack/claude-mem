# Batch 02 — 29 PRs routed, 0 closed

| PR | master | action | reason |
|---|---|---|---|
| 3548 | #3618 plan-24 | commented | Deletes the dead SQLite ServerV1Routes stack; file collisions with #3614. |
| 3547 | #3611 plan-23 | commented | Kimi Code CLI adapter; overlaps #3676 but neither supersedes (tool_output/tool_call_id + missing transcript_path fixes only here). |
| 3537 | #3618 plan-24 | commented | Unbounded .all() drain + per-prompt prepare() in the CloudSync write path. |
| 3536 | #3608 plan-20 | commented | Project-key case collation, named verbatim in plan-20; COLLATE NOCASE not on main. |
| 3535 | #3604 plan-16 | commented | CLI half of "one resolvable plugin root". |
| 3529 | #3602 plan-14 | commented | Windows detached: true console allocation in the shared daemon spawn helper. |
| 3525 | #3608 plan-20 | commented | Worktree/submodule adoption sweep reading a table that stopped receiving writes. |
| 3522 | #3606 plan-18 | commented | 400/404 classification discarding the response body. |
| 3519 | #3605 plan-17 | commented | Login-shell PATH prelude guard; bundled into #3614. |
| 3518 | #2785 plan-12 | commented | New setup command; settings-write half should rebase onto #3472. |
| 3516 | #3606 plan-18 | commented | Bounds conversationHistory and fixes double-appended replies. |
| 3514 | #2785 plan-12 | commented | Opt-in local-model provider + external client surface. |
| 3508 | #3606 plan-18 | commented | Real per-provider token accounting; makes plan-18's budget policy enforceable. |
| 3498 | #2785 plan-12 | commented | cloud connect / CMEM managed worker; Pro surface. |
| 3494 | #3611 plan-23 | commented | Four silent Codex injection failures. |
| 3488 | #3982 plan-25 | commented | Result rendering at the MCP boundary. |
| 3479 | #3606 plan-18 | commented | Auth-retry replay retaining failed turns; O(retries x queue depth) history growth. |
| 3477 | #3618 plan-24 | commented | SyncHub version gate in the cloud-sync skill. Only mergeable PR in the batch. |
| 3476 | #3603 plan-15 | commented | "Healthy but never ready" immortal worker — named verbatim in plan-15. |
| 3474 | #3609 plan-21 | commented | Viewer end of the settings-write boundary; pairs with #3472. |
| 3475 | #3606 plan-18 | commented | Malformed closed-XML batches confirmed away. |
| 3472 | #3609 plan-21 | commented | One fail-closed settings.json document boundary across all writers. |
| 3470 | #3605 plan-17 | commented | Hook prelude cost; PATH-probe half duplicates #3519, plugin-root half distinct. |
| 3467 | #3606 plan-18 | commented | Empty observer turn preserving the claimed batch + empty-queue start gate. |
| 3466 | #3610 plan-22 | commented | Chroma writer-epoch stamp; explicitly does not close #3012. |
| 3460 | #3606 plan-18 | commented | Transport failure returned as prose confirming a batch; bundled into #3614. |
| 3458 | #2785 plan-12 | commented | Viewer session-ID display/filter/delete; large, user-visible delete path. |
| 3447 | #3603 plan-15 | commented | ECONNREFUSED string match dead on Bun and undici. |
| 3442 | #2785 plan-12 | commented | Eval harness; isolated under swebench/, cleanly mergeable. |

## Next-PR candidates
- #3472 plan-21 — the only PR building a single fail-closed settings-document boundary; #3518 and #3498 should rebase onto it.
- #3516 plan-18 — most complete window-aware context bounding; natural base for #3508 and #3479.
- #3476 plan-15 — implements the master's named "healthy but never ready" recycle, with 7-day-wedge evidence.
- #3494 plan-23 — best worked example of a host adapter failing silently against the real host.
- #3535 plan-16 — resolvePluginRoot() is the canonical-root primitive the cluster needs; #3470's plugin-root half should call it.

## Notes
- Near-misses left open: #3470 (only its PATH-prelude hunk duplicates #3519); #3547 vs #3676 (competing Kimi integrations, neither strictly supersedes).
- #3614 is an open bundle carrying #3519 and #3460 and states its sources stay open until it lands.
