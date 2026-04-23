# Plan 05 — context-injection-engine (U2 unified renderObservations)

**Date**: 2026-04-22
**Flowchart**: `PATHFINDER-2026-04-21/05-clean-flowcharts.md` section **3.5** (context-injection-engine clean)
**Before-state**: `PATHFINDER-2026-04-21/01-flowcharts/context-injection-engine.md`
**Design authority**: `05-clean-flowcharts.md` Part 1 item #34, Part 2 Decision **D4**, Part 3 section **3.5**.

---

## Dependencies

**Upstream**: none direct. This plan *introduces* **U2 `renderObservations(obs, strategy)`** — the single traversal that all four existing formatters become strategy configs for.

**Downstream**:
- `06-hybrid-search-orchestration` — `SearchResultStrategy` is a `renderObservations` strategy (05 section 3.6 arrow `Fmt -->|markdown| M["renderObservations(results, SearchResultStrategy)"]`).
- `10-knowledge-corpus-builder` — `CorpusDetailStrategy` is a `renderObservations` strategy (05 section 3.11 arrow `D --> E["renderObservations(obs, CorpusDetailStrategy)"]`).
- `09-lifecycle-hooks` — consumes the single `GET /api/session/start` endpoint introduced in 05 section 3.1; that endpoint returns `{sessionDbId, contextMarkdown, semanticMarkdown}` in one payload (Phase 6 below).

**Note on `06-implementation-plan.md`**: Phase 8 of the implementation plan covers the same renderer unification and owns the verification-findings list (V1–V20). **There is no V-number for `renderObservations` itself** — the audit's item #34 is the sole design reference. Cited here explicitly so downstream agents don't look for a V-number that doesn't exist.

---

## Sources consulted

1. `PATHFINDER-2026-04-21/05-clean-flowcharts.md` — full file (607 lines). Section 3.5 at lines 232–258; Part 1 item #34 at line 52; Decision D4 at line 75; deletion ledger row for this refactor at line 543 (−600 lines formatters → +320 renderer + 4 strategies = **−280 net**).
2. `PATHFINDER-2026-04-21/06-implementation-plan.md` — Phase 8 at lines 368–408. No V-number for renderObservations.
3. `PATHFINDER-2026-04-21/01-flowcharts/context-injection-engine.md` — before diagram; documents the existing two-path surface (`/api/context/inject` GET for SQLite context + `/api/context/semantic` POST for Chroma injection) and the HeaderRenderer/TimelineRenderer/SummaryRenderer/FooterRenderer fan-out.
4. Live codebase — file:line table below.
5. Existing 07-plans/ — directory empty at planning time; this is the first plan file.

### Live file:line inventory (the four formatters + orchestration)

