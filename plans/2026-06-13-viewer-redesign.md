# Plan: Rebuild the claude-mem Viewer on the New Design System

**Date:** 2026-06-13
**Goal:** Replace the current flat-feed viewer UI (`src/ui/viewer`) with the new redesign (warm coral/cream "agent" design system, collapsible Day→Session→Observation timeline, date-rail navigation, scroll-spy context bar, instant search + agent answer drawer + notes) — while preserving the existing real data layer (worker SSE + REST), settings, logs, and the esbuild/TS build pipeline.

**Source of redesign:** `/tmp/cmem-redesign/`
**Target:** `/Users/alexnewman/.superset/worktrees/df8069a7-eb08-4626-9d3d-918d1e12eb9f/synonymous-slipper/src/ui/viewer`

---

## Core Strategy (read first)

The redesign mockups (`CMEM Viewer v4.html` + `cmem-viewer/*.jsx`) are **browser-Babel + `window`-global** prototypes. The production viewer is **TypeScript + React 19 + esbuild IIFE bundle**. The job is to **port** the redesign's components and CSS into the existing TS/esbuild pipeline — NOT to ship Babel, `<script>` tags, or `window.CMEM_DATA`.

**What is reused as-is from the current viewer (do NOT rewrite):**
- The fetch/stream layer: `hooks/useSSE.ts`, `hooks/usePagination.ts`, `hooks/useStats.ts`, `hooks/useSettings.ts`, `hooks/useTheme.ts`, `utils/api.ts`, `constants/api.ts`. They already call `/stream`, `/api/observations|summaries|prompts|settings|stats`.
- The build pipeline: `scripts/build-viewer.js` (entry `src/ui/viewer/index.tsx` → `plugin/ui/viewer-bundle.js`; copies `viewer-template.html` → `plugin/ui/viewer.html`).
- The server route: `src/server/runtime/ServerViewerRoutes.ts` (serves `/` + static assets). No server changes needed.
- Real-feature components, restyled (not dropped): `ContextSettingsModal`, `LogsModal`/`LogsDrawer`, `WelcomeCard`, `ErrorBoundary`.

**What changes:**
- `viewer-template.html` embedded CSS → DS tokens + ported component styles.
- `App.tsx` → new app-v4 shell.
- New components: `Timeline`, `Header` (topbar), `ChipsBar`, `DateRail`, `ContextBar`, `SearchBar`, `AgentToasts`, `AnswerDrawer`, `Icon`, type-meta.
- New data shaping: a normalization adapter (port of `live-data.js` normalize fns) + `buildTimeline`.

**Key compatibility fact:** the redesign's `live-data.js` already fetches the *same endpoints* the current hooks use and normalizes DB rows (`memory_session_id`, snake_case, JSON-string `facts`/`concepts`/`files_*`, ms-or-sec epochs) into the viewer shape (`session_id`, parsed arrays, `at` in seconds). We replicate that normalization in TS and feed it the output of the existing hooks. **Do not re-implement fetching.**

**Decisions already made (do not re-ask):**
1. **Use app-v4** (`/tmp/cmem-redesign/cmem-viewer/app-v4.jsx`) as the shell — it has the date-rail, collapsible drawer, and scroll-spy context bar. Ignore `app.jsx` (v3).
2. **Theme:** the agent DS is light-only. The new default IS the warm light theme. Replace the dark/light toggle with the redesign's **accent + density + roundness** controls (persisted to localStorage). Keep `useTheme.ts` file present but unused by the new shell (or repurpose for accent persistence). Dark mode is explicitly **out of scope** for this rebuild.
3. **Tweaks panel** (`tweaks-panel.jsx`) is a Claude-design-tool editing shell (postMessage `__activate_edit_mode`). **Do NOT ship it.** Instead expose accent/density/roundness as a small in-app settings popover (or fold into the existing settings modal). The accent/density/roundness *state + CSS-variable wiring* IS shipped; the draggable editor shell is not.
4. **Search + agent answer** in the mockup is **simulated** (`synthesizeAnswer` does client-side scoring, no real API). Ship the **client-side instant search** (filtering loaded observations/files/concepts) for real. Wire the "Ask" / agent-answer drawer to the **client-side synthesis for now** (port `synthesizeAnswer`), clearly marked as local — there is no server search endpoint to call. Notes persist to localStorage (real).
5. **`_ds_bundle.js` is NOT shipped.** Only `colors_and_type.css` (tokens) + the ported component CSS.

