# Ponytail Audit — Master Remediation Plan (repo-wide)

**Single source of truth for the whole over-engineering audit of `claude-mem`.** Built to be executed
from a fresh `/clear`ed session: every slice below is self-contained — its own findings, exact
`path:line`, pre-delete verify greps, and a build/test gate — so an orchestrating session can fan out
one subagent per slice (or run them sequentially) without needing this conversation's context.

Audit scope: ~70k LOC TypeScript. Total identified: **~−9,800 lines, 0 npm deps removable** (every bit
of fat is first-party duplication / dead code — no package is fully droppable; `tree-kill`, the
tree-sitter grammars, express, bullmq all earn their place).

---

## How to orchestrate this (fresh session)

1. **Pick a slice.** Slices are independent — no cross-slice ordering required except: do **Slice 1
   (SQLite)** as its own focused effort (it's the most data-shaped), and it has a detailed companion
   doc. The rest can run in parallel as subagents or one at a time.
2. **Per slice, per finding: verify before you cut.** Run the finding's pre-delete grep. If a
   "dead/zero-caller" claim no longer holds (live caller appears), DOWNGRADE or skip it — do not delete
   on assumption. This is non-negotiable; the audit agents already caught several false "dead" claims
   (recorded in each slice's *Risks / do-NOT-touch*).
3. **Verify gate after each slice:** the slice's grep sweep returns clean → `bunx tsc --noEmit` clean →
   `bun test <relevant paths>` green. Then `npm run build-and-sync` and confirm the worker boots before
   moving on.
4. **Commit per slice** (branch first if on `main`). One slice = one reviewable diff.

## Ground rules (the ponytail lens)

- **Rung 1 first — "why does this exist?"** For each non-trivial item the question isn't only "can we
  dedupe it" but "should it exist at all." Some items resolve to *delete*; some to *it earns its place,
  simplify*. The slices mark which.
- **Every deletion is caller-verified** at execution time via the embedded grep. Migration/data paths
  get extra care (seed + re-migrate tests).
- **`shrink`/refactor items are not deletions** — they preserve behavior. Keep the behavior, cut the
  lines. The `stdlib`/`native` swaps must preserve edge-case correctness (lazy ≠ flimsier algorithm).
- **Respect the do-NOT-touch lists.** They are load-bearing things that *look* deletable.

## Status of work already done

- **Slice 0 — commit-verification removal: ✅ DONE** (executed in the planning session, verified:
  `tsc` clean, telemetry tests green). The working tree already has this applied. If you want a
  from-zero baseline for orchestration, `git` can revert it and re-run as a slice; otherwise treat it
  as verify-only. What it removed: `src/sdk/commit-verification.ts` + its 2 tests, the verify-before-
  persist block + `stripFabricatedHashesFromSummary` in `ResponseProcessor.ts`, and the now-dead
  `fabricated_count`/`fabrication_*` telemetry plumbing in `buffer.ts`/`scrub.ts`/`npx-cli telemetry.ts`.
  Consequence accepted: the PostHog "Fabrication Rate" tile goes dark (it had no other producer).
  Rationale: an extreme edge case whose second-system effects (greedy hex regex false-positives +
  compensating scaffolding) cost more than the ~3.5%-of-sessions it caught.

## Slice 1 — SQLite duplicate stack + test rewrite → see companion doc

The largest and most data-shaped slice has its own fully-detailed plan:
**`plans/2026-06-20-sqlite-duplicate-stack-removal.md`** (7 phases). Summary: delete the dead
`ClaudeMemDatabase`/`MigrationRunner` migration engine + the parallel free-function CRUD API that only
tests used; delete the old tests coupled to it and write fresh ones against `SessionStore` (the path
the worker actually runs); remove the two dead `SessionStore` methods. Net ~−3,200 src + ~−1,340 test
lines. Execute that doc as Slice 1.

---

# Slices 2–7 (verified against the current tree by the audit agents)

All verified. Final notes:
- `flush`/`resetCache` — zero callers in src AND tests. Dead. The `dirty` flag is only mutated (lines 53, 73, 80, 90) and read only inside the dead `flush` (line 85). Since `bump`/`replace` call `persist()` eagerly (lines 74, 81), `dirty` is always reset to false before `flush` could ever observe it true. Confirmed dead.
- `execAsync` is still used by `detectClaudeCode` (line 491) — but it's also imported once and used elsewhere? Count is 2: the `promisify(exec)` definition and the one use inside `detectClaudeCode`. So removing `detectClaudeCode` makes `execAsync` + the `exec`/`promisify` imports dead too. Bonus cleanup.
- The `created_at` at types.ts:70 is on `CombinedResult` (a SQLite-sourced search result), NOT the ChromaMetadata — so it's live. The ChromaMetadata interface (types.ts:21) uses `created_at_epoch` only. Good — my scoped deletion is correct.

I have everything needed to write the plan section.

## Slice: integrations + sync (~−2640 lines)
**Scope:** `src/services/integrations/` (CodexCli, Cursor, Gemini, Windsurf, OpenCode, OpenClaw, Mcp, install-paths), `src/services/sync/` (ChromaSync, ChromaSyncState, ChromaMcpManager). Companion edit: `tests/infrastructure/plugin-distribution.test.ts:437`.
**Ponytail lens (why each exists):** The five hook installers each grew independently and re-implement the same install/uninstall/status/handle-command/context-fetch shape — the biggest item, and the answer is "it earns its place but the duplication doesn't: collapse to the table-driven `McpInstallerConfig` pattern that already exists in `McpIntegrations.ts`." The Chroma kill-tree recursion *looks* like reinvented process-group kill, but it earns its place — claude-mem does not own the spawn (MCP SDK's `StdioClientTransport` refuses `detached:true`), so the native swap is blocked; keep it.

**Findings (ranked, biggest cut first):**

| tag | what to cut | replacement | path:line | pre-delete verify (grep that must return 0 / expected) |
|-----|-------------|-------------|-----------|--------------------------------------------------------|
| yagni | 5 installers re-implementing install/uninstall/status/handle-command/context-fetch as copy-paste (Cursor 561, Windsurf 457, Gemini 389, OpenCode 375, OpenClaw 326 lines) | one table-driven installer extending the existing `McpInstallerConfig` pattern (hooks-capable variant) in `McpIntegrations.ts:42-120` | `CursorHooksInstaller.ts`, `WindsurfHooksInstaller.ts`, `GeminiCliHooksInstaller.ts`, `OpenCodeInstaller.ts`, `OpenClawInstaller.ts` | per-IDE behavior must be parameterized first (config path, hook cmd, context file, registry); keep `installWindsurfHooks`/`uninstallWindsurfHooks` (live, npx-cli) and `handleCursorCommand` (live, `worker-service.ts:1191`) reachable. Est −2400 only if behavior is genuinely identical; treat as the slice's risk item. |
| delete | dead exports, zero callers repo-wide | remove fn + its now-orphaned imports | `OpenCodeInstaller.ts:181` `syncContextToAgentsMd`; `WindsurfHooksInstaller.ts:81` `updateWindsurfContextForProject`, `:425` `handleWindsurfCommand`; `CursorHooksInstaller.ts:489` `detectClaudeCode` (+ orphans `exec`/`promisify`/`execAsync` import, used only here), `:31` `getScriptExtension` + `:27` `detectPlatform` (only consumer is `getScriptExtension`); `install-paths.ts:77` `getVersionCheckAbsolutePath` | `grep -rn "syncContextToAgentsMd\|updateWindsurfContextForProject\|handleWindsurfCommand\|detectClaudeCode\b\|getScriptExtension\|getVersionCheckAbsolutePath" src/` → each returns ONLY its own def line (verified). **Companion edit required:** remove `'getVersionCheckAbsolutePath'` from `tests/infrastructure/plugin-distribution.test.ts:437` or that test fails. |
| delete | `ChromaSyncState.flush()` + `resetCache()` + `dirty` flag — `bump`/`replace` persist eagerly, so `dirty` is always false when `flush` runs, and both methods have zero callers | remove all three methods + the `dirty` module var (lines 22, 53, 73, 80) | `ChromaSyncState.ts:84-91` (`flush`,`resetCache`), `:22`,`:53`,`:73`,`:80` (`dirty`) | `grep -rn "\.flush()\|\.resetCache()" src/ tests/ \| grep -i sync` → 0 (verified) |
| delete | `created_at` ISO field on the three LOCAL Stored interfaces — set from epoch but never placed in Chroma metadata (`baseMetadata` uses `created_at_epoch` only) and never read back | drop field + its assignment; keep `created_at_epoch` | `ChromaSync.ts:31,48,57` (interface fields) + `:331,383,437` (assignments) | `grep -rn "meta\.created_at\b\|metadata\.created_at\b" src/ \| grep -v created_at_epoch` → 0; read path uses `meta.created_at_epoch` at `ChromaSearchStrategy.ts:167` (verified). Do NOT touch shared `created_at` in `types/database.ts`, `sqlite/`, search `CombinedResult` (`search/types.ts:70`) — all live. |
| shrink | `discoveryTokens` param + `discovery_tokens` Stored-field — value IS passed by live callers but never reaches Chroma metadata (`baseMetadata` omits it) and never read from Chroma | drop param from `syncObservation`/`syncSummary` + field from local Stored interfaces; update the live call sites to stop passing it | `ChromaSync.ts:30,47` (fields), `:313,368` (params), `:330,382` (assignments); callers `ResponseProcessor.ts:327`, `MemoryRoutes.ts:80`, `DataRoutes.ts:378` | NOT a clean delete — `discovery_tokens` is live elsewhere via SQLite (TokenCalculator, context, search). Scope strictly to the Chroma write path. Verify after: `grep -n "discovery_tokens" src/services/sync/ChromaSync.ts` → 0. ~−10 lines. |
| stdlib | `parseSemver` + `compareSemver` hand-rolled tuple comparison | `a.localeCompare(b, undefined, { numeric: true })` on the version strings (still guard the regex-extract for "could not parse" branch) | `CodexCliInstaller.ts:230-240`, callers `:254,260,261` | both live (used in `assertCodexMarketplaceSupported`) — this is a refactor not a delete; keep the version-too-old throw behavior. ~−8 lines |
| shrink | OpenClaw `possibleRoots` — identical 5-line array literal repeated 3× | hoist one module-level `const OPENCLAW_MARKETPLACE_ROOTS` | `OpenClawInstaller.ts:33-39, 53-59, 72-78` | behavior identical across the three `find*` fns (verified). ~−10 lines |
| shrink | `bootstrapWatermarksFromChroma` hand-rolled `max(set)` loop | `set.size ? Math.max(...set) : 0` | `ChromaSync.ts:532-536` | only used at `:538-540` (verified). ~−4 lines |
| shrink | Goose YAML string-builders `buildGooseMcpYamlBlock` / `buildGooseClaudeMemEntryYaml` (near-identical, differ by one leading `mcpServers:` line) | collapse to one builder taking a `withHeader` flag | `McpIntegrations.ts:175-192`, callers `:224,235,245,251` | both live in `mergeGooseYamlConfig` — refactor only. ~−8 lines |
| shrink | OpenCode `fetchRealContextFromWorker` / `fetchAndInjectOpenCodeContext` | inline / dedupe against the worker-context fetch already in Cursor/Windsurf installers (consolidates with the yagni item above) | `OpenCodeInstaller.ts:196,210` (callers `:338,186`) | both live — fold into the unified installer's context-fetch, don't delete standalone. |

**Risks / do-NOT-touch:**
- **`findMcpServerPath`/`findWorkerServicePath`/`findBunPath` (CursorHooksInstaller:93,97,101) — KEEP.** Hunter listed them as dead wrappers; they are NOT. Live callers at `CursorHooksInstaller.ts:126,187,198` and they are re-imported under alias by `GeminiCliHooksInstaller.ts:6` and `WindsurfHooksInstaller.ts:8`. The yagni consolidation should migrate those imports to `install-paths.ts` directly, then they fall out — but only as part of that work, not as a standalone delete.
- **`ChromaMcpManager.killProcessTree` + `collectDescendantPids` pgrep recursion (`ChromaMcpManager.ts:465,549`) — KEEP, do NOT "spawn detached + kill(-pid)".** The chroma-mcp child is spawned by the MCP SDK's `StdioClientTransport` (`ChromaMcpManager.ts:3,124`), which the code comment at `:794` confirms does NOT set `detached:true`; claude-mem does not own the spawn call, so it cannot make the child a group leader. The pgrep walk exists precisely to reach the `uvx→uv→python→chroma-mcp` grandchildren that survive `pkill -P`. This recursion fixed the #2253 CPU-runaway; the native swap is blocked by the SDK transport. Hunter "native" claim DROPPED.
- `discovery_tokens` and `created_at` are heavily live in SQLite/search/telemetry paths — every cut above is scoped to the *Chroma write path / local Stored interfaces in ChromaSync.ts only*. Do not touch `types/database.ts`, `services/sqlite/`, `services/context/`, `services/telemetry/`, or `search/types.ts:70`.

**Verify gate:**
`grep -rn "syncContextToAgentsMd\|updateWindsurfContextForProject\|handleWindsurfCommand\|detectClaudeCode\b\|getScriptExtension\|getVersionCheckAbsolutePath\|\.flush()\|\.resetCache()" src/` → 0; `grep -rn "meta\.created_at\b" src/ | grep -v _epoch` → 0; `grep -n "discovery_tokens\|created_at\b" src/services/sync/ChromaSync.ts` shows only `_epoch` survivors; then `bunx tsc --noEmit` and `bun test tests/infrastructure/plugin-distribution.test.ts tests/**/sync*` (the plugin-distribution test must be edited in lockstep with the `getVersionCheckAbsolutePath` delete).

**Est:** −2640 lines (−2400 installer consolidation [yagni, behavior-dependent], ~−150 dead exports, ~−15 ChromaSyncState, ~−10 created_at, ~−40 the shrink/stdlib items).

---

I have full verification. Final notes:
- Tests exist for `ResultFormatter`, `cleanupProcessedMessages`, `shouldFallbackToClaude`, `SearchOrchestrator` (the dead wrappers), and strategy `canHandle` — these tests must be deleted/trimmed alongside the code, and the verify gate must account for them (they're testing dead code, so removing both is net-correct).
- No-op `validateBody(emptyBodySchema)` confirmed at 6 sites (CorpusRoutes 75/76/78 ×3, plus the empty-schema-backed updateSettings/updateBranch/clearLogs/setProcessing — these "empty" schemas accept anything via passthrough, so the middleware validates nothing). The 5 truly-empty ones: emptyBodySchema (CorpusRoutes ×3), setProcessingSchema (dies with the route), clearLogsSchema, updateSettingsSchema, updateBranchSchema.

I now have everything needed to write the plan section.

## Slice: worker — dead parallel search pipeline + provider twins + route boilerplate  (~−1,450 lines)
**Scope:** `src/services/worker/` — primarily `SearchManager.ts`, `search/**` (SearchOrchestrator, ResultFormatter, TimelineBuilder, filters/, strategies/), `FormattingService.ts`, `GeminiProvider.ts`, `OpenRouterProvider.ts`, `retry.ts`, `http/shared.ts`, `http/routes/{Corpus,Logs,Data}Routes.ts`, `http/middleware/validateBody.ts`, `agents/{SessionCleanupHelper,FallbackErrorHandler,types}.ts`, `RateLimitStore.ts`, `session/SessionCompletionHandler.ts`, `search/types.ts`, plus the matching `tests/worker/**`.

**Ponytail lens (why each exists):**
- The whole `search/` strategy-orchestrator-formatter-timeline-filter pipeline was built speculatively as a "clean" architecture, but production wires `SearchManager` straight to SQLite/Chroma and does all formatting/timeline inline — the orchestrator survives only as a thin shim for `findBy{Concept,Type,File}` (SearchRoutes) and `search` (CorpusBuilder). Verdict: **delete the unreachable half** (TimelineBuilder, ResultFormatter instance methods, filter classes, dead orchestrator wrappers, strategy `canHandle`/`name`), **keep + simplify** the four live orchestrator methods.
- `GeminiProvider`/`OpenRouterProvider` are real, live, and ~95% structurally identical — they earn their place; **simplify** via an `OpenAICompatibleProvider`/shared base rather than delete.
- `SearchManager`'s 3 timeline renderers and ~8 chroma→90day→hydrate→FTS blocks are live and load-bearing — **earn their place, deduplicate** into `renderTimeline()` + `hybridSearch(query, docType)`.

**Findings (ranked, biggest cut first):**

| tag | what to cut | replacement | path:line | pre-delete verify (grep that must return 0 / expected) |
|-----|-------------|-------------|-----------|--------------------------------------------------------|
| shrink | `GeminiProvider`(571) + `OpenRouterProvider`(640) ~95% twins: `startSession`/`processObservationMessage`/`processSummaryMessage`/`truncateHistory`/`conversationTo*`/`query*MultiTurn`/`get*Config`/`is*Available/Selected` | `OpenAICompatibleProvider` base (~260 shared) | GeminiProvider.ts:182 / OpenRouterProvider.ts:185 | n/a (refactor) — `bun test tests/worker/**Provider*` green after |
| shrink | SearchManager 8× chroma-query→`Date.now()-RECENCY_WINDOW_MS`→`getObservationsByIds`→FTS-fallback | one `hybridSearch(query, docType)` | SearchManager.ts:218,959,1034,1109,1500 (+decision/changed/how-it-works variants 749,830,899) | refactor; `bun test tests/worker/search` green |
| shrink | SearchManager 3 near-identical day→file→observation timeline renderers | one `renderTimeline()` | SearchManager.ts:696,1433,1666 (shared cluster 413/427) | refactor; timeline tests green |
| delete | `TimelineBuilder.ts` (262) — only callers are the dead orchestrator wrappers; SearchManager's `this.timelineBuilder` (field 39/53) is instantiated but never invoked | — | search/TimelineBuilder.ts (whole file) + SearchManager.ts:17,39,53 + SearchOrchestrator.ts:11,37,52,135-156 + search/index.ts:5,6 | `grep -rn "this.timelineBuilder\.\|\.buildTimeline\|\.filterByDepth\|\.formatTimeline" src` = 0 (after wrappers gone) |
| delete | SearchOrchestrator dead wrappers `getTimeline`/`formatTimeline`/`formatSearchResults`/`getFormatter`/`getTimelineBuilder`/`isChromaAvailable` (live callers use only `search`,`findByConcept`,`findByType`,`findByFile`) | — | search/SearchOrchestrator.ts:135-172,213-215 | `grep -rEn "orchestrator\.(getTimeline\|formatTimeline\|formatSearchResults\|getFormatter\|getTimelineBuilder\|isChromaAvailable)\(" src` = 0 |
| yagni | `ResultFormatter` instance methods (`formatSearchResults`,`combineResults`,`format{Observation,Session,Prompt}{SearchRow,Index}`,`formatTableHeader`,`formatSearchTableHeader`,`formatSearchTips`,`estimateReadTokens`) — reachable only via dead orchestrator `getFormatter`/`formatSearchResults`; live use is **only** `static formatChromaFailureMessage` | keep the one static method; live formatting is `FormattingService` (used by SearchRoutes via `searchManager.getFormatter()`) | search/ResultFormatter.ts:16-227,237 (keep :230 static) | `grep -rn "new ResultFormatter\|\.formatSearchResults(\|resultFormatter\." src` = 0; only `ResultFormatter.formatChromaFailureMessage` remains (SearchManager.ts:364) |
| delete | `search/filters/` dir — `DateFilter`/`ProjectFilter`/`TypeFilter` never instantiated; only re-exported by barrel. (`getDateBoundaries` already confirmed dead in prior audit.) NB: SearchManager's `projectFilter` are inline object literals, not these classes | — | search/filters/{DateFilter,ProjectFilter,TypeFilter}.ts (183) + search/index.ts:14,15,16 | `grep -rn "new DateFilter\|new ProjectFilter\|new TypeFilter\|getDateBoundaries(" src` = 0 |
| delete | `SearchStrategy.canHandle` + `name` (interface, BaseSearchStrategy, all 3 strategies) never invoked/read; `HybridSearchStrategy.search()` is a no-op returning `emptyResult('hybrid')` (orchestrator calls only its `findBy*`) | drop `canHandle`/`name` from interface+impls; drop Hybrid `search()` | strategies/SearchStrategy.ts:8,10,14,17; HybridSearchStrategy.ts:26,35-43; ChromaSearchStrategy.ts:26; SQLiteSearchStrategy.ts:21 | `grep -rn "\.canHandle(\|Strategy\.name\|hybridStrategy\.search(" src` = 0 |
| delete | `http/shared.ts` IngestEventBus machinery: `SummaryStoredEvent`, `IngestEventBus` class, `ingestEventBus` const, the 2 `.emit('summaryStoredEvent')` in `ingestSummary` (parsed branch) — sole consumer `takeRecentSummaryStored` has zero callers. **Keep** `ingestSummary`/`ingestObservation` (live) | drop bus; `ingestSummary` parsed-branch just returns | http/shared.ts:16-52,259-262,266-269 | `grep -rn "takeRecentSummaryStored\|ingestEventBus\|summaryStoredEvent\|SummaryStoredEvent" src` = 0 after |
| delete | `ingestPrompt` — zero callers (only `ingestObservation`+`ingestSummary` are live) | — | http/shared.ts:184-214 | `grep -rn "ingestPrompt" src` = 0 |
| delete | `POST /api/processing` route + `handleSetProcessing` (a misnamed read-only dup of GET handler) + `setProcessingSchema`; no client hits it (UI uses GET `/api/processing-status`) | — | http/routes/DataRoutes.ts:69,106,286-292 | `grep -rn "api/processing[^-]" src` = only the route reg line |
| native | no-op `validateBody(z.object({}).passthrough())` — empty passthrough validates nothing | drop the middleware on these routes (+ the schemas) | CorpusRoutes.ts:59,75,76,78; LogsRoutes.ts:11,89; SettingsRoutes.ts:17,27,38,45; DataRoutes.ts:69,106 | n/a — request bodies still reach handlers untouched; route tests green |
| shrink | CorpusRoutes 6× identical `res.status(404).json({ error: \`Corpus "${name}" not found\` })` | one `corpusNotFound(res, name)` helper | CorpusRoutes.ts:114,131,147,166,183,201 | refactor; corpus route tests green |
| shrink | `parseRetryAfterMs` duplicated verbatim in both worker providers | export once from `retry.ts`, import in both | GeminiProvider.ts:27; OpenRouterProvider.ts:36 | after: `grep -rn "function parseRetryAfterMs" src/services/worker` = 1 (retry.ts). NB: `src/server/generation/providers/shared/error-classification.ts:49` copy is a DIFFERENT subtree — out of this slice |
| delete | `FallbackErrorHandler.shouldFallbackToClaude` (+ its private `getErrorMessage`) — zero invocation sites. **Keep `isAbortError`** (live: Gemini:387, OpenRouter:418) | — | agents/FallbackErrorHandler.ts:5-29; index.ts:21 (drop `shouldFallbackToClaude` from re-export) | `grep -rn "shouldFallbackToClaude(" src` = 0 |
| delete | `RateLimitStore` public `get`/`getAll`/`clear` — never called on `globalRateLimitStore` (live: `set`, `getMostRecentByWindow`). NB: hunter's `size` is wrong — no public `size()` exists | — | RateLimitStore.ts:70,76,104 | `grep -rn "globalRateLimitStore\.\(get\|getAll\|clear\)\b" src` = 0 |
| delete | `SessionCompletionHandler.completeByDbId` — zero callers | — | session/SessionCompletionHandler.ts (the `completeByDbId` method) | `grep -rn "completeByDbId" src` = 0 |
| delete | `agents/SessionCleanupHelper.ts` (12) — `cleanupProcessedMessages` never invoked in src (the `earliestPendingTimestamp=null` half is already inlined at ResponseProcessor.ts:103); only barrel re-export + test reference it | inline-already; delete file + index.ts:19 + its test | agents/SessionCleanupHelper.ts; agents/index.ts:19; tests/worker/agents/session-cleanup-helper.test.ts | `grep -rn "cleanupProcessedMessages" src` = 0 |
| delete | dead agent types `SSEEventPayload`,`ResponseProcessingContext`,`ParsedResponse`,`BaseAgentConfig` — referenced only by barrel `agents/index.ts` re-export, no real consumer | — | agents/types.ts:46,56,63,68; agents/index.ts:6,8,9,10 | each: `grep -rn "\b<Name>\b" src \| grep -v "agents/\(types\|index\).ts"` = 0 |
| delete | dead search type `ChromaQueryResult` (0 refs anywhere) | — | search/types.ts:15 | `grep -rn "ChromaQueryResult" src` = 0 |

**Risks / do-NOT-touch (looks deletable, isn't):**
- **FormattingService is the LIVE formatter — do NOT fold it into ResultFormatter.** The hunter's direction is reversed: `SearchManager.getFormatter()` returns `FormattingService` (used by SearchRoutes.ts:210/239/312 and SearchManager rows), while ResultFormatter's instance methods are the dead twin. Keep FormattingService; delete ResultFormatter's instance methods instead.
- **`ingestSummary` / `ingestObservation` are live** (ResponseProcessor.ts:227, transcripts/processor.ts:247, SessionRoutes.ts:273) — only the event-bus and `ingestPrompt` die.
- **`DatabaseManager.getSessionById` is NOT a dead thin-wrap** — 2 live callers (SessionManager.ts:42,74) and it adds a not-found throw + typed shape. Leave it (drop from plan).
- **`retry.ts RetryOptions` fields are NOT dead** — `perAttemptTimeoutMs`/`baseDelayMs`/`maxDelayMs`/`abortSignal` are all consumed internally via `DEFAULT_OPTIONS`/`opts` (timeout at :71, backoff at computeBackoffMs, abort plumbing at :65/73/86-118). Callers just never override them. Deleting them is a behavior change, and `abortSignal` is load-bearing generator-cancellation infra. DROP this hunter claim.
- **`GeminiProvider.enforceRateLimitForModel` is a proactive client-side RPM throttle gated by `rateLimitingEnabled`, not redundant dead code** — withRetry only handles 429/Retry-After *reactively*; OpenRouter has no equivalent. Removing it changes free-tier Gemini behavior. DOWNGRADE to "behavior-changing simplification, verify the setting's intent" — not a clean stdlib swap.
- **`LogsRoutes.readLastLines` newline counter is load-bearing** — it drives the bounded chunked-tail read (grows window until enough `\n`, computes `avgLineLength` for `totalEstimate`). `content.split('\n')` cannot replace it without reading whole files. DROP this stdlib claim.
- **`ChromaDocType`, `ExtendedSearchOptions`, `SearchStrategyHint` are NOT dead** — used internally within `search/types.ts` (ChromaMetadata.doc_type; StrategySearchOptions extends ExtendedSearchOptions; strategyHint/strategy fields). DOWNGRADE: only `ChromaQueryResult` is cleanly deletable.
- **Tests test dead code** — `tests/worker/search/result-formatter.test.ts`, `tests/worker/search/search-orchestrator.test.ts` (dead wrappers), `tests/worker/agents/fallback-error-handler.test.ts` (shouldFallbackToClaude), `tests/worker/agents/session-cleanup-helper.test.ts`, and strategy `canHandle` tests must be deleted/trimmed *with* the code, or the gate fails on missing symbols. This is expected, not a regression.

**Verify gate:**
1. Pre-delete grep sweep (all must return 0 per the table column above): `new DateFilter|new ProjectFilter|new TypeFilter|getDateBoundaries(`, `\.canHandle(|hybridStrategy\.search(`, `takeRecentSummaryStored|ingestEventBus`, `ingestPrompt`, `shouldFallbackToClaude(`, `globalRateLimitStore\.(get|getAll|clear)\b`, `completeByDbId`, `cleanupProcessedMessages`, `ChromaQueryResult`, `orchestrator\.(getTimeline|formatTimeline|formatSearchResults|getFormatter|getTimelineBuilder|isChromaAvailable)\(`, `this\.timelineBuilder\.`, `api/processing[^-]`.
2. Delete companion tests for removed symbols (listed above).
3. `bunx tsc --noEmit`
4. `bun test tests/worker` (covers search, agents, providers, routes)
5. `npm run build-and-sync` and confirm the worker starts (per CLAUDE.md).

**Est:** ~−1,450 lines (≈−350 from SearchManager timeline/hybrid dedup, ≈−260 from the provider base-class, ≈−700 from deleting TimelineBuilder + ResultFormatter instance methods + filters/ + strategy `canHandle`/`name` + dead orchestrator wrappers, ≈−140 from shared.ts event-bus + ingestPrompt + the route/middleware/type/method micro-deletions). Net new deps: 0.

---

All claims verified. Here is the plan section.

## Slice: src/server/ dead-and-redundant sweep  (~−560 lines)
**Scope:** `src/server/jobs/outbox.ts`, `src/server/mcp/`, `src/server/generation/providers/shared/error-classification.ts`, `src/server/runtime/{types.ts,ServerBetaService.ts,create-server-beta-service.ts}`, `src/server/routes/v1/{ServerV1Routes.ts,ServerV1PostgresRoutes.ts}`, `src/server/middleware/{auth.ts,postgres-auth.ts}`
**Ponytail lens (why each exists):** `outbox.ts` and `src/server/mcp/` are scaffolding the real code grew past — the canonical write path is `IngestEventsService`/`EndSessionService`, and the live MCP surface is `src/servers/mcp-server.ts`; both are reachable ONLY from their own tests → **delete them**. The 4-boundary "service graph" was speculative symmetry: queue-manager + generation-worker-manager **earn their place** (real Active variants chosen at runtime), but provider-registry + event-broadcaster have no Active counterpart and are wired inert forever → **delete those two**. The duplicated localhost/bearer auth helpers exist twice because the Postgres middleware was copy-pasted from the SQLite one → **hoist, don't keep two copies**.

**Findings (ranked, biggest cut first):**

| tag | what to cut | replacement | path:line | pre-delete verify (grep that must return 0 / expected) |
|-----|-------------|-------------|-----------|--------------------------------------------------------|
| delete | `outbox.ts` whole module (300 lines) + its test (416) | nothing — canonical path is `IngestEventsService`/`EndSessionService` | `src/server/jobs/outbox.ts:1-300`; `tests/server/jobs/outbox.test.ts` | `grep -rn "jobs/outbox" src` → only the test; `grep -rn "enqueueOutbox\|reconcileOnStartup\|EnqueueOutboxRowInput\|OutboxScope" src` → only comments in `ActiveServerBetaQueueManager.ts:25` & `ProviderObservationGenerator.ts:463`, zero imports |
| delete | `src/server/mcp/` dir: `register.ts` (13) `tools.ts` (96) `resources.ts` (16) `prompts.ts` (12) + `mcp-surface.test.ts` (31) | live MCP server `src/servers/mcp-server.ts` (separate, defines its own tools) | `src/server/mcp/register.ts:7` (`getServerMcpSurface`) | `grep -rn "getServerMcpSurface\|server/mcp/register" src` → 0 outside `src/server/mcp/`; only consumer is `tests/server/mcp-surface.test.ts` |
| yagni | `ServerBetaProviderRegistry` + `ServerBetaEventBroadcaster` interfaces, `DisabledServerBeta{ProviderRegistry,EventBroadcaster}` classes, graph fields, all getHealth/close sites | drop entirely (always-inert; queue-manager/gen-worker boundaries stay) | `types.ts:53-63,74-75,82-83,102-108`; `ServerBetaService.ts:46-47,76-77,244-245,273-274`; `create-server-beta-service.ts:18,20,217-218`; test fixture `tests/server/server-beta-service.test.ts:287-288,307-308` | `grep -rn "ActiveServerBetaProviderRegistry\|ActiveServerBetaEventBroadcaster" src` → 0 (no Active variant ⇒ never anything but Disabled) |
| native | 5 verbatim auth helpers (`parseBearerToken`/`isLocalhost`/`hasLoopbackHostHeader`/`parseHostWithoutPort`/`hasForwardedClientHeaders`) duplicated | hoist to new `src/server/middleware/request-auth-helpers.ts`, import in both | `auth.ts:91-132` ≡ `postgres-auth.ts:165-206` (only a trailing-comma diff) | `diff <(sed -n '91,132p' auth.ts) <(sed -n '165,206p' postgres-auth.ts)` → trailing-comma-only |
| delete | `isServerClassified` type guard | nothing (zero callers) | `error-classification.ts:40` | `grep -rn "isServerClassified" src tests` → only the definition |
| shrink | `resolveSummaryQueue` / `resolveEventQueue` near-identical 13-line bodies | `resolveQueue('summary'\|'event')` (one body, lane param) | `ServerV1PostgresRoutes.ts:967-994` | bodies differ only by the `'summary'`/`'event'` literal |
| yagni | dead option `runtime?` (read at info route, never set by any caller) | drop from `ServerV1RoutesOptions` + the `...(this.options.runtime ? …)` spread | `ServerV1Routes.ts:53`, read at `:81` | `grep -rn "runtime:" src/services/worker-service.ts` near `new ServerV1Routes` → not set (only `getDatabase`) |
| yagni | dead option `sessionDebounceWindowMs` (set→plumbed→read, but no caller ever supplies it) | drop from `ServerV1PostgresRoutesOptions` + the 2-line plumbing in ctor | `ServerV1PostgresRoutes.ts:45`, plumbed `:110-111`; sibling `IngestEventsService.ts:66,243-244` | `grep -rn "sessionDebounceWindowMs:" src tests` → 0 assignments |
| shrink | `waitForTerminalJob` is fine as one fn; the duplication is the single-wait (`:226`) vs batch-wait (`:303-311`) call sites | optional `awaitJobs(jobRepo, jobs[], remaining)` wrapper folding both loops | `ServerV1PostgresRoutes.ts:69-96` (fn), `:222-241` (single), `:303-318` (batch) | low value; keep if it doesn't shrink net — verify before committing |

**Risks / do-NOT-touch:**
- **`DisabledServerBetaQueueManager` / `DisabledServerBetaGenerationWorkerManager` and the `DisabledServerBetaBoundary` base STAY** — they have real `ActiveServerBeta*` counterparts and are chosen conditionally at `create-server-beta-service.ts:204,235,241,295`. The hunter's "collapse all 4 subclasses to `createDisabledBoundary(kind,reason)`" is **downgraded**: only 2 live subclasses remain after the cut, so a factory saves ~4 lines at the cost of losing the `instanceof` discriminator — **skip it.**
- **`/v1/info` + runtime-state `boundaries` payload is an observable HTTP response shape.** Removing `providerRegistry`/`eventBroadcaster` keys (`ServerBetaService.ts:76-77,273-274`) changes what a deploy/health probe sees. They're always `{status:'disabled'}` so no live behavior depends on them, but treat as a data-path change: update `tests/server/server-beta-service.test.ts` and grep external probes before merging.
- **BetterAuthRoutes WeakMap → lazy var: DOWNGRADE / skip.** `BetterAuthRoutes` is in DO-NOT-TOUCH (live via `worker-service.ts:275`). The `WeakMap<Database,…>` (`BetterAuthRoutes.ts:9`) is keyed per-database; the single caller passes one `dbManager.getConnection()`, so a lazy var is *behaviorally* safe — but it's a ~3-line save inside a load-bearing auth file for negligible gain. Not worth the blast radius; leave it.
- **`ServerViewerRoutes` IIFE → `express.static`: DROP (stale claim).** The static serving is ALREADY `express.static` (`ServerViewerRoutes.ts:52-53`); the remaining module-level IIFE (`:20`) just resolves+boot-caches the candidate `viewer.html` paths and is correct/minimal. Nothing to cut here.
- `ServerV1Routes` / `requireServerAuth` / `requirePostgresServerAuth` / `sqlite-api-key-service` / `createAuth` are LIVE — only the duplicated *private* helpers move; the exported middleware signatures are unchanged.

**Verify gate:** `grep -rn "jobs/outbox\|getServerMcpSurface\|isServerClassified\|ActiveServerBetaProviderRegistry\|ActiveServerBetaEventBroadcaster\|sessionDebounceWindowMs:" src tests` returns 0 → then `bunx tsc --noEmit` (or `npm run typecheck`) → then `bun test tests/server tests/compat` (covers ServerV1PostgresRoutes, server-beta-service, compat adapters; the two deleted test files go with their sources).
**Est:** −560 lines (outbox 300 + outbox.test 416 + mcp dir 137 + mcp-surface.test 31 + isServerClassified ~10 + provider/event boundary ~30 + dead options ~6, minus ~30 added back for the hoisted auth-helpers module and `resolveQueue` consolidation; ~+847 if you count deleted test files, ~−560 net of source-only if tests are excluded from the tally).

Files of interest (absolute):
- `/Users/alexnewman/.superset/worktrees/df8069a7-eb08-4626-9d3d-918d1e12eb9f/zippy-fruit/src/server/jobs/outbox.ts`
- `/Users/alexnewman/.superset/worktrees/df8069a7-eb08-4626-9d3d-918d1e12eb9f/zippy-fruit/src/server/mcp/{register,tools,resources,prompts}.ts`
- `/Users/alexnewman/.superset/worktrees/df8069a7-eb08-4626-9d3d-918d1e12eb9f/zippy-fruit/src/server/runtime/{types.ts,ServerBetaService.ts,create-server-beta-service.ts}`
- `/Users/alexnewman/.superset/worktrees/df8069a7-eb08-4626-9d3d-918d1e12eb9f/zippy-fruit/src/server/routes/v1/ServerV1PostgresRoutes.ts`
- `/Users/alexnewman/.superset/worktrees/df8069a7-eb08-4626-9d3d-918d1e12eb9f/zippy-fruit/src/server/middleware/{auth.ts,postgres-auth.ts}`
- `/Users/alexnewman/.superset/worktrees/df8069a7-eb08-4626-9d3d-918d1e12eb9f/zippy-fruit/src/server/generation/providers/shared/error-classification.ts`

---

Now I have full clarity. The `memory_*` compat aliases are explicitly documented as "keep working for any client that bound to them" — these are a public MCP surface. Deleting them is a behavioral/compat change, NOT pure dead-code removal. I'll downgrade this to a flagged/risky cut. The 7 dead cursor-utils helpers are confirmed dead (the 6 live ones are the registry/context/mcp-config writers, all used by CursorHooksInstaller/install). The `removeMcpConfig` IS dead (not in the live list). 

I have everything needed. Writing the final plan section.

## Slice: cli + supervisor + ui + utils + servers + bin + adapters + core/schemas  (~−620 lines)
**Scope:** `src/bin/`, `src/adapters/`, `src/utils/cursor-utils.ts`, `src/utils/logger.ts`, `src/core/schemas/{context-pack.ts,index.ts}`, `src/cli/adapters/gemini-cli.ts` + `src/cli/types.ts`, `src/servers/mcp-server.ts`, `src/supervisor/{process-registry.ts,shutdown.ts,env-sanitizer.ts}`, `src/ui/viewer/{hooks,utils,components}`
**Ponytail lens (why each exists):** Most of this is scaffolding that outlived its caller. `src/bin/*` and `src/adapters/` are an *abandoned parallel implementation* — the real adapter dispatch lives in `src/cli/adapters/`, so the top-level `src/adapters/` and the two one-off bin scripts are pure orphans → **delete**. `core/schemas/` legitimately exists (6 of its files have live storage/route importers) but `context-pack.ts` + the `index.ts` barrel have zero consumers → **delete those two only, keep the rest**. `useStats` *earns a fetch* but its consumer throws the data away → **simplify, don't delete**. The MCP `memory_*` aliases look like dead dup but are a documented public client surface → **keep**.

**Findings (ranked, biggest cut first):**

| tag | what to cut | replacement | path:line | pre-delete verify (grep that must return 0 / expected) |
|-----|-------------|-------------|-----------|--------------------------------------------------------|
| delete | `src/bin/import-xml-observations.ts` (orphan one-off; note: "hardcoded path" descriptor is STALE — no `/Users` literal present, but still zero callers) | — | src/bin/import-xml-observations.ts (whole file, ~280 lines) | `grep -rn import-xml-observations src package.json plugin --include='*.ts' --include='*.json'` → 0 (CHANGELOG.md + docs/*.md hits are non-code) |
| delete | `src/bin/cleanup-duplicates.ts` (orphan maintenance script, reaches into `db['db']` private; not in package.json bin/scripts) | — | src/bin/cleanup-duplicates.ts (whole file, ~92 lines) | `grep -rn cleanup-duplicates src package.json plugin --include='*.ts' --include='*.json'` → 0 |
| delete | `src/adapters/` whole dir (`claude-code/mapper.ts` + `generic-rest/examples.ts`) — abandoned parallel impl; real adapters are in `src/cli/adapters/` | — | src/adapters/claude-code/mapper.ts, src/adapters/generic-rest/examples.ts | `grep -rn "src/adapters\|adapters/mapper\|adapters/generic-rest\|adapters/examples\|claude-code/mapper" src --include='*.ts' | grep -v 'src/adapters/'` → 0 |
| delete | 7 dead cursor-utils helpers: `jsonGet`, `parseArrayField`, `isEmpty`, `urlEncode`, `getProjectName`, `removeMcpConfig`, `readContextFile` (live `getProjectName` resolves to `src/utils/project-name.ts`, not this one) | — | src/utils/cursor-utils.ts:90,124,141,150,166,184,192 | per-fn: `grep -rn '\b<fn>\b' src --include='*.ts' | grep -v src/utils/cursor-utils.ts` → 0 (note `getProjectName` only hits project-name.ts) |
| delete | logger `correlationId()` + `sessionId()` + `timing()` methods (zero call sites) | — | src/utils/logger.ts:112,116,316 | `grep -rn '\.correlationId(\|\.sessionId(\|\.timing(' src --include='*.ts' | grep -v src/utils/logger.ts` → 0 |
| delete | `core/schemas/context-pack.ts` (`ContextPackSchema`, `ContextPack`) — barrel-only export, no real consumer | — | src/core/schemas/context-pack.ts (whole file); also drop `export * from './context-pack.js'` line | `grep -rn ContextPack src --include='*.ts' | grep -v context-pack.ts` → 0 |
| yagni | `core/schemas/index.ts` barrel — zero importers; every consumer imports the concrete file directly | delete file | src/core/schemas/index.ts:1-9 | `grep -rn "from ['\"].*core/schemas['\"]\|core/schemas/index" src --include='*.ts'` → 0 |
| yagni | gemini-cli `metadata` object: `NormalizedHookInput.metadata` is set here but never read by any consumer; field is optional in the type | drop the `metadata` block + the `metadata:` return field; optionally drop `metadata?` from the interface | src/cli/adapters/gemini-cli.ts:46-54,64 ; src/cli/types.ts:18 | `grep -rn '\.metadata' src/cli --include='*.ts' | grep -v gemini-cli.ts` → 0 (no readers) |
| yagni | `useStats` dead inner state: `App.tsx` destructures only `refreshStats`, never `stats` → `useState<Stats>`, `setStats`, `.json()` parse, and `Stats`/`WorkerStats`/`DatabaseStats` types are all dead; hook collapses to fire-and-forget fetch | `export function useStats(){ const refreshStats=useCallback(()=>{authFetch(API_ENDPOINTS.STATS).catch(...);},[]); useEffect(()=>{refreshStats();},[refreshStats]); return {refreshStats}; }` + delete 3 types | src/ui/viewer/hooks/useStats.ts:7,13,23 ; src/ui/viewer/types.ts:96,103,111 | `grep -rn '\bstats\b' src/ui/viewer/App.tsx` → only `refreshStats`; `grep -rn 'WorkerStats\|DatabaseStats\|\bStats\b' src/ui --include='*.ts*' | grep -v useStats` → 0 |
| yagni | `useTheme` `resolvedTheme` returned but no external consumer | drop `resolvedTheme` state + return key (keep internal `setResolvedTheme` use only if it drives an effect; else drop both) | src/ui/viewer/hooks/useTheme.ts:34,70 | `grep -rn resolvedTheme src/ui --include='*.ts*' | grep -v useTheme.ts` → 0 |
| yagni | `useContextPreview` `refresh` in the result interface — only consumer (`ContextSettingsModal`) never destructures it | drop `refresh` from `UseContextPreviewResult` + its impl | src/ui/viewer/hooks/useContextPreview.ts:9 | `grep -rn 'refresh' src/ui/viewer/components/ContextSettingsModal.tsx` → 0 (only `useContextPreview` import, no `refresh`) |
| yagni | `env-sanitizer` `ENV_PROXY_VARS` separate Set — its only use is a `continue` (drop key); fold the 4 names into the same skip path as `ENV_EXACT_MATCHES` | merge into one skip set / inline the 4 names | src/supervisor/env-sanitizer.ts:14,50 | n/a (single internal use at line 50) — confirm: `grep -rn ENV_PROXY_VARS src` → only env-sanitizer.ts |
| stdlib | ui `formatStarCount` k/M formatter | `new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(count)` (inline at the call site, delete formatNumber.ts) | src/ui/viewer/utils/formatNumber.ts:1 ; caller GitHubStarsButton.tsx:46 | single caller — `grep -rn formatStarCount src/ui` → 1 import + 1 use only |
| shrink | `reapSession` re-implements the SIGTERM→poll→SIGKILL loop that `shutdown.ts` already has as `waitForExit` (poll loop is byte-identical) | export `waitForExit` from shutdown.ts and call it from reapSession's wait phase (signal logic differs by pgid handling, so dedup the *poll wait* only) | src/supervisor/process-registry.ts:326-332 vs src/supervisor/shutdown.ts:145-155 | diff the two `while(Date.now()<deadline)` blocks → identical; `waitForExit` currently un-exported (shutdown.ts:145) |
| native | `useGitHubStars` inline into `GitHubStarsButton` (one consumer) | move the fetch/state into the component; drop the hook file (modest — keeps loading/error state, so ~−10 net) | src/ui/viewer/hooks/useGitHubStars.ts ; GitHubStarsButton.tsx | `grep -rn useGitHubStars src/ui` → 1 consumer |

**Downgraded / dropped Hunter claims (could NOT confirm dead — KEEP):**
- **KEEP — `mergeAndDeduplicateByProject`** (Hunter said yagni): 3 live callers at `src/ui/viewer/App.tsx:43,49,55`; clean 11-line generic Set-dedup. It earns its place. Do not cut.
- **KEEP — MCP `memory_add`/`memory_search`/`memory_context` compat aliases** (Hunter said delete): `src/servers/mcp-server.ts:616,647,662` are an *intentional, documented public client surface* ("keep `memory_*` tool names working for any client that bound to them", lines 611-614). Deleting them is a breaking compat change, not dead-code removal. Out of scope for a ponytail cut.
- **KEEP — MCP `__IMPORTANT` blurb** (`src/servers/mcp-server.ts:431`): it's a live tool returning the 3-layer workflow guidance to the client; it's a UX feature, not dead code. Downgrade — leave it.
- **KEEP — logger `formatTimestamp`** (Hunter "stdlib → toISOString"): NOT dead — called internally at `logger.ts:230`. And `toISOString()` is **UTC**, whereas this emits **local** `YYYY-MM-DD HH:mm:ss.SSS`. Not an equivalent; swapping changes log timestamps to UTC. Reject this stdlib swap unless UTC logs are explicitly wanted.
- **DOWNGRADE — `authFetch` passthrough** (Hunter yagni): confirmed a pure `return fetch(input,init)` (api.ts:1) with **13 call sites across 6 files**. Inlining nets ~−3 lines but touches 6 files and removes the one seam where auth headers would be added later. Low payoff / mild risk — list as optional, not recommended.
- **DOWNGRADE — `process-registry waitForSlot` slot-waiter → poll loop** (Hunter shrink): the existing slot-waiter queue (process-registry.ts:491-554) is event-driven (resolves on slot release) and integrates `AbortSignal`. A poll loop would be *more* code and worse latency. Reject — leave as is.
- **DOWNGRADE — `SpawnedSdkProcess` method-rebind wrapper** (process-registry.ts:698-701, `child.kill.bind(child)` etc.): this narrows a `ChildProcess` to a documented 4-method interface used at the spawn boundary. Borderline; removing it leaks the full ChildProcess surface to callers. Skip unless you also retype all consumers — not worth it.
- **DOWNGRADE — per-catch non-Error branches → `toError(e)`**: `toError` does **not exist** in the repo (`grep` → 0). This is a net-ADD of a helper; only ~8 such branches in-scope. Marginal. If done, add one `toError` util and collapse, but it's a wash on line count — defer.

**Risks / do-NOT-touch:** `PlatformAdapter`/`EventHandler` interfaces (runtime dispatch, multiple impls); `tree-kill` dep (loaded in shutdown.ts:206); the 6 LIVE cursor-utils funcs (`readCursorRegistry`/`writeCursorRegistry`/`registerCursorProject`/`unregisterCursorProject`/`writeContextFile`/`configureCursorMcp` — used by `CursorHooksInstaller.ts` + `install.ts`); the 6 LIVE `core/schemas/*` files (memory-item/agent-event/auth/project/session/team all have storage+route importers); `src/types/*.d.ts` shims; `hook-shell-template` flags.

**Verify gate:**
```
# orphan sweep (all must be 0):
grep -rn "import-xml-observations\|cleanup-duplicates" src package.json plugin --include='*.ts' --include='*.json'
grep -rn "src/adapters\|claude-code/mapper\|adapters/examples" src --include='*.ts' | grep -v 'src/adapters/'
for f in jsonGet parseArrayField isEmpty urlEncode removeMcpConfig readContextFile; do grep -rn "\b$f\b" src --include='*.ts' | grep -v cursor-utils.ts; done
grep -rn "\.correlationId(\|\.sessionId(\|\.timing(" src --include='*.ts' | grep -v logger.ts
grep -rn "ContextPack" src --include='*.ts' | grep -v context-pack.ts
grep -rn "core/schemas['\"]" src --include='*.ts'
# then:
bunx tsc --noEmit            # baseline already clean (exit 0)
bun test src/supervisor src/cli src/ui src/utils
```

**Est:** −620 lines (bin ~372, src/adapters ~110, cursor-utils 7 fns ~55, logger 3 methods ~30, context-pack+barrel ~25, useStats trim ~20, gemini metadata ~11, remaining yagni/stdlib/native ~30; excludes the rejected/downgraded items).

---

tsc baseline is clean (exit 0). 

Summary of verification corrections to the hunter findings:
- **sqlite `TeamsRepository` + file delete + index export** — WRONG, has live test callers (`auth-api-key.test.ts`, `server-storage.test.ts`). DOWNGRADE to KEEP.
- **sqlite `addMember`/`getMember`/`listMembers`** — `addMember` is test-called (server-storage.test.ts:87); `getMember`/`listMembers` are internal-only to TeamsRepository. All tied to the kept file. DROP from cut list.
- **sqlite `getByRootPath`/`upsert`/`getByMemorySessionId`/`getByLegacyObservationId`** — genuinely zero callers (src+tests+scripts). CONFIRMED dead.
- **pg `agent-events.createMany`, `teams.getMember`** — zero callers. CONFIRMED dead.
- **pg `teams.getByIdForUser`, `observations(Sources).listByObservationForScope`** — only TEST callers. DOWNGRADE (delete requires removing test assertions).
- **`getWorkerSocketPath`, `createBackupFilename`, `ENV_FILE_PATH`** — CONFIRMED dead.
- **`SettingsDefaultsManager.getBool`** — test-only. DOWNGRADE.
- **drop export on `buildIsolatedEnv`/`decodeJwtExpMs`/`buildWorkerUrl`/`fetchWithTimeout`** — WRONG. `fetchWithTimeout` heavily used in src; the other three used by tests + internally. KEEP all exports.
- **`parseEnvFile`→util.parseEnv** — valid; **serializeEnvFile** has no stdlib equivalent, keep.
- **path-utils.isDirectChild→path.dirname** — WRONG, suffix-match logic is load-bearing (tests prove it). DOWNGRADE.
- **timeline-formatting 3 wrappers→one** — weak, distinct option objects, dedup already done. DROP/LOW.
- **postgres/config env-injection wrapper** — weak, `env` param is test seam. DROP.
- **canonicalJson/sortJson** — load-bearing for idempotency. DO-NOT-TOUCH (confirmed).
- **EnvManager 5-key blocks (load/save/buildIsolated)** — valid loop shrink, biggest legit shared/ win.

Here is the plan section:

## Slice: storage + shared dead-code & stdlib  (~−170 lines)
**Scope:** `src/storage/sqlite/`, `src/storage/postgres/`, `src/shared/`
**Ponytail lens (why each exists):** The storage repos grew CRUD methods speculatively (one method per imagined query) — most "earn their place" but a handful were never wired to a caller and are clean deletes. The shared/ helpers are mostly load-bearing; the one real win is that `EnvManager` open-codes the same 5-credential-key block three times, which "earns its place but simplifies" into a single `CREDENTIAL_KEYS` loop. The headline `TeamsRepository` delete does NOT survive verification — it has live test callers, so it stays.

**Findings (ranked, biggest cut first):**

| tag | what to cut | replacement | path:line | pre-delete verify (grep that must return 0 / expected) |
|-----|-------------|-------------|-----------|--------------------------------------------------------|
| shrink | EnvManager three open-coded 5-key credential blocks (`loadClaudeMemEnv` 128-132, `saveClaudeMemEnv` 161-195, `buildIsolatedEnv` 221-235) | one `const CREDENTIAL_KEYS = ['ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','GEMINI_API_KEY','OPENROUTER_API_KEY'] as const` + `for` loops; keep whitelist semantics (do NOT use Object.assign — see 112-115) | src/shared/EnvManager.ts:128,161,206 | n/a (refactor) — `bun test tests/env-isolation.test.ts tests/shared/oauth-token.test.ts` stays green |
| delete | sqlite `ProjectsRepository.upsert` | — (zero callers) | src/storage/sqlite/projects.ts:57 | `grep -rn "\.upsert(" src/ tests/ scripts/ \| grep -v postgres` → 0 |
| delete | sqlite `ProjectsRepository.getByRootPath` | — | src/storage/sqlite/projects.ts:81 | `grep -rn "getByRootPath" src/ tests/ scripts/` → only def |
| delete | sqlite `ServerSessionsRepository.getByMemorySessionId` | — | src/storage/sqlite/server-sessions.ts:87 | `grep -rn "getByMemorySessionId" src/ tests/ scripts/` → only def |
| delete | sqlite `MemoryItemsRepository.getByLegacyObservationId` | — | src/storage/sqlite/memory-items.ts:167 | `grep -rn "getByLegacyObservationId" src/ tests/ scripts/` → only def |
| delete | pg `PostgresAgentEventsRepository.createMany` | — (zero callers) | src/storage/postgres/agent-events.ts:106 | `grep -rn "\.createMany\b" src/ tests/ scripts/` → 0 |
| delete | pg `PostgresTeamsRepository.getMember` | — (zero callers; not used by getByIdForUser) | src/storage/postgres/teams.ts:98 | `grep -rn "\.getMember(" src/ tests/ scripts/ \| grep -v sqlite` → 0 |
| delete | `getWorkerSocketPath` (unix-socket path helper, never wired) | — | src/shared/paths.ts:66 | `grep -rn "getWorkerSocketPath" src/ tests/ scripts/` → only def |
| delete | `createBackupFilename` | — | src/shared/paths.ts:119 | `grep -rn "createBackupFilename" src/ tests/ scripts/` → only def |
| delete | `export const ENV_FILE_PATH` (deprecated const) | — | src/shared/EnvManager.ts:21 | `grep -rn "ENV_FILE_PATH" src/ tests/ scripts/` → only def |
| stdlib | EnvManager `parseEnvFile` line-parsing loop (58-83) | `util.parseEnv(content)` (Node 24 in use; available) — keep the quote-strip-free whitelist filter downstream | src/shared/EnvManager.ts:58 | n/a — `bun test tests/env-isolation.test.ts` green; do NOT touch `serializeEnvFile` (custom header + quoting, no stdlib equiv) |
| stdlib | `fetchWithTimeout` manual `setTimeout`/`clearTimeout` race | `fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })` (keep export — heavily used) | src/shared/worker-utils.ts:57 | keep signature; `bun test tests/shared/worker-utils*.test.ts tests/hooks/server-beta-client.test.ts` green |

**Risks / do-NOT-touch:**
- `postgres/utils.ts` `canonicalJson` (82) + internal `sortJson` (93) — LOAD-BEARING for idempotency/dedup keys: `observations.ts:275` (content hash) and `agent-events.ts:179` (payload key). DO NOT cut or "simplify the sort." Confirmed.
- sqlite `TeamsRepository` (src/storage/sqlite/teams.ts:49) and its `index.ts:9` `export *` — **NOT dead.** Live test callers: `tests/server/auth-api-key.test.ts:257,299,339` (`.create()`), `tests/storage/sqlite/server-storage.test.ts:50,87` (`new TeamsRepository`, `.addMember`). Hunter's headline delete is rejected. KEEP file, KEEP `create`/`addMember`/`getById`/`getMember`/`listMembers`.
- pg `teams.getByIdForUser` (teams.ts:81) and `observationSources.listByObservationForScope` (observations.ts:247) — src-dead but TEST-referenced (`postgres-storage.test.ts`, `process-generated-response.test.ts`). NOT a clean cut; deleting needs the test assertions removed too — out of scope for a dead-code pass, leave them.
- `decodeJwtExpMs`, `buildIsolatedEnv`, `buildWorkerUrl` exports — KEEP. Each is used internally AND by tests; the "drop unused export" claim is wrong (decodeJwtExpMs also called at oauth-token.ts:210/231/302; buildIsolatedEnv at EnvManager.ts:265; buildWorkerUrl at worker-utils.ts:185).
- `path-utils.isDirectChild` — KEEP AS-IS. The 30-line body's suffix-match (lines 25-34) is load-bearing: tests assert relative-file vs absolute-folder matches (`session-search-path-matching.test.ts:29,33,37,41`) that a `path.dirname(a)===b` swap would break. `path.dirname` claim rejected.
- `timeline-formatting.ts` 3 `toLocaleString` wrappers (20/31/40) — DROP from plan. Distinct option objects + distinct callers; the triple-dedup already happened historically. Collapsing saves ~0 net lines and hurts readability.
- `postgres/config` "env-injection wrapper" — DROP from plan. The `env` param is a test seam and `getPostgresDatabaseUrl` is a trivial readable helper; not over-engineering.
- `SettingsDefaultsManager.getBool` (181) — test-only (`settings-defaults-manager.test.ts:349-355`); leave unless you also drop the test. Excluded from clean-cut list.
- `WORKER_FALLBACK_BRAND`/`isWorkerFallback` — KEEP. `isWorkerFallback` used in 7+ src handlers (context, summarize, observation, user-message, session-init, file-context, file-edit). The brand-symbol→plain-field "yagni" rewrite is a refactor, not a deletion, with broad blast radius — out of scope for this slice.
- `readTimeoutEnv`/`parseBoundedTimeout`/`readSettingsBackedTimeout` — the "collapse to one helper" is plausible but they have distinct responsibilities (env-only vs settings-backed-with-fallback); a merge risks the bounds/fallback logic. Left out of this slice as net-neutral; revisit only if a follow-up wants it.

**Verify gate:**
`grep -rn "\.upsert(\|getByRootPath\|getByMemorySessionId\|getByLegacyObservationId\|\.createMany\b\|getWorkerSocketPath\|createBackupFilename\|ENV_FILE_PATH" src/ tests/ scripts/` returns only the surviving definitions you intend to remove (0 callers), AND `grep -rn "\.getMember(" src/ tests/ scripts/ | grep -v sqlite` → 0, then `bunx tsc --noEmit` (baseline is exit 0) + `bun test tests/env-isolation.test.ts tests/shared/oauth-token.test.ts tests/shared/worker-utils*.test.ts tests/hooks/server-beta-client.test.ts tests/storage/ tests/server/auth-api-key.test.ts`.

**Est:** −170 lines (≈ −30 EnvManager loop, −15 parseEnvFile, −11 fetchWithTimeout, −6×~6 dead repo methods ≈ −36, −10 paths.ts, −2 ENV_FILE_PATH). Note: this is well under the hunter's "~430" — the bulk of that figure assumed the `TeamsRepository` delete (~97 lines) and several test-backed methods that verification rejected.

---

Final confirmations complete. Key nuances:

- **`renderAgentColumnKey`/`renderAgentContextIndex`**: called by `HeaderRenderer.ts` (live, but always return `[]`). These are NOT zero-caller — they're invoked, just inert. Deleting requires removing the `output.push(...Agent.renderAgentColumnKey())` call sites too. The Human variants (`renderHumanColumnKey`/`renderHumanContextIndex`) do real work, so the if/else branches stay but the Agent arms collapse to nothing.
- **`renderAgentFileHeader`**: zero production callers (only a test). TimelineRenderer uses `renderHumanFileHeader` unconditionally. Genuinely dead production fn + test.
- **ModeManager `getObservationConcepts`/`validateType`/`getTypeLabel`**: zero callers anywhere including tests. Clean delete.
- **`asyncHandler` (services/server)**: zero callers, not even in its test. Clean delete.
- **`getChildProcesses`/`parseElapsedTime`**: zero PRODUCTION callers, but have dedicated test files — orphaned helpers + their tests.

I have everything needed. Producing the plan section.

## Slice: services-misc + npx-cli (telemetry / infrastructure / smart-file-read / context / transcripts / domain / server / npx-cli)  (~−320 lines)
**Scope:** `src/services/telemetry/`, `src/services/infrastructure/`, `src/services/smart-file-read/`, `src/services/context/`, `src/services/transcripts/`, `src/services/domain/`, `src/services/server/`, `src/npx-cli/`
**Ponytail lens (why each exists):** Most of these are the residue of removed features — a deleted ps-reaper left `getChildProcesses`/`parseElapsedTime` (kept alive only by their own tests), an agent-formatting variant that was hollowed to `return []` but never deleted, mode-manager getters nobody calls, and three barrel files no module imports. Answer for those: **delete it**. The telemetry rollup/SQL duplication and the runtime spawn copies **earn their place but should be deduped** (shared `asMs`, one `spawnPlugin`), and the `error instanceof Error ? … : new Error(String(…))` ternary is real but pervasive enough that a `toError()` helper pays for itself.

**Findings (ranked, biggest cut first):**

| tag | what to cut | replacement | path:line | pre-delete verify (grep that must return 0 / expected) |
|-----|-------------|-------------|-----------|--------------------------------------------------------|
| shrink | `error instanceof Error ? error : new Error(String(error))` ternary, 54 occurrences repo-wide (heavy in CleanupV12_4_3, ProcessManager, WorktreeAdoption, backfill) | one `toError(e): Error` helper in `src/utils/` (no helper exists today) | `src/services/infrastructure/CleanupV12_4_3.ts:61,72,150,167,181,203`; `ProcessManager.ts:491`; `backfill.ts:641` (+others) | `grep -rcn "instanceof Error ?" src/services src/npx-cli --include="*.ts"` → 54 sites; after: `grep -rn "toError(" src/utils` → 1 def |
| delete | `getChildProcesses` (ps-reaper leftover) + its test | remove fn + `tests/infrastructure/wmic-parsing.test.ts` block | `src/services/infrastructure/ProcessManager.ts:220` | `grep -rn "getChildProcesses" src/ --include="*.ts" \| grep -v ProcessManager.ts` → 0 (only test calls it) |
| delete | `parseElapsedTime` (ps-reaper leftover) + its test | remove fn + `tests/infrastructure/process-manager.test.ts` describe block | `src/services/infrastructure/ProcessManager.ts:249` | `grep -rn "parseElapsedTime" src/ --include="*.ts" \| grep -v ProcessManager.ts` → 0 (only test calls it) |
| delete | ModeManager `getObservationConcepts` / `validateType` / `getTypeLabel` | drop the three methods | `src/services/domain/ModeManager.ts:176,190,194` | `grep -rn "getObservationConcepts\|getTypeLabel\|\.validateType" src/ tests/ --include="*.ts" \| grep -v ModeManager.ts` → 0 |
| delete | AgentFormatter `renderAgentFileHeader` (return `[]`, no prod caller) + its test | drop fn + `tests/context/formatters/agent-formatter.test.ts:222` block | `src/services/context/formatters/AgentFormatter.ts:82` | `grep -rn "renderAgentFileHeader" src/ --include="*.ts" \| grep -v AgentFormatter.ts` → 0 |
| delete | AgentFormatter `renderAgentColumnKey` + `renderAgentContextIndex` (both `return []`) AND the two `output.push(...Agent.renderAgentColumnKey())` / `...renderAgentContextIndex()` arms that call them | collapse the if/else in HeaderRenderer so only the Human arms remain; drop the two fns + their tests | def: `AgentFormatter.ts:43,47`; call sites: `src/services/context/sections/HeaderRenderer.ts:30,36` | after edit: `grep -rn "renderAgentColumnKey\|renderAgentContextIndex" src/ --include="*.ts"` → 0 |
| delete | `asyncHandler<T>` standalone export (no importer, not even its own test) | remove fn | `src/services/server/ErrorHandler.ts:67` | `grep -rn "asyncHandler" src/services/server/ tests/server/ --include="*.ts"` → only the def line (`errorHandler`/`notFoundHandler` stay — used by `Server.ts:9`) |
| delete | `PriorMessages.userMessage` field — every producer hard-codes `userMessage: ''` and no renderer reads it (only `assistantMessage` is rendered) | drop field from interface + the `userMessage: ''` literals | `src/services/context/types.ts:82`; literals at `ObservationCompiler.ts:220,222,226,233,244,249` | `grep -rn "\.userMessage\|userMessage:" src/services/context --include="*.ts"` → only the `: ''` literals you're deleting; renderers read `.assistantMessage` only |
| delete | `src/services/context/index.ts` barrel — re-exports 9 symbols, **zero importers** (only `context-generator.ts` imports it; consumers hit source files directly) | inline: point `context-generator.ts:3` at `./context/ContextBuilder.js`, delete the barrel | `src/services/context/index.ts` | `grep -rn "from ['\"][^'\"]*services/context['\"]" src/ tests/ --include="*.ts"` → 0; only `context-generator.ts:3` imports `context/index.js` |
| delete | `src/services/server/index.ts` barrel — zero importers (consumers import `Server.js`/`ErrorHandler.js` directly) | delete file | `src/services/server/index.ts` | `grep -rn "from ['\"][^'\"]*services/server['\"]" src/ tests/ --include="*.ts"` → 0 |
| delete | `src/services/server/Middleware.ts` — 4-symbol re-export of `worker/http/middleware.js`, zero importers | delete file; callers already import the real `middleware.js` | `src/services/server/Middleware.ts` | `grep -rn "services/server/Middleware" src/ tests/ --include="*.ts"` → 0 |
| shrink | duplicate `asMs(col)` — byte-identical in two files | extract to a shared telemetry util (e.g. add to `telemetry/common.ts`), import in both | `src/services/telemetry/install-stats.ts:23` + `src/services/telemetry/backfill.ts:93` | `grep -rn "function asMs" src/services/telemetry` → 1 def after |
| shrink | 4 near-identical `spawnHidden(bunPath, …)` blocks (same env-sanitize + `child.on('error'/'close')` boilerplate) | one `spawnPlugin(scriptPath, args)` helper | `src/npx-cli/commands/runtime.ts:50,80,156,248` | `grep -cn "spawnHidden(bunPath" src/npx-cli/commands/runtime.ts` → 1 after |
| shrink | CleanupV12_4_3 count-subquery trio duplicated verbatim across two functions | extract `countObserverSessionRows(db)` | `src/services/infrastructure/CleanupV12_4_3.ts:82-87` and `:227-231` | both copies identical (`SELECT COUNT(*) … user_prompts/observations/session_summaries WHERE … IN (SELECT … sdk_sessions WHERE project = ?)`) |
| native | `bun-resolver` `spawnSync(which/where, ['bun'])` | `Bun.which('bun')` | `src/npx-cli/utils/bun-resolver.ts:24-25` | runtime is Bun (CLAUDE.md); `Bun.which` is available — confirm no node-only entrypoint hits this path |
| native | telemetry `detectOsVersion()` try/catch wrapper around `os.release()` | inline `os.release()` (it doesn't throw); drop the helper | `src/services/telemetry/common.ts:87-93` | single caller at `common.ts:108` |
| yagni | redeclared `const IS_WINDOWS = process.platform === 'win32'` ×3 | import the exported one from `paths.ts:21` | `npm-install-helper.ts:19`, `setup-runtime.ts:10`, `doctor.ts:26` (keep `paths.ts:21` export) | `grep -rn "const IS_WINDOWS" src/npx-cli` → 1 (only paths.ts) after |
| yagni | `context-generator.ts` single-export shim (`export { generateContext, … } from './context/index.js'`) | collapse: SearchRoutes dynamic-imports `context-generator.js` — repoint it at `context/ContextBuilder.js` and delete the shim | `src/services/context-generator.ts` (caller: `worker/http/routes/SearchRoutes.ts:361`) | after repoint: `grep -rn "context-generator" src/ --include="*.ts"` → 0 |

**Risks / do-NOT-touch:**
- **`infrastructure/index.ts` barrel — KEEP.** Hunter said delete, but `src/shared/worker-utils.ts:12` imports `checkVersionMatch` through it. Either keep the barrel or repoint that one import at `HealthMonitor.js`; do not blind-delete.
- **`CODEX_SAMPLE_SCHEMA` / `transcripts/config.ts` — KEEP (NOT dead).** `CODEX_SAMPLE_SCHEMA` is referenced inside `config.ts`, and `config.ts` is heavily live (`worker-service.ts:93`, `processor.ts:10`, `cli.ts:1` import `loadTranscriptWatchConfig`, `writeSampleConfig`, `shouldSuppressNativeCodexAgentsContext`, `expandHomePath`, `filterNativeHookBackedCodexWatches`). Drop this claim.
- **`npx withRetry` — KEEP, do not touch in this slice.** The `error-reporter.ts:169` `withRetry` is test-only/standalone, but the name collides with the live `services/worker/retry.ts` `withRetry` (used by Gemini/OpenRouter providers). `worker/` is out of scope; verify before removing `error-reporter`'s copy.
- **`paths.ts` `readJsonSafe` re-export — borderline KEEP.** `npx-cli/utils/paths.ts:102` re-exports it, but install/uninstall import `readJsonSafe` straight from `utils/json-utils.js` (not via paths). The re-export has no consumers, so it's deletable — but low value (1 line) and the source `json-utils.readJsonSafe` is widely live; only remove the dead re-export line, never the function.
- **`renderAgentColumnKey`/`renderAgentContextIndex`/`renderAgentFileHeader`** are still wired into `HeaderRenderer`/`TimelineRenderer` (Agent arms) and covered by `agent-formatter.test.ts` — deletion MUST update the call sites and tests in the same change, or `tsc` breaks.
- **`getQueryFile` mkdtemp cache (smart-file-read) — KEEP.** Tree-sitter CLI needs an on-disk `.scm` path; the per-key cache + single temp dir is the minimal correct form. Hunter's "static .scm → drop cache" is wrong (you'd rewrite the file every parse). Drop this claim.
- **telemetry `resolveTelemetryConsent`/`explainTelemetryConsent` split — KEEP.** `resolveTelemetryConsent` has 3 live callers; `explainTelemetryConsent` is needed by the CLI for its `source` field. Both earn their place; downgrade from yagni.
- **`node_version` vs `runtime_version` — KEEP.** On a Bun runtime they differ (`runtime_version = bun ?? node`, `node_version = node`); both are scrubbed/allowlisted (`scrub.ts:17-18`). Not redundant. Drop this claim.
- **install.ts `mergeSettings`/`readRawStoredAuthMethod`/`readStoredSignup` — KEEP, NOT dups.** Single definitions, called many times within install.ts only; no cross-file duplication. Drop the "dup" framing. The 3 `nextSteps` arrays ARE ~90% duplicated text (3 branches × ~14 lines) and could share a builder — that's a real ~25-line shrink, but it's prose-heavy and low-risk-of-breakage; optional.
- **`collectDailyRollups` 8 blocks — DOWNGRADE to optional.** Hunter called them "near-identical → table+loop." They share the `frag()`/`params` scaffolding (already factored) but each has distinct SQL (different tables, GROUP BY, and per-row JS bucketing — status enums, platform enums, type buckets). A naive table+loop can't express the divergent post-query JS cleanly; only the 3 plain `COUNT(*)` blocks (observation_count, subagent_obs_count, session_count) are loop-able. Limit the shrink to those.
- **`server-runtime-setup` unconsumed plan fields:** `ServerRuntimeInstallPlan`/`UninstallPlan` are live (`install.ts`, `uninstall.ts` import `planServerRuntimeInstall`/`planServerRuntimeUninstall`). I did not find individual unconsumed fields confirmed — needs field-level read before any cut; treat as UNVERIFIED, do not act on it this slice.

**Verify gate:**
```
grep -rn "getChildProcesses\|parseElapsedTime" src/ --include="*.ts" | grep -v ProcessManager.ts        # 0
grep -rn "getObservationConcepts\|getTypeLabel\|\.validateType" src/ tests/ --include="*.ts" | grep -v ModeManager.ts   # 0
grep -rn "renderAgentColumnKey\|renderAgentContextIndex\|renderAgentFileHeader" src/ --include="*.ts" | grep -v AgentFormatter.ts   # 0 after call-site edits
grep -rn "asyncHandler" src/services/server/ tests/server/ --include="*.ts"   # 0
grep -rn "from ['\"][^'\"]*services/context['\"]\|services/server['\"]\|services/server/Middleware" src/ tests/ --include="*.ts"   # 0
```
then `bunx tsc --noEmit` + `bun test tests/infrastructure tests/context tests/server tests/telemetry` (and update/remove the orphaned `wmic-parsing.test.ts`, `process-manager.test.ts` parseElapsedTime block, `agent-formatter.test.ts` deleted-fn blocks).

**Est:** −320 lines (≈ −95 from the 3 dead barrels + AgentFormatter/ModeManager/asyncHandler/parseElapsedTime/getChildProcesses deletions and their tests; ≈ −110 from the `toError()` ternary collapse across 54 sites; ≈ −115 from spawnPlugin/asMs/CleanupV12_4_3/IS_WINDOWS/detectOsVersion/context-generator dedup).

Relevant files: `/Users/alexnewman/.superset/worktrees/df8069a7-eb08-4626-9d3d-918d1e12eb9f/zippy-fruit/src/services/infrastructure/ProcessManager.ts`, `.../src/services/infrastructure/CleanupV12_4_3.ts`, `.../src/services/domain/ModeManager.ts`, `.../src/services/context/formatters/AgentFormatter.ts`, `.../src/services/context/sections/HeaderRenderer.ts`, `.../src/services/context/types.ts`, `.../src/services/context/ObservationCompiler.ts`, `.../src/services/context/index.ts`, `.../src/services/context-generator.ts`, `.../src/services/server/ErrorHandler.ts`, `.../src/services/server/index.ts`, `.../src/services/server/Middleware.ts`, `.../src/services/telemetry/backfill.ts`, `.../src/services/telemetry/install-stats.ts`, `.../src/services/telemetry/common.ts`, `.../src/npx-cli/commands/runtime.ts`, `.../src/npx-cli/utils/bun-resolver.ts`, `.../src/npx-cli/install/npm-install-helper.ts`, `.../src/npx-cli/install/setup-runtime.ts`, `.../src/npx-cli/commands/doctor.ts`.

---

# Execution order & accounting

**Recommended order** (independent except where noted):
1. **Slice 1 — SQLite** (companion doc) — most data-shaped, do it isolated and first.
2. **Pure dead-code deletes next** (server outbox/mcp, bin/adapters, storage teams.ts, telemetry/infra dead fns) — lowest risk, no behavior change, fastest wins.
3. **stdlib/native swaps** (EnvManager→util.parseEnv, fetchWithTimeout→AbortSignal.timeout, Bun.which) — behavior-preserving, small.
4. **The two big consolidations last** — the 5-installer unification (integrations slice) and the SearchManager timeline/hybrid-search dedup (worker slice). Highest blast radius; each lands alone with full test runs.

**Net target:** ~−9,800 lines across the audit (Slice 0 done ≈ −430; Slice 1 ≈ −3,200 src / −1,340 test; Slices 2–7 ≈ the remainder). Per-slice estimates are **upper bounds** — the two big consolidations only hit their numbers if behavior is genuinely identical, which the executing agent must confirm, not assume.

**Standing reminders for every slice:**
- Run each finding's pre-delete grep; downgrade any claim that no longer verifies.
- Honor each slice's *Risks / do-NOT-touch* list.
- Gate: grep-clean → `bunx tsc --noEmit` → `bun test` → `npm run build-and-sync` → worker boots → commit.