| Concern | File | Lines | Key symbols |
|---|---|---|---|
| **AgentFormatter** (LLM markdown) | `src/services/context/formatters/AgentFormatter.ts` | 227 | `renderAgentHeader` :36, `renderAgentLegend` :46, `renderAgentContextEconomics` :75, `renderAgentDayHeader` :103, `renderAgentTableRow` :127, `renderAgentFullObservation` :142, `renderAgentSummaryItem` :177, `renderAgentSummaryField` :189, `renderAgentPreviouslySection` :197, `renderAgentFooter` :214, `renderAgentEmptyState` :225, private `compactTime` :120, private `formatHeaderDateTime` :21 |
| **HumanFormatter** (ANSI terminal) | `src/services/context/formatters/HumanFormatter.ts` | 238 | `renderHumanHeader` :35, `renderHumanLegend` :47, `renderHumanColumnKey` :60, `renderHumanContextIndex` :72, `renderHumanContextEconomics` :87, `renderHumanDayHeader` :116, `renderHumanFileHeader` :126, `renderHumanTableRow` :135, `renderHumanFullObservation` :155, `renderHumanSummaryItem` :186, `renderHumanSummaryField` :200, `renderHumanPreviouslySection` :208, `renderHumanFooter` :225, `renderHumanEmptyState` :236, private `formatHeaderDateTime` :20 |
| **ResultFormatter** (search markdown, class) | `src/services/worker/search/ResultFormatter.ts` | 301 | `class ResultFormatter` :21, `formatSearchResults` :25 (the top-level walker), `combineResults` :115, `formatSearchTableHeader` :141, `formatTableHeader` :149, `formatObservationSearchRow` :157, `formatSessionSearchRow` :178, `formatPromptSearchRow` :199, `formatObservationIndex` :221, `formatSessionIndex` :237, `formatPromptIndex` :250, `estimateReadTokens` :264, `formatChromaFailureMessage` :275, `formatSearchTips` :288 |
| **CorpusRenderer** (corpus detail, class) | `src/services/worker/knowledge/CorpusRenderer.ts` | 133 | `class CorpusRenderer` :10, `renderCorpus` :14 (the top-level walker), `renderObservation` :39 (private, the per-obs detail renderer), `estimateTokens` :90, `generateSystemPrompt` :97 |
| Orchestrator | `src/services/context/ContextBuilder.ts` | 186 | `generateContext` :130, `buildContextOutput` :80, `initializeDatabase` :49, `renderEmptyState` :73 (calls both empty-state functions) |
| Day-grouping walker (shared today) | `src/services/context/sections/TimelineRenderer.ts` | 183 | `groupTimelineByDay` :21, `renderTimeline` :168, `renderDayTimeline` :151 (forHuman branch :159), `renderDayTimelineAgent` :56, `renderDayTimelineHuman` :97, private `getDetailField` :46 |
| Section dispatch (forHuman branching) | `src/services/context/sections/HeaderRenderer.ts` | 61 | `renderHeader` :15 (branches forHuman for 5 sub-sections) |
| Section dispatch | `src/services/context/sections/SummaryRenderer.ts` | 65 | `shouldShowSummary` :15, `renderSummaryFields` :46 (branches forHuman) |
| Section dispatch | `src/services/context/sections/FooterRenderer.ts` | 42 | `renderPreviouslySection` :15 (branches forHuman), `renderFooter` :28 (branches forHuman) |
| Token economics (KEEP) | `src/services/context/TokenCalculator.ts` | 78 | `calculateTokenEconomics`, `formatObservationTokenDisplay`, `shouldShowContextEconomics` |
| Mode filtering (KEEP) | `src/services/domain/ModeManager.ts` | 266 | `ModeManager.getInstance()`, `getActiveMode`, `getTypeIcon`, `getWorkEmoji` |
| HTTP caller (today) | `src/services/worker/http/routes/SearchRoutes.ts` | — | `handleContextInject` :209 (GET, dynamically imports `context-generator.generateContext`), `handleSemanticContext` :258 (POST, inlines its own formatter at :286–293) |

**Top-level LoC of the four formatters**: 227 + 238 + 301 + 133 = **899 lines**. Section dispatch files (Header/Summary/Footer/Timeline) add another 61 + 65 + 42 + 183 = **351 lines of forHuman branching** that collapse once strategies own the shape.

### Copy-ready: the shared "walk" all four formatters share

Every formatter does some subset of the same four-step traversal. The invariants below become the body of `renderObservations`:

1. **Optional header**: project/title/date line + legend + economics. Today: `HeaderRenderer.renderHeader` (`HeaderRenderer.ts:15`) + `ResultFormatter.formatSearchResults` :53 + `CorpusRenderer.renderCorpus` :17. → Strategy flag: `header: 'context' | 'search' | 'corpus' | 'none'`.
2. **Group and iterate** — the core walk. Today: `groupTimelineByDay` (`TimelineRenderer.ts:21`) for agent/human paths; `groupByDate` (`shared/timeline-formatting.ts`) + file-bucketing at `ResultFormatter.ts:56–72` for search; flat iteration for corpus at `CorpusRenderer.ts:28–31`. → Strategy flag: `grouping: 'by-day' | 'by-day-then-file' | 'none'`.
3. **Per-observation row** — either compact line or full-detail block. Today: `renderAgentTableRow`/`renderAgentFullObservation`, `renderHumanTableRow`/`renderHumanFullObservation`, `formatObservationSearchRow`/`formatObservationIndex`, `CorpusRenderer.renderObservation`. → Strategy flag: `density: 'compact' | 'table' | 'full-detail'` + `colorize: boolean` + `columns: [...]` + `showTokens: {read, work}`.
4. **Optional tail**: summary fields + previously section + footer tips. Today: `SummaryRenderer.renderSummaryFields`, `FooterRenderer.renderPreviouslySection`, `FooterRenderer.renderFooter`, `ResultFormatter.formatSearchTips`. → Strategy flag: `tail: 'context' | 'search-tips' | 'corpus-stats' | 'none'`.

The **five constants** all four share: `ModeManager.getTypeIcon(type)` for the type emoji, `formatTime(epoch)` / `formatDate` / `formatDateTime` from `shared/timeline-formatting.ts`, `extractFirstFile` for file extraction, `parseJsonArray` for facts parsing, and the title-fallback rule `obs.title || 'Untitled'`. These move unchanged into the renderer.

### Confidence + gaps

**High confidence**:
- File inventory, LoC, and symbol-level API of the four formatters.
- That all four read the same shape (`Observation` with `id/title/narrative/facts/type/created_at_epoch/files_modified/files_read`).
- Decision D4's four-strategy ceiling: **Agent, Human, SearchResult, CorpusDetail** — no others.

