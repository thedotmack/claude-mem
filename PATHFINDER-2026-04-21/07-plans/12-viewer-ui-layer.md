# Plan 12 — viewer-ui-layer (LOCKDOWN / REGRESSION-DETECTION)

**Target flowchart:** `PATHFINDER-2026-04-21/05-clean-flowcharts.md` section 3.10 ("viewer-ui-layer (clean)")
**Before-state flowchart:** `PATHFINDER-2026-04-21/01-flowcharts/viewer-ui-layer.md`
**Canonical doctrine from 05 §3.10:** *"Deleted: (Nothing — this subsystem is clean.)"* / *"Kept: Everything. User-facing."*

## Plan Type

**LOCKDOWN / REGRESSION-DETECTION.** This is NOT a refactor plan. Section 3.10 declares the viewer subsystem already aligned with the clean architecture. The deliverable is a protective harness that detects regressions introduced by the **other 11 plans** landing.

No source code in `src/ui/viewer/**` is modified by this plan. The only artifacts produced are regression tests, baselines, and a re-run schedule.

**Expected lines deleted by this plan:** 0
**Expected lines added to `src/`:** 0 (tests live under `tests/viewer-lockdown/`)

## Dependencies

- **Upstream:** none — no other plan produces code this plan consumes.
- **Downstream:** none — no other plan consumes code this plan produces.
- **Cross-reference dependencies (tests-run-after):**
  - Plan 11 (`http-server-routes`, flowchart §3.9) — **CRITICAL.** Phase 14 of `06-implementation-plan.md:600-627` caches `viewer.html` at boot. The lockdown suite MUST run after plan 11 to confirm the cached Buffer serve still produces a byte-identical HTML response and that `express.static(path.join(packageRoot, 'ui'))` (`ViewerRoutes.ts:30`) still serves JS/CSS assets.
  - Plan 09 (`lifecycle-hooks`) — only indirectly relevant; hooks don't talk to the viewer, but SSE broadcast events originate from write paths the hooks trigger. Re-run the `new_observation` live-update test after plan 09 lands.
  - All remaining 9 plans — run the suite as a smoke check.
- **Implementation-plan cross-ref:** no V-finding targets the viewer subsystem directly in `06-implementation-plan.md`. V20 (rate-limiter deletion, Phase 14) and the "cache `viewer.html`" task in Phase 14 tasks 1–2 are the only lines that touch the viewer's serve path. **No V-number in `06-implementation-plan.md` is assigned to viewer-ui behavior. State recorded here for audit completeness.**

## Sources Consulted

- `PATHFINDER-2026-04-21/05-clean-flowcharts.md:422-447` (section 3.10, canonical)
- `PATHFINDER-2026-04-21/05-clean-flowcharts.md:564-587` (Part 5 deletion totals — viewer contributes 0)
- `PATHFINDER-2026-04-21/01-flowcharts/viewer-ui-layer.md:1-95` (before-state, identical to after-state)
- `PATHFINDER-2026-04-21/06-implementation-plan.md:600-627` (Phase 14 — static-file cache task)
- `src/ui/viewer/App.tsx:1-163`
- `src/ui/viewer/index.tsx:1-17`
- `src/ui/viewer/hooks/useSSE.ts:1-148`
- `src/ui/viewer/hooks/usePagination.ts:1-119`
- `src/ui/viewer/hooks/useSettings.ts:1-100`
- `src/ui/viewer/components/Feed.tsx:1-100`
- `src/ui/viewer/constants/api.ts:5-12`
- `src/ui/viewer/constants/timing.ts:7` (`SSE_RECONNECT_DELAY_MS: 3000`)
- `src/services/worker/http/routes/ViewerRoutes.ts:1-116`
- `src/services/worker/http/routes/DataRoutes.ts:38-45` (`/api/observations` endpoints)
- `src/services/worker/http/routes/SettingsRoutes.ts:30-31` (`/api/settings` endpoints)

## Concrete Findings (React Component + Hook Inventory)

### React Components (all in `src/ui/viewer/components/`)
- `ErrorBoundary.tsx` — root wrapper, mounted via `index.tsx:13-15`.
- `Header.tsx` — project/source filters, SSE connection light, theme toggle.
- `Feed.tsx:18` — interleaved card list; IntersectionObserver at `Feed.tsx:33-41` with `threshold: UI.LOAD_MORE_THRESHOLD`.
- `ObservationCard.tsx` / `SummaryCard.tsx` / `PromptCard.tsx` — rendered in `Feed.tsx:69-75`.
- `ContextSettingsModal.tsx` — POST `/api/settings` via `useSettings.saveSettings`.
- `LogsDrawer` (from `LogsModal.tsx`) — console capture drawer.
- `ScrollToTop.tsx` — inside `Feed.tsx:65`.
- `TerminalPreview.tsx`, `ThemeToggle.tsx`, `GitHubStarsButton.tsx` — supplemental.

