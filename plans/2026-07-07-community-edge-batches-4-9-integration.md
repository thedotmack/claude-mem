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

### Batch 8

- #3002: fresh SQLite file databases enable `PRAGMA auto_vacuum = INCREMENTAL`
  before WAL/schema writes; legacy DBs are left unchanged when not safely fresh.
- #2849: primary SQLite connections consistently apply `PRAGMA busy_timeout =
  5000`.
- #3116: folder `CLAUDE.md` lookup uses project-relative paths and avoids
  creating/rewriting empty skeleton folder context.
- #3116/#3011-adjacent Chroma fallback: by-file hybrid search preserves exact
  metadata matches when Chroma ranks none or misses exact matches.
- #2883: cwd remap reconciliation reruns idempotently and backs up only when
  changes are needed.
- #2867: context refs can render display-only 8-char UUID prefixes when direct
  fetch-by-id is unavailable.
- #2942: observer Claude SDK spawns disable session persistence and avoid stale
  persisted session resumes.
- #2671: server-generated observations and summaries copy project metadata from
  `server_sessions.metadata.project`.

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

## Still to integrate from Batches 4-9

Batch 4: complete.

Batch 5: complete.

Batch 6: complete.

Batch 7: #2917, #2892, #2885, #2739, #2583,
#2507.

Batch 8: #3114, #3047, #3011, #2905, #2904, #2858, #2770, #2741, #2506.

Batch 9: #2608.

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