**Gaps / risks**:
- **ANSI-color preservation in `HumanContextStrategy` is a regression surface**. `HumanFormatter.ts` uses `colors.bright`, `colors.cyan`, `colors.gray`, `colors.dim`, `colors.yellow`, `colors.magenta`, `colors.green`, `colors.blue` imported from `../types.js`. Any divergence — including trailing spaces around ANSI wrappers, padding in `renderHumanTableRow` at :145 (`' '.repeat(time.length)` when `showTime=false`), and the `─`×60 separator at `:39` and `:237` — is a user-visible regression. Phase 8 fixtures must assert byte equality including escape sequences.
- **ResultFormatter has two row formats** (`formatSearchTableHeader` without `Work` column + `formatTableHeader` with `Work` column). `SearchResultStrategy` must support both, gated by a `columns` array — otherwise index-rendering callers (`formatObservationIndex` used elsewhere) regress silently. Grep during Phase 4 to enumerate callers before choosing defaults.
- Semantic-injection POST handler at `SearchRoutes.ts:286–293` implements **its own mini-formatter** (`## Relevant Past Work (semantic match)` header + `### title (date)` + narrative). Anti-pattern E forbids this post-refactor. Phase 6 folds it into a `SearchResultStrategy` variant or a narrow `SemanticInjectStrategy` (still counts as a `SearchResult` strategy per Decision D4's four-total rule — treat this as a strategy *flag*, not a fifth strategy).

---

## Phase contract (applies to every phase)

Every phase below carries:
- **(a) What**: "Copy from …" instructions. The four existing formatters become four strategy configs feeding ONE `renderObservations`.
- **(b) Docs**: `05-clean-flowcharts.md` section 3.5 + Decision D4 + live file:line for each of the four formatters (table above).
- **(c) Verification**: unit tests per strategy against a fixed `Observation[]` fixture; **byte-for-byte match** against the old formatter's output for identical inputs.
- **(d) Anti-pattern guards**:
  - **Guard A** (audit Part 2): only four strategies — `AgentContextStrategy`, `HumanContextStrategy`, `SearchResultStrategy`, `CorpusDetailStrategy`. Any fifth strategy fails review.
  - **Guard E** (audit Part 2): single renderer path. No caller may implement its own walker. Grep check (Phase 8) enforces.

---

## Phase 1 — Extract common traversal into `renderObservations(obs, strategy)`

**(a) What**:
Create a new module `src/services/rendering/renderObservations.ts` (new folder `src/services/rendering/` so no caller is forced to import across feature boundaries). Copy the *walk* from the three existing walkers:
- Day grouping: from `TimelineRenderer.groupTimelineByDay` (`src/services/context/sections/TimelineRenderer.ts:21`).
- Day-then-file grouping: from `ResultFormatter.formatSearchResults` (`src/services/worker/search/ResultFormatter.ts:56–72`).
- Flat iteration: from `CorpusRenderer.renderCorpus` (`src/services/worker/knowledge/CorpusRenderer.ts:28–31`).

Signature:
```ts
export interface RenderStrategy {
  name: 'agent-context' | 'human-context' | 'search-result' | 'corpus-detail';
  header?: (ctx: HeaderCtx) => string[];
  grouping: 'by-day' | 'by-day-then-file' | 'none';
  renderGroupHeader?: (key: string) => string[];
  renderSubgroupHeader?: (key: string) => string[]; // e.g., file within day
  renderSummaryItem?: (s: SummaryItem, time: string) => string[];
  renderRow: (obs: Observation, ctx: RowCtx) => string;
  renderFullObservation?: (obs: Observation, ctx: RowCtx) => string[];
  tail?: (ctx: TailCtx) => string[];
  emptyState?: (ctx: HeaderCtx) => string;
}
export function renderObservations(
  items: Array<Observation | SummaryItem>,
  strategy: RenderStrategy,
  ctx: RenderContext,
): string;
```

The orchestrator owns: (1) token budget enforcement (from `calculateTokenEconomics`, `TokenCalculator.ts:25`), (2) mode filtering (from `ModeManager.getActiveMode()`, `ModeManager.ts:15`), (3) full-vs-compact selection (from `getFullObservationIds` in `ObservationCompiler.ts`). Strategies **do not** re-implement any of this.

**(b) Docs**: 05 section 3.5 lines 234–251; Decision D4 line 75. File:line for all four formatters per inventory table.

**(c) Verification**:
- Unit tests: `tests/services/rendering/renderObservations.test.ts` — three tests, one per `grouping` mode, with a synthetic `Observation[]` of 5 items across 2 days and 3 files.
- Build check: `npm run build-and-sync` passes after new module is in place (not yet wired).

**(d) Anti-pattern guards**: A — stop at four strategy names (compile-time `name` union enforces). E — module is the single renderer; callers will switch to it in Phase 6, Phase 7 deletes the old paths.

---

## Phase 2 — `AgentContextStrategy` from `AgentFormatter`

**(a) What**: Create `src/services/context/strategies/AgentContextStrategy.ts` and copy the output-shape bytes from `AgentFormatter.ts` into strategy callbacks:
- `header` ← `renderAgentHeader` (:36) + `renderAgentLegend` (:46) + `renderAgentColumnKey` (:61, no-op) + `renderAgentContextIndex` (:68, no-op) + `renderAgentContextEconomics` (:75) composed in order per `HeaderRenderer.renderHeader` :15.
- `grouping: 'by-day'`; `renderGroupHeader` ← `renderAgentDayHeader` (:103).
- `renderSummaryItem` ← `renderAgentSummaryItem` (:177).
- `renderRow` ← `renderAgentTableRow` (:127); `renderFullObservation` ← `renderAgentFullObservation` (:142).
- `tail` ← `renderAgentSummaryField` (:189) for each of the four fields + `renderAgentPreviouslySection` (:197) + `renderAgentFooter` (:214).
- `emptyState` ← `renderAgentEmptyState` (:225).

The shared `formatHeaderDateTime` (:21) and `compactTime` (:120) move into `src/services/rendering/render-helpers.ts` or stay inline in the strategy (two callers — no DRY pressure yet).

**(b) Docs**: 05 section 3.5 arrow `Strategy -->|AgentContextStrategy| AgentOut["Compact markdown for LLM"]` (line 244); inventory row for `AgentFormatter.ts` above.

**(c) Verification**: snapshot test — feed the same `Observation[]` fixture to (i) the old `buildContextOutput(..., forHuman=false)` and (ii) `renderObservations(items, AgentContextStrategy, ctx)`; assert string equality. Zero-tolerance: LLM context is consumed by models — any whitespace change shifts KV-cache and can surface as behavioral regressions.

**(d) Anti-pattern guards**: A — strategy file defines the config object only, no walker. E — no custom grouping code; reuse Phase 1's `by-day` grouping.

---

## Phase 3 — `HumanContextStrategy` from `HumanFormatter` (preserves ANSI)

**(a) What**: Create `src/services/context/strategies/HumanContextStrategy.ts`. Copy output-shape bytes from `HumanFormatter.ts`:
- `header` ← `renderHumanHeader` (:35) + `renderHumanLegend` (:47) + `renderHumanColumnKey` (:60) + `renderHumanContextIndex` (:72) + `renderHumanContextEconomics` (:87).
- `grouping: 'by-day-then-file'`; `renderGroupHeader` ← `renderHumanDayHeader` (:116); `renderSubgroupHeader` ← `renderHumanFileHeader` (:126).
- `renderSummaryItem` ← `renderHumanSummaryItem` (:186).
- `renderRow` ← `renderHumanTableRow` (:135) — **preserves `colors.dim`, `colors.cyan`, `colors.bright`, `colors.reset` escapes and the ` '.repeat(time.length)` padding for `showTime=false`** (see HumanFormatter.ts:145).
- `renderFullObservation` ← `renderHumanFullObservation` (:155).
- `tail` ← `renderHumanSummaryField` (:200) per field (with its per-field ANSI color from `SummaryRenderer.ts:52–56` — `blue/yellow/green/magenta`) + `renderHumanPreviouslySection` (:208) + `renderHumanFooter` (:225).
- `emptyState` ← `renderHumanEmptyState` (:236) — note the literal `─`×60 separator and the `\n` layout.

ANSI `colors` import from `src/services/context/types.js` stays inside this strategy only. The renderer core is ANSI-agnostic.

**(b) Docs**: 05 section 3.5 arrow `Strategy -->|HumanContextStrategy| HumanOut["ANSI-colored terminal"]` (line 245); inventory row for `HumanFormatter.ts`; D4 explicit about "columns/density/grouping" plus `colorize` per Phase 8 sketch in 06-implementation-plan.md line 385.

**(c) Verification**: snapshot test with explicit ANSI-escape comparison. Fixture MUST include: a no-time continuation row (to exercise the `' '.repeat(time.length)` padding at :145), a full-observation row with facts (exercises :167–177), and the empty-state path (exercises :237). Assert raw buffer equality — not stripped-ANSI equality. Confidence gap: this is the highest regression risk in the plan (see Gaps above).

**(d) Anti-pattern guards**: A — one human strategy. E — no duplicate ANSI wrapping helper; `colors` constants travel with the strategy.

---

## Phase 4 — `SearchResultStrategy` from `ResultFormatter`

**(a) What**: Create `src/services/worker/search/strategies/SearchResultStrategy.ts`. Copy from `ResultFormatter.ts`:
- `header` ← the `Found N result(s) matching "…"` line at :53 (parameterized on query + counts).
- `grouping: 'by-day-then-file'`; `renderGroupHeader` ← day label ``### ${day}`` (:57); `renderSubgroupHeader` ← `**${file}**` + `formatSearchTableHeader` :141 (the `| ID | Time | T | Title | Read |` header).
- `renderRow` dispatches on item kind: `formatObservationSearchRow` (:157), `formatSessionSearchRow` (:178), `formatPromptSearchRow` (:199). The `lastTime` threading for `"` continuation stays in the renderer's `RowCtx` (from Phase 1).
- `tail` ← `formatSearchTips` (:288) appended when not empty.
- `emptyState` ← `No results found matching "${query}"` (:38) / `formatChromaFailureMessage` (:275) gated by a new `ctx.chromaFailed` flag.

The index-column variant (`formatObservationIndex` :221 etc., with the `Work` column) becomes a strategy *option* `columns: ['id','time','type','title','read'] | ['id','time','type','title','read','work']`. Before choosing a default, grep Phase 4 callers to enumerate usages — confidence gap noted above.

**(b) Docs**: 05 section 3.6 line 281 (`renderObservations(results, SearchResultStrategy)`); inventory row for `ResultFormatter.ts`. Cross-reference: `06-hybrid-search-orchestration` plan (downstream) will consume this strategy.

**(c) Verification**: feed the same `SearchResults` fixture to `ResultFormatter.formatSearchResults` and to `renderObservations(combined, SearchResultStrategy, ctx)`; assert byte equality including the date-group headers, file headers, table pipe characters, and trailing blank lines.

**(d) Anti-pattern guards**: A — single `SearchResultStrategy`; if semantic-injection handler at `SearchRoutes.ts:286–293` needs a different shape, it becomes a **flag** on this strategy (`variant: 'table' | 'injection'`), not a fifth strategy. E — delete any caller that still walks `results.observations.map(...)` by hand (Phase 7 grep).

---

## Phase 5 — `CorpusDetailStrategy` from `CorpusRenderer`

**(a) What**: Create `src/services/worker/knowledge/strategies/CorpusDetailStrategy.ts`. Copy from `CorpusRenderer.ts`:
- `header` ← `CorpusRenderer.renderCorpus` :14–26 (the `# Knowledge Corpus: …`, description, stats block, `---` divider). Parameterized on `CorpusFile.name/description/stats`.
- `grouping: 'none'` — corpus walks flat (:28–31).
- `renderFullObservation` ← `CorpusRenderer.renderObservation` (:39) — full narrative, facts list, concepts, files_read, files_modified. No compact row form; every observation renders at full detail (per CorpusRenderer.ts:5).
- `tail: undefined` — corpus has no tail beyond the trailing `---`.

`generateSystemPrompt` (:97) is **not** part of the strategy — it's a separate function on the corpus feature that stays where it is. `estimateTokens` (:90) already moves to `shared/timeline-formatting.ts` as `estimateTokens` (it's already there per `ResultFormatter.ts:17` import); delete the duplicate at `CorpusRenderer.ts:90`.

