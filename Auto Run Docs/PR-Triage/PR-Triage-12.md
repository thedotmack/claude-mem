# Phase 12: Feature PRs — Evaluation & Decision

These are feature PRs that need product/architectural decisions. Each should be evaluated against the project roadmap and YAGNI principles.

## Provider Integrations

Multiple community members want to add provider support. Evaluate whether the project should support more providers or focus on stability.

- [x] Evaluate PR #808 (`feat: Add AnthropicAPIAgent for direct API observation processing` by @MrSaneApps, 4 files). **CLOSED.** Memory concerns (the core motivation) were already addressed by merged PR #806. Having two Anthropic providers (SDK + direct API) creates user confusion and maintenance burden. Claude SDK via CLI auth remains the recommended path. Closed with detailed explanation thanking the contributor.

- [x] Evaluate PR #786 (`feat: add GLM provider and custom Anthropic-compatible API support` by @Zorglub4242, 13 files). **CLOSED.** Three issues: (1) `process.env` mutation is a concurrency bug — env vars leak between sessions since the worker handles multiple sessions on one process. (2) GLM preset is YAGNI — a generic custom provider option would cover GLM users without a dedicated preset. (3) Custom Anthropic-compatible API support is a good concept but needs subprocess-scoped env vars, not global mutation. Invited contributor to re-submit a focused custom-provider-only PR.

- [ ] Evaluate PR #644 (`feat: Add OpenAI provider support` by @niteeshm, 10 files). OpenAI as an alternative provider. Decision: How many providers should the project support? Currently: Claude SDK, Gemini, OpenRouter. Adding OpenAI directly may duplicate OpenRouter (which already supports OpenAI models). If OpenRouter covers this: `gh pr close 644 --comment "OpenAI models are accessible via the OpenRouter provider. We'd prefer to keep the provider count manageable. Thank you!"`

- [ ] Evaluate PR #680 (`feat(openrouter): multi-model configuration with automatic fallback` by @RyderFreeman4Logos, 28 files). Large PR adding multi-model fallback to OpenRouter. Decision: Is multi-model fallback needed now? 28 files is a large surface area. If too complex: request scope reduction.

- [ ] Evaluate PR #746 (`feat: add OpenCode platform support` by @MattMagg, 12 files). OpenCode is another AI coding tool. Decision: Is platform-agnostic support a goal?

- [ ] Evaluate PR #860 (`feat: add Clawdbot/moltbot environment detection and compatibility mode` by @janitooor, 3 files). Small change for Clawdbot compatibility. If non-invasive (3 files), likely safe to merge.

## Memory Features

- [ ] Evaluate PR #662 (`feat(mcp): add save_memory tool for manual memory storage` by @darconada, 8 files). Allows users to manually save memories via MCP tool. This is a commonly requested feature. Decision: Does manual memory storage align with the project's automatic capture philosophy? If yes: review and merge. If the project prefers automatic-only: close with explanation.

- [ ] Evaluate PR #920 (`feat: add project exclusion setting` by @Spunky84, 7 files) and PR #699 (`feat: add folder exclude setting for CLAUDE.md generation` by @leepokai, 2 files). Both add exclusion settings but at different levels (project vs. folder). Decision: (1) Is exclusion needed? Users do complain about CLAUDE.md pollution. (2) PR #699 is smaller (2 files) and more focused. Prefer #699 if only one is needed. If both levels are useful, merge both.

## Architectural Changes

- [ ] Evaluate PR #660 (`feat: add network mode for multi-agent deployments` by @nycterent, 42 files). Major feature adding network mode. Decision: Is multi-agent support on the roadmap? 42 files is significant. If not on roadmap: `gh pr close 660 --comment "This is an interesting concept but not on the current roadmap. We're focused on single-agent stability. We'll revisit multi-agent support in a future major version. Thank you for the contribution!"`

- [ ] Evaluate PR #968 (`Migrate from SQLite to memU hierarchical memory backend` by @minhlucvan, 55 files). Complete database migration. Decision: Almost certainly close — this replaces the core database with an external dependency. Run: `gh pr close 968 --comment "Thank you for the contribution! SQLite is a core architectural choice for claude-mem (zero-dependency, portable, proven). Migrating to a different backend would be a fundamental architecture change we're not planning. If you've built memU as an alternative memory system, that's great as a separate project!"`

- [ ] Evaluate PR #854 (`feat: Pro cloud sync integration with Supabase + Pinecone` by @bigph00t, 35 files). Cloud sync for Pro features. Decision: Is this aligned with the Pro features roadmap described in CLAUDE.md? If yes and from a trusted contributor: review carefully and merge. If premature: hold for later.

## Owner's PRs

- [ ] Review PR #863 (`feat: implement ragtime email investigation with self-iteration and cleanup` by @thedotmack, 2 files). Owner's PR — review and merge if ready.

- [ ] Review PR #657 (`feat: add generate/clean CLI commands with cross-platform support` by @thedotmack, 100 files). Owner's PR, large changeset. Review and merge if ready. May need rebase on current main.