### Hooks (all in `src/ui/viewer/hooks/`)
- `useSSE.ts:6` — **SSE subscription owner.** Returns `{observations, summaries, prompts, projects, sources, projectsBySource, isProcessing, queueDepth, isConnected}`. EventSource at `useSSE.ts:50`; auto-reconnect at `useSSE.ts:61-71` after `TIMING.SSE_RECONNECT_DELAY_MS`.
- `usePagination.ts:108` — exposes `{observations, summaries, prompts}`, each with `{isLoading, hasMore, loadMore}`. Resets offset on filter change (`usePagination.ts:36-46`).
- `useSettings.ts:8` — GET/POST `/api/settings`.
- `useTheme.ts`, `useStats.ts`, `useContextPreview.ts`, `useGitHubStars.ts`, `useSpinningFavicon.ts` — ancillary.

### SSE Event Types the Viewer Subscribes To
From `useSSE.ts:76-120` switch:
- `initial_load` — catalog payload `{projects, sources, projectsBySource}`.
- `new_observation` — appends to `observations` state (prepend).
- `new_summary` — appends to `summaries` state (prepend).
- `new_prompt` — appends to `prompts` state (prepend).
- `processing_status` — updates `isProcessing` + `queueDepth`.

### The Dedup Invariant (05 §3.10 line 444)
Live SSE data (`useSSE().observations`) and paginated history (`App.paginatedObservations`) are merged with `(project, id)` dedup in `App.tsx:50-66` via `mergeAndDeduplicateByProject`. Section 3.10 line 444 explicitly protects this: *"which is a correct pattern for live + historical merging."* **Anti-pattern guard E:** do NOT collapse the two paginated fetches into one. The duplication is legitimate.

## Phase Contract

Every phase below follows this structure:
- **(a) What to implement** — the regression artifact or action.
- **(b) Docs** — 05 §3.10 + live file:line anchors.
- **(c) Verification** — exact executable checks.
- **(d) Anti-pattern guards** — A (invent new UI behaviors) + E (collapse legitimate dedup).

---

## Phase 1 — Inventory viewer behaviors

**(a) What to implement**
Produce a single source-of-truth inventory document at `tests/viewer-lockdown/INVENTORY.md` enumerating:
1. All 7 component files under `src/ui/viewer/components/` with file:line anchors for their main exports.
2. All 9 hook files under `src/ui/viewer/hooks/` with exported function signatures.
3. Every SSE event type the viewer subscribes to (5 types, from `useSSE.ts:76-120`).
4. Every HTTP endpoint the viewer calls (`/stream`, `/api/observations`, `/api/summaries`, `/api/prompts`, `/api/settings`, `/api/stats`).
5. Timing constants currently in effect: `SSE_RECONNECT_DELAY_MS=3000` (`constants/timing.ts:7`), `UI.PAGINATION_PAGE_SIZE`, `UI.LOAD_MORE_THRESHOLD` (`constants/ui.ts`).

**(b) Docs**
- 05 §3.10 (mermaid diagram at `05-clean-flowcharts.md:424-441`)
- `01-flowcharts/viewer-ui-layer.md:18-27` (component tree) + `:30` (happy path)

**(c) Verification**
- `grep -c "^" tests/viewer-lockdown/INVENTORY.md` ≥ 60 lines.
- Every file:line reference in the inventory resolves under `git ls-files`.
- All 5 SSE event types from `useSSE.ts:76-120` appear verbatim in the inventory.

**(d) Anti-pattern guards**
- **A:** Do not invent behaviors. Inventory strictly what exists in HEAD.
- **E:** List the dedup call site (`App.tsx:50-66`) as a "protected pattern — do not collapse".

---

## Phase 2 — Define invariants (one per behavior from 05 §3.10)

**(a) What to implement**
Write `tests/viewer-lockdown/INVARIANTS.md` with one numbered invariant per flowchart node/edge in 05 §3.10:

- **I1 (serve):** `GET /` returns HTML whose byte-count equals the baseline within 0 bytes OR differs only by bearer-token substitution. Anchor: `ViewerRoutes.ts:54-72`.
- **I2 (mount):** `index.tsx:11-15` mounts `<ErrorBoundary><App/></ErrorBoundary>` into `#root`. No other mount paths.
- **I3 (SSE open):** `useSSE.ts:50` opens `new EventSource(API_ENDPOINTS.STREAM)` where `STREAM === '/stream'` (`constants/api.ts:12`).
- **I4 (initial_load):** On the first `initial_load` event, `catalog.projects`, `catalog.sources`, `catalog.projectsBySource` populate (`useSSE.ts:77-87`).
- **I5 (live appends):** `new_observation` / `new_summary` / `new_prompt` prepend to their arrays (`useSSE.ts:89-111`). Order: newest first.
- **I6 (processing_status):** Updates `isProcessing` + `queueDepth` (`useSSE.ts:113-119`).
- **I7 (pagination):** `Feed.tsx:33-41` IntersectionObserver fires `onLoadMoreRef.current()` → `App.handleLoadMore` (`App.tsx:79-99`) → three parallel `/api/{observations,summaries,prompts}` fetches with `offset` + `limit` query params.
- **I8 (dedup):** `App.tsx:50-66` merges live + paginated with `mergeAndDeduplicateByProject` keyed on `(project, id)`. **Two distinct arrays MUST remain.** (Anti-pattern guard E.)
- **I9 (filter reset):** Changing `currentFilter` or `currentSource` resets `paginatedObservations/Summaries/Prompts` to `[]` and re-fetches page 0 (`App.tsx:102-108`, `usePagination.ts:36-46`).
- **I10 (settings round-trip):** `ContextSettingsModal` save → `useSettings.saveSettings` → `POST /api/settings` → `{success: true}` response path sets `saveStatus='✓ Saved'` (`useSettings.ts:65-96`).
- **I11 (reconnect):** EventSource `onerror` closes and calls `connect()` after `TIMING.SSE_RECONNECT_DELAY_MS` (3000 ms) (`useSSE.ts:61-71`).
- **I12 (static assets):** `express.static(path.join(packageRoot, 'ui'))` (`ViewerRoutes.ts:30`) serves bundled JS/CSS. Must still 200 after plan 11 lands its cache change.

**(b) Docs**
- Each invariant cites file:line as shown above.
- Cross-ref 05 §3.10 mermaid nodes one-to-one: HTTP→I1, HTML→I1/I12, React→I2, SSE→I3, Initial→I4, Feed→I7, Page→I7, Merge→I8, Cards→I5, Settings→I10, Reconnect→I11.

**(c) Verification**
- Every mermaid node in `05-clean-flowcharts.md:426-440` maps to ≥1 invariant in `INVARIANTS.md`.
- Every invariant cites at least one live `file.ts:NN` anchor that resolves at HEAD.

**(d) Anti-pattern guards**
- **A:** Each invariant must be phrased as "X currently happens", not "X should happen". This is a lockdown, not a wish list.
- **E:** I8 is the anti-collapse invariant — explicitly forbid "flattening paginated + live into a single array".

---

## Phase 3 — Write regression tests (one per invariant)

**(a) What to implement**
Create the test harness `tests/viewer-lockdown/` with these files. Prefer Playwright (headless Chromium) since EventSource + IntersectionObserver require a real browser. If Playwright is not already a dev dep, author a **manual checklist** instead — do not introduce a new test framework.

1. `tests/viewer-lockdown/regression.spec.ts` (Playwright) OR `tests/viewer-lockdown/CHECKLIST.md` (manual):
   - **T1 → I1:** `curl -s http://localhost:37777/` returns 200 + `Content-Type: text/html`. Diff against `baseline/viewer.html.sha256`.
   - **T2 → I2:** Page loads, `document.querySelector('#root').children.length > 0` within 2 s.
   - **T3 → I3+I4:** Open `/stream` via EventSource, receive `initial_load` within 2 s; payload has `projects`, `sources`, `projectsBySource`.
   - **T4 → I5:** Insert a synthetic observation via `POST /api/sessions/:id/observations`; assert a card appears in the feed within 2 s without a page refresh.
   - **T5 → I7:** Scroll the feed past the IntersectionObserver sentinel; assert network panel shows `GET /api/observations?offset=20&limit=20` (or matching `UI.PAGINATION_PAGE_SIZE`).
   - **T6 → I8:** Inject a duplicate `(project, id)` pair via SSE and paginated response; assert exactly one card rendered.
   - **T7 → I9:** Change project filter; assert `paginatedObservations` cleared (check via `Feed` DOM length before/after) and a fresh page-0 request fires.
   - **T8 → I10:** Open `ContextSettingsModal`, change `CLAUDE_MEM_CONTEXT_OBSERVATIONS`, click save; assert `POST /api/settings` → 200 → `saveStatus` text contains `✓ Saved`.
   - **T9 → I11:** Kill the worker SSE connection (e.g. `curl -X POST /__test__/drop-sse-clients` if available, else restart worker); assert EventSource reconnects within 4 s (3 s delay + 1 s slack).
   - **T10 → I12:** `curl -sI http://localhost:37777/viewer.js` (or whatever bundled asset name is) returns 200.
   - **T11 → I6:** Trigger worker processing; assert `queueDepth` in DOM increments.

