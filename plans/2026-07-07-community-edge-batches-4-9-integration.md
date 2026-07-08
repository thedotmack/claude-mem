# Community Edge Batches 4-9 Integration Ledger

Base: `origin/community-edge` at `be4dc3b12ef0dc1e5e0258d6e1677bc35387a6e4`.

Source plan: issue #3139, Batches 4-9. The live-state inventory was refreshed on
2026-07-07: every Batch 4-9 PR was still open, unmerged, and not contained in
`community-edge` at the start of this branch.

## Integrated on this branch

### Batch 4

- #3060: preserve `CLAUDE_CODE_SKIP_BEDROCK_AUTH` and
  `CLAUDE_CODE_SKIP_VERTEX_AUTH` while continuing to strip broader Bedrock and
  Vertex routing flags.
- #2672: allow controlled proxy/custom CA passthrough from
  `~/.claude-mem/.env` only.
- #2629: strip Bedrock/Vertex/Mantle routing and Anthropic default model env
  from isolated worker subprocess environments.
- #2929: server runtime API-key persistence preserves Claude-Code-style
  top-level settings peers and creates the settings file with owner-only mode.
- #2957: bound Claude provider observer context with
  `CLAUDE_MEM_CLAUDE_MAX_TOKENS`; after a saved turn exceeds the cap, the SDK
  session is reset to a fresh start, `memorySessionId` is cleared, and telemetry
  reports the closed `context_bound` abort reason.

### Batch 5

- #3046: Windows version/path probes use explicit `cmd.exe /d /c` only for
  bare PATH commands, while absolute runtime paths spawn directly.
- #2937: remove stale `plugin/scripts/worker-cli.js` distribution shim and
  update tests/docs to reflect `worker-service.cjs` as the lifecycle entry.
- #2928: installer settings merges preserve top-level peers when
  `settings.json` uses `{ env: { ... }, hooks, permissions, ... }`.
- #3066: already contained by current branch. `CodexCliInstaller` installs the
  local Codex plugin cache with `codex plugin add claude-mem@claude-mem-local`
  after marketplace registration, no longer uses local marketplace upgrade, and
  install tests assert the marketplace plugin marker is written before Codex
  cache registration.
- #3102: already contained by current branch. `scripts/build-hooks.js` emits
  `plugin/sqlite/SessionStore.js` and `plugin/sqlite/observations/files.js`,
  `package.json` ships `plugin/sqlite`, tracked generated files are present,
  and plugin distribution tests guard the worker bundle closure.
- #3110: preserve install markers for Codex plugin roots by resolving durable
  marketplace roots to `plugin/.install-version` and `plugin/node_modules`,
  mirroring repair markers into the marketplace plugin, and guarding
  pre-`platform_source` SQLite tables during schema initialization.
- #3113: missing `.install-version` is checked before dependency install; the
  Setup hook force-clears/reinstalls stale `node_modules` and self-heals the
  marker only after a successful forced reinstall, preserving the actionable
  install hint on failure.
- #2918: already contained by current branch. Runtime install verifies and
  repairs the `tree-sitter-cli` executable after script-suppressed dependency
  install, `isInstallCurrent` rejects stale caches with missing CLI binaries,
  and smart-file-read resolves Windows `tree-sitter.exe` before falling back to
  bare `tree-sitter`.
- #2595: harden `scripts/sync-marketplace.cjs` with no-write dry runs, opt-in
  rsync delete, preserved user-config excludes, and dry-run-safe Bun install
  logging. The legacy bash sync script was already absent on this branch.
- #2597: superseded by the current npm-release runtime model. Build now
  generates and ships `plugin/bun.lock`, runtime setup installs from that
  lockfile and validates critical modules, Setup self-heals missing
  `node_modules`, and worker/MCP bundles forbid external zod requires where
  startup cannot rely on installed plugin dependencies. We intentionally do not
  ship `plugin/node_modules` in the npm tarball because the current dependency
  tree is hundreds of MB and contains platform-specific native artifacts.
- #2924: superseded by the current npx CLI package. The old standalone
  `installer/` package no longer exists on this branch; `package.json` publishes
  executable `dist/npx-cli/index.js` as the `claude-mem` bin, and
  `npx claude-mem uninstall` now owns plugin/registry/cache/data cleanup.