---

## Phase 0: Documentation Discovery (COMPLETE — reference only)

**Sources consulted:** `src/ui/viewer/**` (App.tsx, types.ts, hooks, components), `scripts/build-viewer.js`, `src/server/runtime/ServerViewerRoutes.ts`, all of `/tmp/cmem-redesign/cmem-viewer/*.jsx`, `/tmp/cmem-redesign/cmem-viewer/{data.js,live-data.js}`, `/tmp/cmem-redesign/CMEM Viewer v4.html`, `/tmp/cmem-redesign/_ds/cmem-agent-design-system-*/colors_and_type.css`.

### Allowed / real APIs (current viewer — verified)
- `useSSE()` → `{ observations, summaries, prompts, projects, isProcessing, queueDepth, isConnected }` (DB-shape rows). Source: `src/ui/viewer/hooks/useSSE.ts`.
- `usePagination(filter)` → `{ observations, summaries, prompts }` each `{ loadMore(), isLoading, hasMore }`. Source: `hooks/usePagination.ts`.
- `useSettings()` → `{ settings, saveSettings, isSaving, saveStatus }`. `useStats()` → `{ refreshStats, ... }`.
- Endpoints (already wired): `GET /stream`, `GET /api/observations|summaries|prompts?offset&limit`, `GET|POST /api/settings`, `GET /api/stats`.
- DB row shapes: `types.ts` `Observation` (snake_case, `facts/concepts/files_*` are JSON **strings or null**, `memory_session_id`, `created_at_epoch`), `Summary`, `UserPrompt`.

### Redesign components (real, to port) — `/tmp/cmem-redesign/cmem-viewer/`
- `app-v4.jsx:1-683` — shell. `ACCENTS` (6-10), `VIEWER_TWEAK_DEFAULTS` (12-16), `buildTimeline` (18-55), scroll-spy (399-430), context header (575-602), tweaks usage (668-674).
- `timeline.jsx:1-215` — `Timeline` (root 187-213), `DayGroup` (153-184), `SessionCard`, `ObservationRow`, `ConceptChip`, `FileChip`, empty state (189-197).
- `search-agent.jsx:1-452` — `SearchBar` (176-288), `AgentToasts` (291-314), `AnswerDrawer` (391-450), `StreamedBlocks` (317-388), `useAgentSessions`, `useNotes` (149-173, localStorage key `cmem-viewer-notes-v1`), `searchMemory`, `synthesizeAnswer` (67-109), `scoreObservation` (21-28).
- `icons.jsx:1-142` — `Icon` (92-104), `ICON_PATHS` (7-90), `TYPE_META` (107-113), `fmtTime/fmtDayKey/fmtDayLabel/baseName/dirName` (116-140).
- `live-data.js:52-148` — `normObservation/normSummary/normPrompt` + `buildData` (PORT these to TS).

### Normalized viewer shape the redesign components expect (from `live-data.js`)
```
Observation: { id, session_id, project, type, title, subtitle, narrative,
               facts: string[], concepts: string[], files_read: string[],
               files_modified: string[], at: number /* epoch SECONDS */ }
Session:     { id, project, started, ended, request, learned, completed, next_steps, hasSummary }
Prompt:      { id, session_id, project, text, n, at }
Data:        { sessions, prompts, observations, seedNotes }
```

### CSS to port
- **Tokens:** `/tmp/cmem-redesign/_ds/cmem-agent-design-system-0d7f196f-9c0c-49f4-a8b3-c4ceda986066/colors_and_type.css` (full file). Includes `--coral-*`, `--cream-*`, `--espresso-900`, `--bg/--surface/--fg/--fg-2/--fg-3/--border/--ring`, `--font-display` (Fredoka), `--font-sans` (Nunito), `--font-mono` (JetBrains Mono), `--r-*`, `--shadow-*`, `--space-*`, motion vars.
- **Component styles:** inline `<style>` block in `CMEM Viewer v4.html` **lines 9–729**. This is the entire component stylesheet (`.app`, `.topbar`, `.chips-bar`, `.date-rail`, `.timeline`, `.day-group`, `.session-card`, `.obs-row`, `.obs-type-bubble`, `.concept-chip`, `.file-chip`, `.drawer`, etc.).