**(b) Docs**: 05 section 3.11 line 457 (`renderObservations(obs, CorpusDetailStrategy)`); inventory row for `CorpusRenderer.ts`. Cross-reference: `10-knowledge-corpus-builder` plan (downstream) consumes this strategy.

**(c) Verification**: feed the same `CorpusFile` to `CorpusRenderer.renderCorpus` and to `renderObservations(corpus.observations, CorpusDetailStrategy, {corpus})`; assert byte equality. Important: corpus output is a *prompt* — whitespace divergence changes prompt-cache hit rate on the SDK side (see 05 section 3.11 cost note, line 476).

**(d) Anti-pattern guards**: A — single `CorpusDetailStrategy`. E — `KnowledgeAgent` and `CorpusBuilder` both route through it; no direct `CorpusRenderer` instantiation post-Phase 7.

---

## Phase 6 — Switch `ContextBuilder.generateContext` + `/api/session/start` handler to `renderObservations`

**(a) What**:
1. Rewrite `src/services/context/ContextBuilder.ts`:
   - `buildContextOutput` :80 collapses to: resolve strategy = `forHuman ? HumanContextStrategy : AgentContextStrategy`, build `RenderContext` (economics, fullObservationIds, priorMessages, mostRecentSummary), call `renderObservations(timeline, strategy, ctx)`. The explicit `renderHeader`/`renderTimeline`/`renderSummaryFields`/`renderPreviouslySection`/`renderFooter` fan-out at :95–119 deletes in favor of strategy-owned `header`/`renderGroupHeader`/`renderRow`/`tail`.
   - `renderEmptyState` :73 collapses to `strategy.emptyState?.(ctx)`.
   - `generateContext` :130 signature is unchanged — external callers see identical input/output.