### Batch 6

- #3082: route compatible server-runtime MCP `search` calls through server
  observation search while keeping unsupported legacy filters on worker search.
- #3065: make MCP `tools/list` runtime-aware so worker mode hides
  server-runtime-only `observation_*` tools and server mode hides worker-only
  tools.
- #3044: add worker-runtime `memory_save` using the existing worker HTTP write
  path. Legacy aliases from the PR were intentionally not restored because the
  current server runtime exposes canonical `observation_*` tools.
- #3040: add validated `CLAUDE_MEM_OPENROUTER_EXTRA_BODY` support while blocking
  unsafe overrides of core request fields.
- #3001: add validated `CLAUDE_MEM_OPENROUTER_REASONING_EFFORT` support.
- #2940: switch the Chroma MCP uvx package spec from `chroma-mcp==0.2.6` to
  `chroma-mcp@0.2.6`.
- #2880: keep the uvx `--from <package-spec> chroma-mcp` invocation shape for
  older uv compatibility.
- #2920: prewarm Chroma MCP before connecting and treat signal-terminated
  prewarm children as connect failures.
- #2527: current edge already had the base-url resolver; this branch adds
  settings API persistence, viewer configuration, and non-localhost HTTPS
  validation for `CLAUDE_MEM_OPENROUTER_BASE_URL`.
- #2835: add `claude` as an alias for the Claude Code adapter/install path and
  CLI detection.
- #2826: write Antigravity MCP config to the shared Gemini config path used by
  current Antigravity integration.
- #2810: ignore Codex/internal system prompts before session creation.
- #3000: already contained by current branch. Antigravity CLI hooks route
  through `hook antigravity-cli`, use the shared Gemini config tree, register
  MCP via the shared helpers, and normalize Antigravity CLI payloads through the
  dedicated adapter.
- #3014/#2855: update the OpenCode plugin for the current contract by exporting
  the required `id: "claude-mem"` descriptor, reading tool args and
  `chat.message` session IDs from OpenCode input payloads, awaiting worker
  init/observation writes, passing the first user message as the session prompt,
  reading the worker port from settings when OpenCode has no inherited env, and
  registering the claude-mem MCP server during OpenCode install.
- #2731: integrate the separable corpus filter fixes. `build_corpus` now accepts
  the advertised `dateStart`/`dateEnd` camelCase filters, and corpus
  observation type filters route through `obs_type` instead of the search
  `type` discriminator.

### Batch 7

- #2943, #2927, #2901, #2857: classify short no-op / insufficient-data /
  skip-prose observer acknowledgements as benign `skip` output, clear stale
  invalid-output debt, and avoid poison respawn loops while preserving quota
  failure handling.
- #2828: add `CLAUDE_MEM_WORKER_AUTOSTART=false` to disable hook lazy-spawn.
- #2609: fail-loud worker-unreachable threshold warns and continues instead of
  blocking hook execution.
- #2598: hook PATH prelude prefers `printenv PATH` with shell fallback.
- #2997: Windows `.cmd` SDK spawns parse npm-style shims and spawn `node`
  directly when possible, with existing fallback preserved.
- #3033: centralize UTF-8 BOM stripping in `stripBom()` and use it across
  settings readers, including defaults loading, HTTP settings updates, path
  resolution, logger startup, plugin disabled-state checks, npx/server settings
  helpers, and the OpenCode plugin worker-port reader.
- #3009/#2980/#2895: reconcile stale worker-port cleanup. Port-in-use checks
  now probe real socket bindability on every platform, unhealthy bound ports
  attempt conservative reclaim only after proving the listener is claude-mem
  owned, and the default worker-unreachable fail-loud threshold is raised from
  3 to 10 to avoid multi-window paralysis during recovery.
- #2921: carry `windowsHide: true` through remaining live Windows spawn probes
  and launchers for cwd remap git probes, worktree adoption git probes, the MCP
  node launcher template, server runtime daemon launch, worker-to-server CLI
  launch, and current npx doctor/setup runtime probes. The old
  `src/npx-cli/utils/bun-resolver.ts` site from the PR no longer exists on this
  branch.
