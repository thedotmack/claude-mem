# [plan-11] Observer / Summarizer Output Fidelity & Resilience — trust what the agent emits, or recover

## Defect

claude-mem's quality depends on the observer/summarizer emitting truthful, parseable output, but nothing enforces either property. The observer SDK sometimes never receives tool *results* (only the calls) and then poisons; it poison-loops on prose like "No observations to record"; and provider history truncation (OpenRouter/Gemini) can drop the init prompt and the XML-output instructions, so the model emits non-XML and the parser silently drops the batch — observations stay at zero with no recovery and no signal. The fix is an output-fidelity contract: classify the observer's output (valid XML / idle-empty / prose / poisoned), recover by killing and respawning a poisoned session while preserving pending work, and protect the init/XML instructions from truncation.

## Children

- #2758 — Observations never generate — observer SDK gets tool calls but not tool results, then poisons (v13.4.0)
- #2749 — Regression (v13.4.0, Windows): observer poison-loops on 'No observations to record' prose
- #2738 — OpenRouter/Gemini history truncation can drop the init prompt and XML-output instructions

## Fix sequence

Design doc: `plans/11-observer-output-fidelity.md`. Ensure tool results reach the observer; classify output and treat idle-empty/prose as non-fatal; respawn poisoned sessions preserving pending work; pin init + XML-instruction messages so truncation cannot drop them.

## Test matrix

| Input | Required behavior |
|---|---|
| idle batch | classified idle-empty, not poison |
| prose "no observations" | no poison loop |
| truncating provider | XML instructions retained; output parses |
| missing tool results | detected; session recovered |

## Out of scope

Tool *permissions* of the observer (plan-05, shipped); write-path persistence (plan-09).