### Fonts
- DS uses Google Fonts (Fredoka / Nunito / JetBrains Mono). The mockup loads them via CDN inside the tokens CSS `@import`. **Decision:** self-host or keep the existing Monaspace? → Port the DS fonts via the `@import` already present in `colors_and_type.css` (network-loaded). Keep existing `assets/fonts/monaspace-*` only if still referenced; otherwise leave untouched (build copies them harmlessly). Confirm the tokens CSS `@import` works offline-degraded (font-display swap). If the DS file `@import`s Google Fonts, that's acceptable for v1.

### Anti-patterns to avoid
- ❌ Do NOT ship `@babel/standalone`, `unpkg` React `<script>` tags, or `_ds_bundle.js`.
- ❌ Do NOT use `window.CMEM_DATA` / `window.CmemLive` / `window.React`. Use ES imports.
- ❌ Do NOT re-implement fetching/SSE — reuse the existing hooks.
- ❌ Do NOT invent server endpoints (no `/api/search`, no `/api/agent`). Search/agent is client-side.
- ❌ Do NOT feed raw DB rows (JSON-string facts, `memory_session_id`) directly into ported components — they expect normalized arrays + `session_id` + `at` seconds. Always go through the normalization adapter.
- ❌ Do NOT drop the settings modal / logs drawer / welcome card — restyle and re-wire them.

---

## Phase 1: Design-system CSS foundation