- #2917: make Claude Code SessionStart non-blocking on cold worker boot. The
  Claude hook contract now runs only the context hook at SessionStart, while
  context fallback calls use `allowLazySpawn: false` so a cold worker returns
  the empty SessionStart payload without spawning or accruing fail-loud debt.
  Codex SessionStart ordering remains unchanged.
- #2892/#2885: make worker outages non-blocking. The fail-loud threshold now
  emits diagnostics and telemetry without `exit 2`, degraded worker 5xx/429
  responses are treated as worker-unreachable fallbacks, and session-init/Stop
  fallbacks can surface a throttled offline banner. #2885's per-session
  disabled sentinel is superseded because non-blocking outages no longer
  create the Claude Stop-hook retry loop it was designed to cap.
- #2739: preserve the initial prompt while truncating Gemini/OpenRouter
  conversation history. The shared truncation helper applies message and token
  budgets while keeping newest context in chronological order, Gemini now has
  matching context-limit defaults, and both providers log truncation without
  dropping the init prompt.
- #2507: prefix Windows PowerShell hook commands with `& ` in Rule B
  installers. The original Gemini CLI site is now Antigravity CLI on this
  branch, so the fix is applied to Cursor, Windsurf, and Antigravity hook
  command generation.
- #2583: add the opt-in Claude Code PreCompact hook path. The distributed hook
  is installed but inert unless `CLAUDE_MEM_PRECOMPACT_ENABLED` is `true` or
  `1`; enabled hooks enqueue `pre-compact` summary work through the current
  in-RAM message buffer, tier routing treats it as summary work, and all
  providers route it through the summary prompt path.

### Batch 8

- #3002: fresh SQLite file databases enable `PRAGMA auto_vacuum = INCREMENTAL`
  before WAL/schema writes; legacy DBs are left unchanged when not safely fresh.