2. Add the new `/api/session/start` handler (per 05 section 3.1 line 95 `GET /api/session/start?project=…`). Owned by `lifecycle-hooks` plan (09); this plan lands the *renderer-facing* side: one call into `generateContext(forHuman:false)` for `contextMarkdown`, one call into `SearchOrchestrator.search(query, limit=5)` + `renderObservations(results, SearchResultStrategy, {variant:'injection'})` for `semanticMarkdown`. Both served from a single response body.
3. Delete the inline mini-formatter at `SearchRoutes.ts:286–293` (the `## Relevant Past Work …` block); route through `SearchResultStrategy`.

**(b) Docs**: 05 section 3.5 entry arrows lines 236–242; 05 section 3.1 lines 95 + 100 (one `/api/session/start` returns ctx + semantic); 06 plan Phase 8 lines 391–394.

**(c) Verification**:
- End-to-end byte-identity: capture the pre-refactor output of `GET /api/context/inject?projects=X&colors=true` and `…&colors=false` for a seeded DB; after the switch, curl the same and diff. Zero diff.
- New `/api/session/start` returns `{sessionDbId, contextMarkdown, semanticMarkdown}` (per 05 section 3.1 line 100) with the two markdown fields byte-matching the previous two-endpoint responses.
- `npm run build-and-sync` passes.

