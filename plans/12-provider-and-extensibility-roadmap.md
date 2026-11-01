<!-- Mirror of GitHub issue #2785. The issue is the public tracker; this doc is the design.
     If the two drift, the doc is canonical for design and the issue for status (oh-my-issues health check). -->

> **Tracker:** https://github.com/thedotmack/claude-mem/issues/2785

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


---

## Round: 2026-09-12 oh-my-issues

Three net-new capability requests routed into this roadmap and closed as children:

- **#4060** — FTS5 over `tool_uses.tool_input` + `tool_uses.tool_response`, exposed through `search`/`smart_search` as an optional deeper tier queried only when observation-level search comes up empty. Must share plan-25 (#3982) 's tokenizer answer rather than fork a second one.
- **#3833** — prompt caching (`cache_control: {type: "ephemeral"}`) on the stable system prefix of observer/compression calls. Provider-neutral with a safe no-cache fallback; never on the per-observation turn. Proof is cached-vs-uncached input tokens plus a byte-identical request body for a non-caching provider.
- **#3845** — Brainbeats: POST a matching observation as a brief to a configurable Grok Bot webhook, reusing `TelegramNotifier` and the existing trigger-type/concept matching. No second rules engine; a failed POST must not break ingest. Open-source engine only (not `claude-mem-pro`). PR #3846 is on this.