- #2849: primary SQLite connections consistently apply `PRAGMA busy_timeout =
  5000`.
- #3116: folder `CLAUDE.md` lookup uses project-relative paths and avoids
  creating/rewriting empty skeleton folder context.
- #3116/#3011-adjacent Chroma fallback: by-file hybrid search preserves exact
  metadata matches when Chroma ranks none or misses exact matches.
- #3011: recover semantic context when scoped Chroma metadata misses relevant
  adopted rows. `/api/context/semantic` now runs a bounded unscoped semantic
  retry for project-scoped requests, keeps platform-source scoping, merges
  direct and `merged_into_project` matches in relevance order, ignores keyword
  fallback retries, logs only query lengths, and uses an internal semantic
  hydration window without exposing a public `semanticLimit` knob.
- #2904: reclaim legacy prompt/session bloat. Maintenance version 38 normalizes
  oversized or wrapper-tagged `user_prompts`, clears completed/failed
  `sdk_sessions.user_prompt` only when first-prompt history exists for the same
  `session_db_id`, and runs best-effort page reclamation without failing
  startup. Version 38 avoids collisions with the existing v35-v37 migrations.
- #2883: cwd remap reconciliation reruns idempotently and backs up only when
  changes are needed.
- #2867: context refs can render display-only 8-char UUID prefixes when direct
  fetch-by-id is unavailable.
- #2942: observer Claude SDK spawns disable session persistence and avoid stale
  persisted session resumes.
- #2671: server-generated observations and summaries copy project metadata from
  `server_sessions.metadata.project`.
- #3047: monorepo subdirectories derive repo-relative project keys when the
  repository declares workspaces or contains nested package roots, while
  ordinary single-package repos keep the repo-root key. Explicit
  `.claude-mem.json` names still win, and unrelated ancestor worktree markers
  no longer override a real nested repo root.
- #2741: add opt-in observation filtering for subagents. The hook skips before
  worker/server dispatch when `CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS=true` or
  when `CLAUDE_MEM_SKIP_AGENT_TYPES` contains the exact `agentType`; worker HTTP
  ingest applies the same guard before queueing observations. Defaults preserve
  existing behavior, settings API validation rejects unsafe shapes, and the
  viewer exposes both controls under Advanced settings.
- #2770: stamp nullable `content_session_id` onto generated observation and
  summary rows at write time. This branch uses schema version 36 because version
  35 is already occupied; the migration adds/backfills indexed columns from
  linkable `sdk_sessions`, self-heals missing indexes, import paths preserve
  supplied content-session IDs, and the worker response processor passes the
  active `session.contentSessionId` through storage.
- #3114: add reversible observation dismiss. Schema version 37 creates the
  reserved `observation_feedback` table with self-healing indexes; dismissed
  observations are hidden from proactive file-context, SQLite search, and
  session-start context queries while remaining fetchable by id. Worker
  dismiss/undismiss endpoints and MCP tools are gated by
  `CLAUDE_MEM_ALLOW_DISMISS=false` by default.
- #2858: inject project `:dream` namespaces alongside raw project memory for
  SessionStart context. Dream observations and summaries are queried only when
  that namespace has context, dream rows are preferred when present, one raw
  observation is preserved when dream rows saturate the window, prior transcript
  selection skips dream rows, welcome-hint suppression now treats summaries as
  memory, and all paths preserve platform-source scoping plus dismissed
  observation filtering.
- #2506: port the source-level startup guidance and make-plan file-output
  behavior without the stale plan-file reshuffle. Agent context now nudges
  multi-step work toward ToolSearch-assisted mem-search, `/make-plan`, `/do`,
  and source-cited subagent fan-out while preserving display-only UUID ref
  behavior. The make-plan skill now requires writing plans to
  `plans/inbox/<YYYY-MM-DD>-<short-slug>.md` and creating kanban subfolders
  when absent.

### Batch 9

- #2608: add README i18n language-switcher coverage without regressing current
  README body content. All localized README switchers now include the English,
  Portugal Portuguese, Tagalog, and Nepali links and point Portugal Portuguese
  at the existing `docs/i18n/pt.md` file instead of the missing
  `README.pt.md`.

## Held or split from this tranche

- #2616: large opt-in auto-redaction feature; conflicts with prompt/runtime
  surfaces and should be integrated as a dedicated security feature.
- #2632: held because current `community-edge` has no `MigrationRunner`
  abstraction to integrate against without inventing new architecture.
- #2699: Windows canary branch overlaps heavily with multiple Batch 7 PRs; use
  as reference only, not as a wholesale merge.
- #2949, #2606: large storage backend architecture changes; require dedicated
  migration and operations review.
- #3063, #2627: large deduplication/queue behavior changes; require dedicated
  product and migration review.
- #2925: destructive viewer delete behavior; requires product/auth confirmation
  review.
- #3027, #2829: native auto-memory transfer/import story overlaps and needs one
  coherent migration path.
- #2737, #2827, #2665: competing project-name/environment models; require one
  chosen project identity design.
- #2833: transcript backfill can spend provider tokens; requires product and
  cost controls review.
- #2877: broad directory refactor; should not be mixed with behavior integration.
- #2731 UDS daemon pipeline and broad MCP documentation rewrite: held because
  the daemon is a new optional hook runtime and should be reviewed as a
  dedicated performance feature; the corpus data-loss fixes from this PR are
  integrated above.
- #3034/#2764: competing CLI-backed observation providers. #3034 explicitly
  supersedes #2764, but adding `agy-cli` as a generation provider is a new
  provider backend with auth/session semantics and should ship as a dedicated
  provider feature. The Antigravity CLI hook integration from #3000 is already
  contained on this branch.
- #2908: Kimi Code CLI is a new host integration with installer, plugin
  manifest, and hook dispatch surface. It should be reviewed as a dedicated
  integration instead of being mixed into the npm release reconciliation.
- #2623: DeepSeek backend support is superseded by the current OpenRouter
  custom base URL/model path, including DeepSeek-style URL tests. The i18n
  framework and prompt-overlap deduplication portions are broad product changes
  and should be split into dedicated PRs.
- #2523: Vertex AI for Gemini adds a new Google ADC dependency and cloud auth
  path. Hold for a dedicated provider-auth review rather than expanding this
  npm release branch.
- #2506 stale `plans/` file moves and generated bundles: held. Current branch
  has newer plan documents and generated assets; this tranche ports only the
  source/skill behavior and regenerates from the current tree.

## Still to integrate from Batches 4-9

Batch 4: complete.

Batch 5: complete.

Batch 6: complete.

Batch 7: complete.

Batch 8: #2905.

Batch 9: complete.

## Verification so far

- `bun test tests/supervisor/env-sanitizer.test.ts tests/env-isolation.test.ts tests/env-proxy-passthrough.test.ts`
- `bun test tests/sdk/output-classifier.test.ts tests/worker/agents/response-processor.test.ts tests/worker/poison-respawn.test.ts`
- `bun test tests/services/sync/chroma-mcp-manager-ssl.test.ts tests/services/sync/chroma-mcp-manager-singleton.test.ts`
- `bun test tests/servers/mcp-tool-schemas.test.ts tests/servers/mcp-runtime-tool-visibility.test.ts`
- `bun test tests/mcp-integrations.test.ts tests/servers/mcp-server-name-safety.test.ts`
- `bun test tests/shared/openrouter-request-settings.test.ts tests/shared/openrouter-base-url.test.ts tests/shared/settings-defaults-manager.test.ts`
- `bun test tests/services/sqlite/database-pragmas.test.ts tests/sqlite tests/services/sqlite`
- `npm run typecheck`
- `bun test tests/json-utils.test.ts tests/shared/settings-defaults-manager.test.ts tests/settings-routes-claude-token-validation.test.ts`
- `bun test tests/json-utils.test.ts tests/shared/settings-defaults-manager.test.ts tests/settings-routes-claude-token-validation.test.ts tests/install-settings-preservation.test.ts tests/infrastructure/plugin-distribution.test.ts tests/integrations/opencode-plugin-contract.test.ts`
- `bun run typecheck`
- `bun test tests/worker/truncate-history.test.ts tests/gemini_provider.test.ts tests/shared/openrouter-request-settings.test.ts tests/shared/settings-defaults-manager.test.ts tests/infrastructure/plugin-distribution.test.ts`
- `bun run typecheck`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
- `bun test tests/utils/project-name.test.ts tests/context/observation-compiler.test.ts tests/worker/http/routes/search-routes-welcome-hint.test.ts`
- `bun run typecheck`
- `bun test tests/hooks/file-context.test.ts tests/context/include-last-message-dot-path.test.ts tests/services/sqlite/observation-dismiss.test.ts tests/cli/handlers/context-mcp-session-start.test.ts tests/cli/adapters/codex-file-context.test.ts tests/transcripts/processor-codex-context.test.ts`
- `npm run build`
- `bun test tests/infrastructure/plugin-distribution.test.ts`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
- `bun test tests/context/formatters/agent-formatter.test.ts`
- `bun run typecheck`
- `npm run build`
- `bun test tests/infrastructure/plugin-distribution.test.ts`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
- `bun test tests/infrastructure/plugin-distribution.test.ts`
- `bun run typecheck`
- `bun run build`
- `git diff --check`
- `bun test tests/infrastructure/plugin-distribution.test.ts tests/cli/hook-io.test.ts tests/cli/hook-stream-discipline.test.ts tests/services/worker/session-message-buffer.test.ts tests/gemini_provider.test.ts tests/shared/openrouter-request-settings.test.ts tests/worker/codex-provider.test.ts`
- `bun run typecheck`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
- `bun test tests/utils/project-name.test.ts tests/infrastructure/plugin-distribution.test.ts`
- `bun run typecheck`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
- `git diff --check`
- custom Node README switcher validation: validated 35 switchers and 1224
  local links
- `bun run build`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
- `bun test tests/services/sqlite/session-store-maintenance.test.ts tests/session_store.test.ts tests/shared/settings-defaults-manager.test.ts tests/services/sqlite/database-pragmas.test.ts tests/sqlite/session-store-migrations.test.ts`
- `bun run typecheck`
- `bun run build`
- `bun test tests/services/sqlite/session-store-maintenance.test.ts tests/session_store.test.ts tests/services/sqlite/database-pragmas.test.ts tests/sqlite/session-store-migrations.test.ts tests/infrastructure/plugin-distribution.test.ts`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
- `bun test tests/worker/search-manager-semantic-limit.test.ts tests/worker/http/routes/search-routes-semantic-context.test.ts tests/worker/chroma-sync-query-logging.test.ts tests/services/sqlite/get-observations-by-ids-relevance.test.ts`
- `bun run typecheck`
- `bun run build`
- `bun test tests/worker/search-manager-semantic-limit.test.ts tests/worker/http/routes/search-routes-semantic-context.test.ts tests/worker/chroma-sync-query-logging.test.ts tests/services/sqlite/get-observations-by-ids-relevance.test.ts tests/infrastructure/plugin-distribution.test.ts`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
- `bun test tests/sqlite/session-store-migrations.test.ts tests/sqlite/session-store-observations.test.ts tests/sqlite/session-store-summaries.test.ts tests/sqlite/session-store-transactions.test.ts tests/worker/agents/response-processor.test.ts tests/worker/http/routes/data-routes-import-platform.test.ts tests/infrastructure/plugin-distribution.test.ts`
- `bun run typecheck`
- `bun run build`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
- `bun test tests/shared/should-skip-agent-observation.test.ts tests/cli/handlers/observation-subagent-skip.test.ts tests/cli/handlers/summarize-subagent-skip.test.ts tests/shared/settings-defaults-manager.test.ts tests/settings-routes-claude-token-validation.test.ts`
- `bun test tests/infrastructure/plugin-distribution.test.ts`
- `bun run typecheck`
- `bun run build`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
- `bun test tests/shared/worker-autostart-flag.test.ts tests/cli/hook-stream-discipline.test.ts tests/cli/handlers/session-init-server-beta-context.test.ts tests/cli/handlers/summarize-subagent-skip.test.ts`
- `bun test tests/shared/worker-autostart-flag.test.ts tests/cli/hook-stream-discipline.test.ts tests/cli/handlers/session-init-server-beta-context.test.ts tests/cli/handlers/summarize-subagent-skip.test.ts tests/infrastructure/plugin-distribution.test.ts`
- `bun run typecheck`
- `bun run build`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
- `bun test tests/infrastructure/plugin-distribution.test.ts tests/shared/worker-autostart-flag.test.ts tests/shared/worker-utils-version-recycle.test.ts tests/cli/handlers/session-init-server-beta-context.test.ts`
- `bun run typecheck`
- `bun run build`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
- `bun test tests/infrastructure/windows-hide-regressions.test.ts tests/infrastructure/plugin-distribution.test.ts tests/infrastructure/process-manager.test.ts`
- `bun run typecheck`
- `bun run build`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
- `bun test tests/cli/kiro-never-block.test.ts tests/shared/worker-autostart-flag.test.ts tests/infrastructure/health-monitor.test.ts tests/services/worker-spawner-stale-socket.test.ts tests/services/worker-spawner.test.ts tests/infrastructure/process-manager.test.ts`
- `bun test tests/infrastructure/plugin-distribution.test.ts tests/cli/kiro-never-block.test.ts tests/shared/worker-autostart-flag.test.ts tests/infrastructure/health-monitor.test.ts tests/services/worker-spawner-stale-socket.test.ts tests/services/worker-spawner.test.ts tests/infrastructure/process-manager.test.ts`
- `bun run typecheck`
- `bun run build`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
- `bun test tests/services/sqlite/observation-dismiss.test.ts tests/worker/http/routes/data-routes-dismiss.test.ts tests/servers/mcp-dismiss-tools.test.ts tests/sqlite/session-store-migrations.test.ts tests/settings-routes-claude-token-validation.test.ts tests/worker/http/routes/data-routes-platform-scoping.test.ts tests/worker/http/routes/data-routes-import-platform.test.ts`
- `bun run typecheck`
- `bun run build`
- `bun test tests/services/sqlite/observation-dismiss.test.ts tests/worker/http/routes/data-routes-dismiss.test.ts tests/servers/mcp-dismiss-tools.test.ts tests/sqlite/session-store-migrations.test.ts tests/settings-routes-claude-token-validation.test.ts tests/worker/http/routes/data-routes-platform-scoping.test.ts tests/worker/http/routes/data-routes-import-platform.test.ts tests/infrastructure/plugin-distribution.test.ts`
- `bun run lint:hook-io`
- `bun run lint:spawn-env`
- `git diff --check`