**(d) Anti-pattern guards**: A — no new strategies introduced. E — `SearchRoutes.handleSemanticContext` either deleted (covered by `/api/session/start`) or its body becomes a single `renderObservations(…, SearchResultStrategy, {variant:'injection'})` call — no more inline `lines.push('### …')`.

---

## Phase 7 — Delete the four old formatter files; update imports

**(a) What**:
1. `rm src/services/context/formatters/AgentFormatter.ts` (227 lines).
2. `rm src/services/context/formatters/HumanFormatter.ts` (238 lines).
3. `rm src/services/worker/search/ResultFormatter.ts` (301 lines).
4. `rm src/services/worker/knowledge/CorpusRenderer.ts` (133 lines).
5. Delete `src/services/context/sections/{HeaderRenderer,TimelineRenderer,SummaryRenderer,FooterRenderer}.ts` — their forHuman branching is now owned by strategies. `ObservationCompiler.ts` keeps the data-loading helpers (`queryObservations`, `buildTimeline`, `getFullObservationIds` — these feed the renderer, not part of the deletion).
6. Update imports at: `ContextBuilder.ts` (switch to `renderObservations` + strategies), `SearchManager.ts` / `SearchRoutes.ts` (switch to `SearchResultStrategy`), `KnowledgeAgent.ts` / `CorpusBuilder.ts` (switch to `CorpusDetailStrategy`). Grep for every `import … from '.*AgentFormatter|HumanFormatter|ResultFormatter|CorpusRenderer'` — expect zero after this phase.

**Net line impact**: deletes 227 + 238 + 301 + 133 + 61 + 183 + 65 + 42 = **1,250 lines**. Adds ~320 for `renderObservations` + 4 strategies + shared helpers. **Net ≈ −930 lines** — beats the audit's estimate at 05 line 543 (−280 net) because the forHuman branching in the section renderers was not counted there.

**(b) Docs**: 05 section 3.5 "Deleted" list lines 253–256; 06 plan Phase 8 verification line 397.

**(c) Verification**:
- `grep -rn "AgentFormatter\|HumanFormatter\|ResultFormatter\|CorpusRenderer" src/ tests/` → zero hits.
- `grep -rn "renderHeader\|renderTimeline\|renderSummaryFields\|renderPreviouslySection\|renderFooter" src/services/context/sections/` → zero hits (directory removed).
- `npx tsc --noEmit` passes.
- `npm run build-and-sync` passes.

**(d) Anti-pattern guards**: D — no compatibility shim re-exports old names. E — single walker; grep `for (const .* of .*observations)` in `src/services/worker/` and `src/services/context/` should only match inside `renderObservations.ts` (and test fixtures).

---

