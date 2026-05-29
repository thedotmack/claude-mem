# [plan-12] Provider & Extensibility Roadmap — net-new capabilities, not defects

## Why this plan exists

Plans 01–11 closed the *defect* backlog: every "it silently does the wrong thing" bug
across hooks, spawning, worker lifecycle, install, observer security, env isolation,
server runtime GA, OpenCode capture, data-pipeline integrity, build hygiene, and
observer output fidelity is now fixed, tested, and gated in CI.

What remains in the tracker is a different class: **feature requests** — net-new
capabilities the product does not yet have and that nothing is currently doing
*wrong*. They were intentionally kept open through triage rather than force-folded
into a defect plan. This plan is the single master that routes them, so the backlog
reflects "planned roadmap" instead of "untriaged pile." Each item below is
independently shippable; an executing agent can `/do` one at a time.

Note: the OpenAI-compatible base-URL cluster (#2382 OpenRouter base URL, #2590 custom
provider base URL, #2622 DeepSeek, #2393 LM Studio model inheritance) was **already
implemented** — a single configurable `CLAUDE_MEM_OPENROUTER_BASE_URL` turned the
OpenRouter provider into a generic OpenAI-compatible client. Those four are closed.
Vertex (#2522) is the only provider request that survives here because it needs a
different auth/transport, not just a base URL.

## Children

### Providers
- #2522 — Vertex AI support for the Gemini provider (GCP service-account / ADC auth +
  Vertex endpoint; distinct from the OpenAI-compatible base-URL path which is done).

### Ingestion & filtering
- #2690 — backfill / ingest existing Claude Code session JSONL files (one-time import
  of pre-claude-mem history into the observations pipeline).
- #2498 — incremental scan skill for changes made outside a Claude session.
- #2463 — `tool_response`-level filter (file-extension / size / content heuristic) to
  prevent Read-of-binary / Read-of-playwright-residual blowups.
- #2423 — per-directory disable support (finer-grained than project exclusion).

### Observability & introspection
- #2566 — MCP grammar-introspection routes + worker provider retry telemetry + audit log.
- #2513 — clarify logger audit policy and codify the CI behavior around it.

### UX / semantics
- #2645 — i18n support for startup UI labels.
- #2467 — PreToolUse:Read context injection encourages the LLM to treat Read as a turn
  boundary in connected tool sequences (a product/semantics decision: should
  PreToolUse:Read inject at all, or only annotate?). Deferred from plan-01 because it
  is a behavior-design call, not an IO-discipline defect.

## Suggested execution order (independent; pick by value)

1. **#2463 tool_response filter** — small, high daily value, prevents real blowups.
   Extends the existing truncation in the observation path with extension/size guards.
2. **#2423 per-directory disable** — thin addition over the existing
   `CLAUDE_MEM_EXCLUDED_PROJECTS` / `shouldTrackProject` machinery.
3. **#2690 backfill ingest** — a CLI/skill that walks `~/.claude/projects/**.jsonl` and
   replays them through the observation pipeline (reuse the transcript parser).
4. **#2566 retry telemetry + audit log** — partially seeded: plan-05 already added an
   observer tool-attempt audit log; extend with provider retry counters + MCP
   grammar-introspection routes.
5. **#2522 Vertex** — new auth/transport branch on GeminiProvider; largest provider lift.
6. **#2498 incremental scan**, **#2645 i18n**, **#2513 logger audit policy**,
   **#2467 Read-as-turn-boundary** — schedule by demand.

## Out of scope

- Anything already shipped in plans 01–11 (defects).
- The OpenAI-compatible base-URL cluster (#2382/#2590/#2622/#2393) — done.

## Non-actionable tracker/meta issues (handle separately, not part of this plan)

- #2601 — tracking issue for "8 PRs ready for review"; superseded by the consolidated
  branch work in plans 01–11. Close once that branch merges.
- #2646 — "Are we really sure claude-mem works with Claude Code?" — a question, not a
  defect; answer in-thread (the green CI suite + lifecycle tests are the evidence).
- #2418 — "Enable OpenHarness integration / allow PR from fork" — repo-policy/CI config,
  not a code change in this tree.
