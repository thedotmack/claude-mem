# [plan-12] Provider & Extensibility Roadmap — net-new capabilities, not defects

## Defect

This is a roadmap master, not a defect cluster: it aggregates net-new capabilities across providers, ingestion/filtering, observability, auth, and UX so they ship as coherent slices rather than one-off PRs.

## Children

### Providers & auth
- #2522 — Vertex AI support for the Gemini provider (GCP service-account / ADC + Vertex endpoint)
- #2704 — auth-helper command for refreshable gateway tokens (apiKeyHelper equivalent)

### Ingestion & filtering
- #2690 — backfill / ingest existing Claude Code session JSONL files
- #2498 — incremental scan skill for changes made outside a Claude session
- #2463 — `tool_response`-level filter (extension / size / content heuristic) to prevent binary/Playwright blowups
- #2423 — per-directory disable support
- #2711 — option to write worktree observations to the parent project
- #2736 — skip / throttle subagent observations (Dynamic Workflow `workflow-subagent`) — re-raise of #2303

### Observability & logging
- #2566 — MCP grammar-introspection routes + worker provider retry telemetry + audit log
- #2513 — clarify logger audit policy and codify CI behavior
- #2702 — logging cleanup: type-safe Component union, dead-log removal, noise reduction

### UX / semantics / extensibility
- #2645 — i18n support for startup UI labels
- #2467 — PreToolUse:Read injection treated as a turn boundary in connected tool sequences (semantics call)
- #2418 — enable OpenHarness integration / allow PR from fork

## Fix sequence

Design doc: `plans/12-provider-and-extensibility-roadmap.md`. Ship per sub-area as independent slices; each slice carries its own tests. No single PR closes this master — it closes when its sub-areas land.

## Out of scope

All defect clusters (plan-01..11, plan-13).