2. `tests/viewer-lockdown/run.sh` — wrapper that spins up the worker on a test port, seeds fixtures, runs the spec, and tears down.

**(b) Docs**
- Each T-number maps to an I-number in a table at the top of `regression.spec.ts` / `CHECKLIST.md`.

**(c) Verification**
- Running the suite against a clean HEAD worker (before any of plans 1–11 land) produces 11/11 PASS. This is the baseline.
- Every test has a deterministic pass/fail criterion. No "looks right" assertions.

**(d) Anti-pattern guards**
- **A:** Do not add tests for behaviors not listed in 05 §3.10 mermaid (e.g. do not test Header theme-toggle colors — out of scope).
- **E:** T6 is the explicit anti-collapse test.

---

## Phase 4 — Baseline current outputs

**(a) What to implement**
Capture pre-refactor baselines under `tests/viewer-lockdown/baseline/`:

1. `baseline/viewer.html.sha256` — SHA-256 of `GET /` response body with bearer token stripped (token is injected per-boot per `Apr 19 2026 observation 71147`).
2. `baseline/initial_load.json` — full `initial_load` SSE event payload captured against a seeded DB.
3. `baseline/api-observations-page0.json` — response of `GET /api/observations?offset=0&limit=20` on the same seeded DB.
4. `baseline/api-settings.json` — response of `GET /api/settings`.
5. `baseline/screenshots/` — 3 Playwright screenshots: initial feed render, modal open, filter applied. These are visual-regression anchors only; do NOT gate CI on pixel diffs.

**(b) Docs**
- `baseline/README.md` records git SHA, worker version, node version, OS at capture time.

**(c) Verification**
- Running the suite twice against HEAD produces identical SHA-256s and identical JSON payloads (modulo timestamps stripped).

**(d) Anti-pattern guards**
- **A:** Baselines represent observed HEAD behavior, not design wishes.
- **E:** n/a.

---

## Phase 5 — Post-landing re-run schedule

**(a) What to implement**
A schedule table in `tests/viewer-lockdown/SCHEDULE.md` mandating suite re-run after each of the **other 11 plans** lands. Critical re-run points:

| Upstream plan | Trigger | Critical tests |
|---|---|---|
| Plan 01 (privacy-tag-filtering) | new tag stripping at ingest | T4 (observation renders with stripped tags visible in card) |
| Plan 02 (sqlite-persistence) | schema migration | T3 (`initial_load` catalog non-empty after migration) |
| Plan 03 (response-parsing-storage) | ResponseProcessor changes | T4, T11 |
| Plan 04 (vector-search-sync) | `chroma_synced` column added | T5 (pagination response shape unchanged) |
| Plan 05 (context-injection-engine) | — | smoke only |
| Plan 06 (hybrid-search-orchestration) | — | smoke only |
| Plan 07 (session-lifecycle-management) | reaper consolidation | T3, T11 |
| Plan 08 (knowledge-corpus-builder) | — | smoke only |
| Plan 09 (lifecycle-hooks) | hook cache / `ensureWorkerRunning` changes | T4 (hook-triggered observation still broadcasts via SSE) |
| **Plan 11 (http-server-routes)** | **Phase 14 static-file cache + rate-limiter delete** (`06-implementation-plan.md:600-627`) | **ALL 11 tests** — critical. |
| Plan 12 (transcript-watcher-integration) | watcher rewires to direct-call | T4 (Cursor-sourced observation still appears via SSE) |

**(b) Docs**
- Schedule references 05 §3.10 as the unchanging contract.
- Mention CI hook location: if a CI workflow runs the test suite, gate merges of plans 1–11 on the lockdown suite passing green.

**(c) Verification**
- Schedule covers every plan in `06-implementation-plan.md` Phases 1–14 that is not this one.
- Plan 11 row explicitly lists all 11 tests (T1–T11) as critical.

**(d) Anti-pattern guards**
- **A:** Do not skip the re-run for "unrelated" plans; smoke-run is still mandatory.
- **E:** n/a.

---

## Phase 6 — Escalation path

**(a) What to implement**
Write `tests/viewer-lockdown/ESCALATION.md` documenting:

1. **If the lockdown suite goes red after plan N lands:** open a new plan `07-plans/13-viewer-regression-{short-name}.md` describing:
   - Which test failed (T-number).
   - Which invariant was violated (I-number).
   - Which upstream plan's change triggered the regression.
   - A fix proposal.
2. **Do NOT** fix regressions inline inside plan N's branch. Regressions get their own branch, their own PR, and their own review. This preserves audit traceability.
3. **Special case — Plan 11 static-file cache:** if T1 SHA-256 mismatches after plan 11 lands, the likely cause is that `ViewerRoutes.handleViewerUI` (`ViewerRoutes.ts:54-72`) now serves a cached Buffer with a different bearer-token-injection strategy. Document whether (a) the baseline should be regenerated (bearer-token format changed) or (b) the cache implementation needs to match the pre-cache injection point. This is the single highest-risk interaction in the entire refactor.

**(b) Docs**
- Reference `06-implementation-plan.md:600-627` Phase 14 task 2.
- Reference `01-flowcharts/viewer-ui-layer.md:80` (reconnect timing constant) for I11 reconnect regressions.

**(c) Verification**
- Escalation doc exists.
- Template for `13-viewer-regression-*.md` is included.

**(d) Anti-pattern guards**
- **A:** Escalation doc does not prescribe fixes — only detection + routing.
- **E:** n/a.

---

## Copy-ready snippet locations

**None.** This is a lockdown plan; no code snippets are authored.

Regression-test files to be created (all under `tests/viewer-lockdown/`):
- `INVENTORY.md`
- `INVARIANTS.md`
- `regression.spec.ts` (or `CHECKLIST.md` if Playwright is unavailable)
- `run.sh`
- `baseline/viewer.html.sha256`
- `baseline/initial_load.json`
- `baseline/api-observations-page0.json`
- `baseline/api-settings.json`
- `baseline/screenshots/` (3 PNGs)
- `baseline/README.md`
- `SCHEDULE.md`
- `ESCALATION.md`

## Confidence + Gaps

**High confidence:**
- React component tree (confirmed in `App.tsx:1-163`).
- SSE event type list (confirmed in `useSSE.ts:76-120`).
- Hook inventory (confirmed via `src/ui/viewer/hooks/*` glob).
- Dedup pattern anchor (`App.tsx:50-66`, `utils/data.ts` → `mergeAndDeduplicateByProject`).
- Flowchart-to-live-code mapping for I1–I12.

**Medium / gaps:**
1. **Gap — Plan 11 cache + bearer-token interaction.** Phase 14 task 2 in `06-implementation-plan.md:613` says "Cache `viewer.html` … in memory at boot; serve from `Buffer` instead of `fs.readFile`." But observation 71147 (Apr 19 2026) says the bearer token is injected into the viewer HTML as a per-boot window global. If the cache is a static immutable Buffer captured at worker-start, the bearer token will be baked in once per worker boot — fine. If plan 11 changes that to share a Buffer across worker restarts (e.g. via a persistent cache file), the token would desync. **T1 SHA-256 baseline must be regenerated after every worker restart** — document this in `baseline/README.md`. Confirm with plan 11 author whether caching happens at process-boot or at module-import (which could be once per container lifetime).

2. **Gap — Playwright availability.** If `package.json` does not already list Playwright as a dev dependency, adding it to satisfy this lockdown plan would violate the "no code changes" constraint. Fallback: author a manual `CHECKLIST.md` instead of the spec file. Decision deferred to execution time. Check: `grep -q playwright package.json` before choosing automation-vs-manual path.

3. **Low-priority gap — catalog update strategy.** `01-flowcharts/viewer-ui-layer.md:93` lists this as Medium confidence ("additive only"). If a plan introduces project deletion, `updateCatalogForItem` (`useSSE.ts:21-42`) is additive-only and will show stale entries. Not in scope for this lockdown but worth adding I13 if any upstream plan touches catalog eviction.

## Summary

- **Phase count:** 6
- **Expected lines deleted:** 0
- **Expected lines added to `src/`:** 0 (tests go under `tests/viewer-lockdown/`, outside the protected subsystem)
- **Top gaps:**
  1. Plan 11's static-file cache change may reshape how bearer tokens are injected into `viewer.html` — T1 SHA-256 baseline needs re-capture after worker boots, and the cache lifecycle (per-boot vs. persistent) must be confirmed with plan 11 before T1 is considered reliable.
  2. Playwright may not be a project dev dependency; fall back to a manual `CHECKLIST.md` if adding it is out-of-scope for a lockdown plan (which it is).
