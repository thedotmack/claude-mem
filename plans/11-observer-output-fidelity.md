# [plan-11] Observer / Summarizer Output Fidelity & Resilience — trust what the agent emits, or recover

## Defect

claude-mem's quality depends on the observer/summarizer emitting **truthful, parseable** output, but nothing enforces either property. Two failure modes anchor this plan. First, the observer SDK sometimes returns conversational prose, an empty string, or a "session exhausted" closure string instead of `<observation>` XML; the parser silently drops the entire batch and observations stay at zero, with no recovery and no signal. Second, the summarizer can confabulate — inventing cross-session narrative and fabricating a nonexistent git commit hash — while keeping `files_modified` accurate, which poisons every future context injection that trusts it.

This is distinct from plan-05 (which governs the observer's *tool permissions*, not whether its emitted text is parseable or true). The architectural fix is an **output-fidelity contract**: classify the observer's output (valid XML vs idle-empty vs prose vs poisoned session), recover by killing and respawning a poisoned SDK session while preserving pending work, and run a cheap verification pass that cross-checks generated claims (e.g. commit hashes) against ground truth before persisting.

## Children

- #2485 — observer SDK returns prose / empty / closure strings; parser drops all batches → observations stay 0, no recovery
- #2574 — summarizer hallucinates cross-session content and fabricates a nonexistent commit hash (`files_modified` correct), poisoning future injection

## Fix sequence

1. **Classify, don't silently drop:** split the observer's non-XML output into idle-empty vs prose vs poisoned-session; attach a preview to diagnostics so dropped batches are visible, not silent (#2485).
2. **Recover from poison:** after N consecutive invalid outputs, kill and respawn the SDK session while preserving pending messages, so a poisoned session can't wedge the pipeline at zero (#2485).
3. **Verify before persist:** cross-check generated claims against ground truth — validate any emitted commit hash with `git cat-file -e`, and reconcile `title`/`narrative` against `files_modified`; log input-context provenance so confabulation is traceable (#2574).

## Test matrix

| Observer output | Required behavior |
|---|---|
| valid `<observation>` XML | parsed + persisted |
| empty (idle) | classified idle; no error, no respawn churn |
| conversational prose | classified prose; preview logged; not persisted as observation |
| "session exhausted" closure | classified poisoned; session killed + respawned; pending preserved |
| fabricated commit hash | `git cat-file -e` fails → claim rejected/flagged, not persisted |

The matrix lives in CI. An output-fidelity regression must fail CI before a user can file.

## Out of scope

- Observer SDK tool permissions / security enforcement → plan-05.
- Worker process supervision / restart loops → plan-03.
- Write-path / persistence schema correctness → plan-09.