## Phase 8 — Verification: byte-identical output for all four paths

**(a) What**: Add four golden-file fixtures under `tests/fixtures/rendering/`:
- `agent-context.txt` — output of old `generateContext(input, forHuman=false)` captured before Phase 6.
- `human-context.ansi` — raw bytes including ANSI escapes from old `generateContext(input, forHuman=true)`.
- `search-result.md` — output of old `ResultFormatter.formatSearchResults(results, "test query")`.
- `corpus-detail.md` — output of old `CorpusRenderer.renderCorpus(corpus)`.

Capture on the branch tip *before* Phase 1 so the baseline is pre-refactor. Each phase's unit test (Phases 2–5) diffs against its golden file.

A final integration test runs the four renderers end-to-end against a seeded DB and diffs all four outputs simultaneously.

**(b) Docs**: 06 plan Phase 8 verification lines 396–399 ("Snapshot tests: for each strategy, feed the same fixture `Observation[]` and assert output is byte-equal to the old formatter's output").

**(c) Verification**:
- All four snapshot tests green.
- Grep audit: `grep -rn "setInterval\|formatObservation\|renderObservation" src/ | grep -v renderObservations.ts | grep -v test` — zero hits outside the one renderer.
- SessionStart end-to-end: trigger a real Claude Code session with `npm run build-and-sync`; Agent context in the session + ANSI context in terminal both diff-clean against pre-refactor capture.
- Chroma corpus query test: build a corpus, query it 3× within 5 minutes, assert `cache_read_input_tokens > 0` on SDK response (proves corpus prompt bytes are stable, per 05 section 3.11 cost note).

**(d) Anti-pattern guards**: A — tests enforce the four-strategy ceiling by unioned `name` type. E — the grep audit above is the single-walker check.

---

## Constraints summary

- **Zero behavior change** for LLM (Agent) output bytes and human terminal ANSI bytes. Enforced by Phase 8 golden files.
- **Token-budget logic stays in the orchestrator** (`calculateTokenEconomics` at `TokenCalculator.ts:25`; `getFullObservationIds` at `ObservationCompiler.ts`). Strategies receive computed `RowCtx.isFull`, never re-decide.
- **Mode filtering stays in the orchestrator** (`ModeManager.getActiveMode()` at `ModeManager.ts:15`). Strategies receive filtered `Observation[]`.
- **ANSI color codes preserved**: all `colors.*` literals from `src/services/context/types.js` travel into `HumanContextStrategy` only. The renderer core is ANSI-agnostic.
- **Four strategies, no more**: `AgentContextStrategy`, `HumanContextStrategy`, `SearchResultStrategy`, `CorpusDetailStrategy`. Variants live as strategy config flags.

---

## Phase count

**8 phases.**

- Phase 1: extract renderer.
- Phase 2: `AgentContextStrategy`.
- Phase 3: `HumanContextStrategy` (ANSI).
- Phase 4: `SearchResultStrategy`.
- Phase 5: `CorpusDetailStrategy`.
- Phase 6: wire `ContextBuilder.generateContext` + `/api/session/start`.
- Phase 7: delete old formatters + section renderers.
- Phase 8: byte-identical verification.

---

## Blast radius + estimated LoC

- **Files deleted**: 8 (four formatters + four section renderers).
- **Files created**: ~6 (`renderObservations.ts` + 4 strategy files + shared helpers).
- **Lines deleted**: ~1,250 (AgentFormatter 227 + HumanFormatter 238 + ResultFormatter 301 + CorpusRenderer 133 + HeaderRenderer 61 + TimelineRenderer 183 + SummaryRenderer 65 + FooterRenderer 42).
- **Lines added**: ~320 (renderer + four strategies, per audit estimate at 05 line 543).
- **Net**: **≈ −930 lines**, ~3.3× the audit's row-level estimate of −280, once the forHuman branching in `*Renderer.ts` section files is counted.

Risk: lowest of the cleanup plan (pure reorganization, no behavior change). Snapshot tests are the safety net.
