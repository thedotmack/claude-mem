# Phase 12: Feature PRs — Evaluation & Decision

These are feature PRs that need product/architectural decisions. Each should be evaluated against the project roadmap and YAGNI principles.

## Provider Integrations

Multiple community members want to add provider support. Evaluate whether the project should support more providers or focus on stability.

- [x] Evaluate PR #808 (`feat: Add AnthropicAPIAgent for direct API observation processing` by @MrSaneApps, 4 files). **CLOSED.** Memory concerns (the core motivation) were already addressed by merged PR #806. Having two Anthropic providers (SDK + direct API) creates user confusion and maintenance burden. Claude SDK via CLI auth remains the recommended path. Closed with detailed explanation thanking the contributor.

- [x] Evaluate PR #786 (`feat: add GLM provider and custom Anthropic-compatible API support` by @Zorglub4242, 13 files). **CLOSED.** Three issues: (1) `process.env` mutation is a concurrency bug — env vars leak between sessions since the worker handles multiple sessions on one process. (2) GLM preset is YAGNI — a generic custom provider option would cover GLM users without a dedicated preset. (3) Custom Anthropic-compatible API support is a good concept but needs subprocess-scoped env vars, not global mutation. Invited contributor to re-submit a focused custom-provider-only PR.

- [x] Evaluate PR #644 (`feat: Add OpenAI provider support` by @niteeshm, 10 files). **CLOSED.** OpenAI models are already accessible via the OpenRouter provider, which uses the same OpenAI-compatible chat/completions API format. Adding a dedicated OpenAI agent (491 lines) would create significant code duplication with OpenRouterAgent. A community commenter (@kiwina) independently flagged the same overlap. Suggested contributor could instead PR a configurable base URL for OpenRouter to support Azure/custom endpoints.

- [x] Evaluate PR #680 (`feat(openrouter): multi-model configuration with automatic fallback` by @RyderFreeman4Logos, 28 files). **CLOSED.** Three issues: (1) Bundles 5+ distinct features (multi-model fallback, provider fallback chain, configurable base URL, settings hot-reload, Gemini 3 default) into one PR — each should be separate. (2) Deletes content from 12+ CLAUDE.md documentation files (~1,200 lines of project docs removed), which is destructive and unrelated to the feature. (3) Multi-model fallback is YAGNI — most users configure a single model. Invited contributor to re-submit a focused configurable-base-URL-only PR.

- [x] Evaluate PR #746 (`feat: add OpenCode platform support` by @MattMagg, 12 files). **CLOSED — resubmit requested.** Platform-agnostic support IS a goal (the adapter architecture was designed for it), and the core adapter code (26 lines) is clean and follows the Cursor adapter pattern. However, the PR includes build artifacts (worker-service.cjs, mcp-server.cjs), planning scratch docs committed to root, a settings.json whitespace change, and an `.opencode/` plugin directory with maintenance implications. Requested a focused re-submission with just the adapter source, router change, README update, and docs.

- [x] Evaluate PR #860 (`feat: add Clawdbot/moltbot environment detection and compatibility mode` by @janitooor, 3 files). **CLOSED.** Three issues: (1) YAGNI — no evidence of user demand for Clawdbot compatibility, and the PR was a bot-generated "autonomous contribution by Legba." (2) Dead code — the detection utilities are standalone and never integrated into any hook, service, or handler. (3) Documentation references non-existent API endpoints and settings. If real conflicts surface from user reports, a focused, integrated fix would be welcome.

## Memory Features

- [x] Evaluate PR #662 (`feat(mcp): add save_memory tool for manual memory storage` by @darconada, 8 files). **MERGED (cherry-picked to main).** Manual memory storage aligns with the project philosophy — automatic capture handles 80% of cases, manual save handles the 20% where users want explicit control (Issue #645). Source changes applied directly (PR had merge conflicts in compiled .cjs build artifacts only). Implementation is clean: MCP tool definition, POST /api/memory/save endpoint via MemoryRoutes.ts, getOrCreateManualSession() in SessionStore, README updates. Minor fix: changed logger component from unregistered 'MEMORY' to 'HTTP'/'CHROMA'. Closes #645.

- [ ] Evaluate PR #920 (`feat: add project exclusion setting` by @Spunky84, 7 files) and PR #699 (`feat: add folder exclude setting for CLAUDE.md generation` by @leepokai, 2 files). Both add exclusion settings but at different levels (project vs. folder). Decision: (1) Is exclusion needed? Users do complain about CLAUDE.md pollution. (2) PR #699 is smaller (2 files) and more focused. Prefer #699 if only one is needed. If both levels are useful, merge both.

## Architectural Changes

- [ ] Evaluate PR #660 (`feat: add network mode for multi-agent deployments` by @nycterent, 42 files). Major feature adding network mode. Decision: Is multi-agent support on the roadmap? 42 files is significant. If not on roadmap: `gh pr close 660 --comment "This is an interesting concept but not on the current roadmap. We're focused on single-agent stability. We'll revisit multi-agent support in a future major version. Thank you for the contribution!"`

- [ ] Evaluate PR #968 (`Migrate from SQLite to memU hierarchical memory backend` by @minhlucvan, 55 files). Complete database migration. Decision: Almost certainly close — this replaces the core database with an external dependency. Run: `gh pr close 968 --comment "Thank you for the contribution! SQLite is a core architectural choice for claude-mem (zero-dependency, portable, proven). Migrating to a different backend would be a fundamental architecture change we're not planning. If you've built memU as an alternative memory system, that's great as a separate project!"`

- [ ] Evaluate PR #854 (`feat: Pro cloud sync integration with Supabase + Pinecone` by @bigph00t, 35 files). Cloud sync for Pro features. Decision: Is this aligned with the Pro features roadmap described in CLAUDE.md? If yes and from a trusted contributor: review carefully and merge. If premature: hold for later.

## Owner's PRs

- [ ] Review PR #863 (`feat: implement ragtime email investigation with self-iteration and cleanup` by @thedotmack, 2 files). Owner's PR — review and merge if ready.

- [ ] Review PR #657 (`feat: add generate/clean CLI commands with cross-platform support` by @thedotmack, 100 files). Owner's PR, large changeset. Review and merge if ready. May need rebase on current main.