**What to implement (copy, don't transform):**
1. Create `src/ui/viewer/styles/tokens.css` by **copying** `/tmp/cmem-redesign/_ds/cmem-agent-design-system-0d7f196f-9c0c-49f4-a8b3-c4ceda986066/colors_and_type.css` verbatim.
2. Create `src/ui/viewer/styles/components.css` by **copying** the `<style>` block contents from `CMEM Viewer v4.html` lines **10–728** (inside the `<style>…</style>`).
3. Rewrite `src/ui/viewer-template.html`:
   - `<head>`: keep `<meta>`/title/favicon. Inline BOTH css files into a single `<style>` (so the served HTML stays self-contained like today) OR `<link>` them and have the build copy them to `plugin/ui/`. **Choose inline** to match current single-file model and avoid build changes — concatenate tokens.css + components.css into the `<style>` block at build time, OR (simpler) paste both into the template `<style>` directly.
   - Change mount point from `<div id="root">` — **keep `id="root"`** (current `index.tsx` mounts `#root`; the mockup uses `#cmem-root`, but we adapt the app, not the index). Keep `<script src="viewer-bundle.js">`.
4. Decision for inlining: simplest is to paste both CSS files' contents directly into the template `<style>`. If the DS tokens file uses `@import url(google fonts)`, keep that `@import` at the very top of the `<style>` (must precede rules).

**Doc references:** `colors_and_type.css` (whole file); `CMEM Viewer v4.html:9-729`; current `src/ui/viewer-template.html`; `scripts/build-viewer.js:34-41`.

**Verification checklist:**
- `grep -c "@babel\|unpkg\|_ds_bundle" src/ui/viewer-template.html` → `0`.
- Template still has `<div id="root">` and `<script src="viewer-bundle.js">`.
- `--coral-500`, `--cream-50`, `--espresso-900`, `.obs-type-bubble`, `.session-card`, `.date-rail` all appear in the template `<style>`.

**Anti-pattern guards:** no external `<script>` tags added; no `id` change that breaks `index.tsx`.

---

## Phase 2: Shared primitives (icons, type-meta, formatters, normalization, timeline builder)

**What to implement (port to TS):**
1. `src/ui/viewer/ui/icons.tsx` — port `icons.jsx`: `ICON_PATHS` map, `Icon` component (`{name,size?,strokeWidth?,className?}`), `TYPE_META`. Use React import; export named.
2. `src/ui/viewer/utils/format.ts` — port `fmtTime`, `fmtDayKey`, `fmtDayLabel`, `baseName`, `dirName` from `icons.jsx:116-140`. (Keep existing `utils/formatters.ts` for the legacy components or merge.)
3. `src/ui/viewer/data/normalize.ts` — port `live-data.js:24-148`: `toSec`, `parseList`, `truncate`, `normObservation`, `normSummary`, `normPrompt`, `buildData`. **Input** = raw DB rows from the existing hooks (`types.ts` shapes). **Output** = normalized viewer shape (above). Add TS types: `ViewerObservation`, `ViewerSession`, `ViewerPrompt`, `ViewerData` in `src/ui/viewer/data/viewer-types.ts`.
4. `src/ui/viewer/data/buildTimeline.ts` — port `buildTimeline` from `app-v4.jsx:18-55` (days → sessions → observations, applying filters). Type its `filters` arg (`{project, types:Set, concepts:Set, file}`).

**Doc references:** `icons.jsx:7-140`; `live-data.js:24-148`; `app-v4.jsx:18-55`.

**Verification checklist:**
- `tsc --noEmit` (via `npm run build` typecheck path) passes for these modules.
- Unit sanity: `normObservation` turns a row with `facts: '["a","b"]'` into `facts: ['a','b']`; a row with `created_at_epoch` in ms → `at` in seconds (`< 1e12`).
- `TYPE_META.feature.icon === 'zap'` etc. preserved exactly.

**Anti-pattern guards:** no `window` references; `parseList` must handle `null`, JSON string, and CSV (matches source).

---

## Phase 3: Data hook — normalized viewer data

**What to implement:**
1. `src/ui/viewer/hooks/useViewerData.ts` — compose the EXISTING `useSSE()` + `usePagination()` outputs, merge+dedupe (reuse `utils/data.ts` `mergeAndDeduplicateByProject`), run each row through `normObservation/normSummary/normPrompt`, then `buildData()` → `ViewerData`. Also surface `{ isProcessing, queueDepth, isConnected, projects, loadMore, hasMore, isLoading }`.
   - This replaces the per-type `allObservations/allSummaries/allPrompts` memos in `App.tsx` with a single normalized `data` object the redesign expects.
2. Keep filtering by project at this layer (mirror `App.tsx:30-56`), but the redesign also filters by type/concept/file inside `buildTimeline` — pass those through to the timeline builder, not the fetch layer.

**Doc references:** current `App.tsx:24-99`; `useSSE.ts`; `usePagination.ts`; `use-live-data.jsx:8-106` (for the live/offline status shape — adapt to use `isConnected`).

**Verification checklist:**
- Hook returns `{ data: { sessions, prompts, observations }, projects, isProcessing, queueDepth, isConnected, loadMore, hasMore, isLoading }`.
- Observations in `data` have parsed-array `facts`/`concepts` and numeric `at` (seconds).
- No direct `fetch`/`EventSource` in this hook (delegates to existing hooks).

**Anti-pattern guards:** do not duplicate SSE/pagination logic; do not call endpoints directly.

---

## Phase 4: Timeline components

**What to implement (port `timeline.jsx` → TSX):**
1. `src/ui/viewer/components/Timeline.tsx` — `Timeline`, `DayGroup`, `SessionCard`, `ObservationRow`, `ConceptChip`, `FileChip`, session-summary block, empty state. Props per the inventory (`days, openDays, onToggleDay, openSessions, onToggleSession, openObs, onToggleObs, activeConcepts, onConceptClick, onFileClick, flashId`).
2. Use `Icon` + `TYPE_META` from Phase 2; `fmtTime`/`baseName`/`dirName` for labels.
3. Preserve the `flash` highlight animation hook (used when jumping from search).

**Doc references:** `timeline.jsx:1-215` (root 187-213, day 153-184, empty 189-197); `app-v4.jsx` for open/close state wiring (318-333).

**Verification checklist:**
- Renders Day→Session→Observation hierarchy with independent collapse state.
- Concept chips reflect `activeConcepts` (active styling) and fire `onConceptClick`.
- File chips show read vs modified via `TYPE_META`/icon; `onFileClick` fires.
- Empty state ("Nothing remembered here yet") renders for empty `days`.

**Anti-pattern guards:** click handlers on chips `stopPropagation` (don't toggle the row); keys on mapped lists are stable IDs.

---

## Phase 5: App shell — Header, ChipsBar, DateRail, ContextBar, scroll-spy

**What to implement (port `app-v4.jsx` → `App.tsx`):**
1. Rewrite `src/ui/viewer/App.tsx` to the v4 shell:
   - `Header` (topbar): brand mark/word, side-toggle (`panelLeft`), `SearchBar` slot, project select, live-status dot (from `isConnected`/`isProcessing`/`queueDepth`), and entry points for **Settings** (opens existing `ContextSettingsModal`), **Help** (existing `WelcomeCard`), **Logs** (existing `LogsDrawer`), and the **accent/density/roundness** popover (Phase 7).
   - `ChipsBar`: type filters + active concept filters (toggle `filters.types` / `filters.concepts`).
   - `DateRail` (left): one `rail-day` per day; click scrolls to day; `aria-current` on active day from scroll-spy.
   - `ContextBar`: docked header showing active session request/stats or project stats (scroll-spy `app-v4.jsx:575-602`).
   - Collapsible side drawer behavior (`sideOpen`).
2. Wire state: `filters`, `openDays/openSessions/openObs`, `drawer`, accent/density/roundness tweaks → CSS variables on root (`--accent`, `--accent-deep`, `--accent-soft`, `--accent-tint`, `--rs`, `data-density`). Port `ACCENTS` (`app-v4.jsx:6-10`) and `VIEWER_TWEAK_DEFAULTS` (12-16).
3. Implement scroll-spy (`app-v4.jsx:399-430`) using `IntersectionObserver` to set active day/session.
4. `Feed` is replaced by `Timeline`; remove the old flat-feed wiring but keep `ErrorBoundary` (in `index.tsx`).

**Doc references:** `app-v4.jsx:1-683` (esp. 6-16, 318-333, 399-430, 575-602, 668-674); current `App.tsx:101-157` (for where Settings/Logs/Welcome mount).

**Verification checklist:**
- App renders topbar + chips + date-rail + timeline + context bar.
- Switching accent updates `--accent` live (no reload); density toggles `data-density`.
- Scrolling updates the date-rail active day and context bar.
- Project select filters the timeline; live-status dot reflects `isConnected`.
- Settings/Help/Logs all still open and function.

**Anti-pattern guards:** no `window.CMEM_DATA`; tweaks persisted to localStorage (key e.g. `cmem-viewer-tweaks-v1`), not the design-tool postMessage protocol.

---

## Phase 6: Search, agent answer drawer, notes

**What to implement (port `search-agent.jsx` → TSX):**
1. `src/ui/viewer/components/SearchBar.tsx` — instant search over loaded `data` (observations/files/concepts), "/" hotkey focus, Esc close, Enter → `onAsk`. Real client-side filtering. (`search-agent.jsx:176-288`, scoring 21-28.)
2. `src/ui/viewer/components/AnswerDrawer.tsx` + `StreamedBlocks` — render agent answer / note in right drawer with word-reveal animation; cite chips jump to observations (`onCite`/`onJump` → set `flashId` + scroll). (`391-450`, `317-388`.)
3. `src/ui/viewer/components/AgentToasts.tsx` — floating toasts for background "agent" work (running→done). (`291-314`.)
4. `src/ui/viewer/hooks/useAgentSessions.ts` + `useNotes.ts` — port `useAgentSessions` and `useNotes` (localStorage `cmem-viewer-notes-v1`). Port `synthesizeAnswer`/`searchMemory` into `src/ui/viewer/data/search.ts`. **Clearly comment** that synthesis is local/simulated (no server agent endpoint).

**Doc references:** `search-agent.jsx:21-28, 67-109, 149-173, 176-452`.

**Verification checklist:**
- Typing filters results live; "/" focuses search; Esc closes dropdown.
- Enter on a query opens the answer drawer; cite chips jump+flash the observation.
- "Save as note" persists; reload shows the saved note; delete works.
- Toasts appear for in-flight asks and become clickable when done.

**Anti-pattern guards:** no fetch to a non-existent search/agent endpoint; synthesis reads only from in-memory `data`.

---

## Phase 7: Preserve real features — settings, logs, welcome, tweaks popover

**What to implement:**
1. Restyle `ContextSettingsModal`, `LogsModal`/`LogsDrawer`, `WelcomeCard` to the DS tokens (replace old `--color-*` vars with DS `--surface/--fg/--border/--accent`, DS radii/shadows). Keep their logic and `useSettings`/`useStats` wiring intact.
2. Add the accent/density/roundness controls as a small popover from the header (NOT the design-tool `TweaksPanel`). Reuse `ACCENTS`. Persist to localStorage.
3. Re-point the console toggle button + logs drawer from current `App.tsx:141-155` into the new header.

**Doc references:** current `components/ContextSettingsModal.tsx`, `components/LogsModal.tsx`, `components/WelcomeCard.tsx`; `app-v4.jsx:668-674` for control set.

**Verification checklist:**
- Settings modal opens, loads `/api/settings`, saves via `POST /api/settings`.
- Logs drawer opens and streams console output.
- Welcome card shows on first load, dismiss persists, "Help" re-opens it.
- Accent/density/roundness popover changes apply live and persist across reload.

**Anti-pattern guards:** don't ship `tweaks-panel.jsx`'s postMessage host protocol; don't break existing settings keys (`types.ts:68-94`).

---

## Phase 8: Build, serve, and test verification

**What to implement / run:**
1. `npm run build` (or the viewer build script) — `scripts/build-viewer.js` should need **no changes** (same entry `index.tsx`, same template). If CSS is split into files instead of inlined, update the build to copy/concat them — otherwise leave it.
2. Typecheck: ensure `tsc --noEmit` passes (per `package.json` typecheck script).
3. Run `npm run build-and-sync`, restart worker, load the viewer at the worker URL; confirm live data renders through the new timeline.
4. Tests: `tests/server/server-viewer-routes.test.ts` must still pass (serves `/` 200 when built). Add no-regression assertions if the bundle filename/template changed (it shouldn't).

**Verification checklist:**
- `npm run build` produces `plugin/ui/viewer-bundle.js` + `plugin/ui/viewer.html` with no errors.
- `grep -rn "window.CMEM_DATA\|@babel/standalone\|unpkg.com\|_ds_bundle" plugin/ui/viewer.html` → `0`.
- Worker serves `/`; observations/sessions/prompts render in Day→Session→Observation timeline with live SSE updates (flash animation on new obs).
- Settings/logs/welcome/search/notes all functional.
- `tests/server/server-viewer-routes.test.ts` passes.

**Anti-pattern guards:** no leftover references to deleted `Feed`/`ObservationCard`/`SummaryCard`/`PromptCard` (either delete them or stop importing them — `grep` to confirm no dangling imports).

---

## File-change summary

**New:**
- `src/ui/viewer/styles/tokens.css`, `styles/components.css` (or inlined into template)
- `src/ui/viewer/ui/icons.tsx`
- `src/ui/viewer/utils/format.ts`
- `src/ui/viewer/data/{normalize.ts, viewer-types.ts, buildTimeline.ts, search.ts}`
- `src/ui/viewer/hooks/{useViewerData.ts, useAgentSessions.ts, useNotes.ts}`
- `src/ui/viewer/components/{Timeline.tsx, ChipsBar.tsx, DateRail.tsx, ContextBar.tsx, SearchBar.tsx, AnswerDrawer.tsx, AgentToasts.tsx}` (+ a new `Header.tsx` topbar, replacing the old one)

**Rewritten:**
- `src/ui/viewer/App.tsx` (v4 shell)
- `src/ui/viewer-template.html` (DS CSS)
- `src/ui/viewer/components/Header.tsx`

**Restyled (logic kept):**
- `ContextSettingsModal.tsx`, `LogsModal.tsx`, `WelcomeCard.tsx`

**Reused unchanged:**
- `hooks/{useSSE,usePagination,useStats,useSettings}.ts`, `utils/{api,data}.ts`, `constants/*`, `index.tsx`, `ErrorBoundary.tsx`, `scripts/build-viewer.js`, `ServerViewerRoutes.ts`

**Removed/retired (after de-referencing):**
- `components/{Feed.tsx, ObservationCard.tsx, SummaryCard.tsx, PromptCard.tsx, ScrollToTop.tsx, ThemeToggle.tsx}` (verify no imports remain). `useTheme.ts` may be retired or repurposed for accent persistence.

**Not shipped:** `_ds_bundle.js`, `tweaks-panel.jsx`, Babel/unpkg scripts, `data.js` mock, `window.*` globals.
