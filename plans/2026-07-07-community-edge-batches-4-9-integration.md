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

### Batch 7

- #2943, #2927, #2901, #2857: classify short no-op / insufficient-data /
  skip-prose observer acknowledgements as benign `skip` output, clear stale
  invalid-output debt, and avoid poison respawn loops while preserving quota
  failure handling.

### Batch 8

- #3002: fresh SQLite file databases enable `PRAGMA auto_vacuum = INCREMENTAL`
  before WAL/schema writes; legacy DBs are left unchanged when not safely fresh.
- #2849: primary SQLite connections consistently apply `PRAGMA busy_timeout =
  5000`.

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

## Still to integrate from Batches 4-9

Batch 4: #2957, #2929.

Batch 5: #3113, #3110, #3102, #3066, #3046, #2937, #2928, #2924, #2918, #2597,
#2595.

Batch 6: #3034, #3014, #3000, #2908, #2855, #2835, #2826, #2810, #2764, #2731,
#2623, #2523.

Batch 7: #3033, #3009, #2997, #2980, #2921, #2917, #2895, #2892, #2885, #2828,
#2739, #2609, #2598, #2583, #2507.

Batch 8: #3116, #3114, #3047, #3011, #2942, #2905, #2904, #2883, #2867, #2858,
#2770, #2741, #2671, #2506.

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
