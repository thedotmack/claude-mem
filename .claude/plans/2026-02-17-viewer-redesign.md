# Implementation Plan: Viewer UI Redesign

## Overview

Comprehensive redesign of the magic-claude-mem viewer from a flat chronological feed to a session-centric two-panel layout with a proper CSS design token system, simplified header, command-palette filter system, keyboard navigation, and virtual scrolling. The work is divided into 6 sequential phases, each independently verifiable via Playwright CLI tests.

## Requirements

- Replace 3,515-line monolithic CSS with design token system (spacing, typography, radius, shadow)
- Eliminate 4x theme variable duplication (`:root`, `[data-theme="light"]`, `@media prefers-color-scheme: light`, `@media prefers-color-scheme: dark`) to single `:root` + `[data-theme="dark"]` pair
- Session-centric two-panel layout: left session list (~260px), right session detail
- Redesigned cards: always-visible concepts/files, left-border type accents, in-place expand
- Simplified header: 4 elements (logo, search, project selector, settings) instead of 8
- Command-palette filter overlay replacing expand/collapse filter bar
- Full keyboard navigation (j/k, Enter, /, Esc, f, ?)
- Virtual scrolling via `@tanstack/react-virtual` for 50+ observation sessions
- Playwright CLI testing at each phase boundary
- Maintain warm earthy color palette and Monaspace Radon font
- Maintain light/dark theme support and responsive behavior

## Delivery Strategy

**Feature branch + local merge**: Create `feature/viewer-redesign`, implement all phases, merge back to main when done.

## Current Architecture

### Source Files
- **Template**: `src/ui/viewer-template.html` (3,523 lines, ~3,515 lines of CSS in `<style>` tag)
- **Components** (18 files): `src/ui/viewer/components/`
  - `ActivityBar.tsx` (6.6K), `ContextSettingsModal.tsx` (22K), `ErrorBoundary.tsx` (1.8K)
  - `Feed.tsx` (3.5K), `FilterBar.tsx` (3.7K), `FilterChip.tsx` (380B)
  - `GitHubStarsButton.tsx` (3.1K), `Header.tsx` (5.9K), `LogsModal.tsx` (16K)
  - `ObservationCard.tsx` (6K), `PromptCard.tsx` (771B), `ScrollToTop.tsx` (1.3K)
  - `SearchBar.tsx` (2.5K), `SearchResultsBadge.tsx` (765B), `SummaryCard.tsx` (2.3K)
  - `TerminalPreview.tsx` (4.3K), `ThemeToggle.tsx` (2.9K)
- **Hooks** (11 files): `src/ui/viewer/hooks/`
  - `useActivityDensity.ts`, `useContextPreview.ts`, `useFilters.ts`, `useGitHubStars.ts`
  - `usePagination.ts`, `useSSE.ts`, `useSearch.ts`, `useSettings.ts`
  - `useSpinningFavicon.ts`, `useStats.ts`, `useTheme.ts`
- **Types**: `src/ui/viewer/types.ts`
- **Constants**: `src/ui/viewer/constants/` (api.ts, filters.ts, settings.ts, timing.ts, ui.ts)
- **Utils**: `src/ui/viewer/utils/` (data.ts, formatNumber.ts, formatters.ts)
- **App**: `src/ui/viewer/App.tsx`
- **Build**: `scripts/build-viewer.js` (esbuild IIFE → `plugin/ui/viewer-bundle.js`)

### Key API Endpoints (already exist, no changes needed)
- `GET /api/observations?offset=N&limit=N&project=P` — Paginated observations
- `GET /api/summaries?offset=N&limit=N&project=P` — Paginated session summaries
- `GET /api/session/:id` — Single session detail
- `GET /api/search?q=...&types=...&concepts=...` — Unified search
- `GET /stream` — SSE for real-time updates
- `GET /api/stats` — Worker + database stats

### Known CSS Issues
- Theme variables defined 4 times: `:root` (L19), `[data-theme="dark"]` (L105), `@media prefers-color-scheme: light` (L190), `@media prefers-color-scheme: dark` (L273)
- Duplicate `.chip` class: L2525-2561 and L2962-2995
- Empty media query: `@media (max-width: 600px) {}` at L1563
- 43 inline `style={}` across 10 components
- No spacing/typography/radius/shadow token system
- `font-family` hardcoded in multiple selectors instead of using a variable
- `feed-content` max-width locked at 650px

---

## Phase A: CSS Foundation (Tokens, Dedup, Cleanup)

**Goal**: Establish the design token system and clean up the CSS without changing any visual output. This phase is purely additive/refactoring -- the viewer should look identical before and after.

### A.1 — Install Playwright and create baseline screenshots
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `package.json`, `tests/ui/viewer.spec.ts` (new), `playwright.config.ts` (new)
- **Action**:
  1. Install `@playwright/test` as dev dependency
  2. Create `playwright.config.ts` with baseURL `http://localhost:37777`
  3. Create `tests/ui/viewer.spec.ts` with baseline screenshot tests:
     - Full page light theme screenshot
     - Full page dark theme screenshot
     - Header region screenshot
     - Feed with cards screenshot
     - Filter bar expanded screenshot
  4. Run tests to generate baseline `.png` files in `tests/ui/__screenshots__/`
- **Acceptance**: Playwright tests pass, baseline screenshots saved
- **Risk**: Low
- **Dependencies**: Worker must be running on port 37777 with data

### A.2 — Create design token CSS variables
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer-template.html` (CSS section)
- **Action**:
  1. Add spacing tokens to `:root`:
     ```css
     --space-1: 4px;  --space-2: 8px;  --space-3: 12px;  --space-4: 16px;
     --space-5: 20px; --space-6: 24px; --space-7: 32px;  --space-8: 48px;
     ```
  2. Add typography tokens:
     ```css
     --text-xs: 11px; --text-sm: 12px; --text-base: 14px;
     --text-lg: 16px; --text-xl: 20px; --text-2xl: 24px;
     --line-tight: 1.3; --line-normal: 1.5; --line-relaxed: 1.7;
     ```
  3. Add radius tokens:
     ```css
     --radius-sm: 3px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 12px;
     ```
  4. Add shadow tokens:
     ```css
     --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
     --shadow-md: 0 2px 4px rgba(0,0,0,0.1);
     --shadow-lg: 0 4px 12px rgba(0,0,0,0.15);
     ```
  5. Add font tokens:
     ```css
     --font-mono: 'Monaco', 'Menlo', 'Consolas', 'Courier New', monospace;
     --font-brand: 'Monaspace Radon', var(--font-mono);
     --font-system: system-ui, -apple-system, 'Segoe UI', sans-serif;
     ```
  6. Duplicate these tokens into `[data-theme="dark"]` where values differ (shadows darker on dark theme)
- **Acceptance**: Tokens defined, no visual change, build succeeds
- **Risk**: Low
- **Dependencies**: None

### A.3 — Eliminate 4x theme variable duplication
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer-template.html` (CSS section)
- **Action**:
  1. Keep only `:root` (light defaults) and `[data-theme="dark"]` blocks
  2. Remove the `@media (prefers-color-scheme: light) { :root:not([data-theme]) { ... } }` block (~L190-272)
  3. Remove the `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { ... } }` block (~L273-356)
  4. Ensure `useTheme.ts` already sets `data-theme` attribute on `<html>` on load (it does -- confirmed at L42)
  5. The `:root` block already defines light defaults and `[data-theme="dark"]` overrides them -- this is sufficient
- **Acceptance**: Only 2 theme blocks remain, visual appearance identical in both themes
- **Risk**: Medium -- must verify system-preference detection still works via `useTheme.ts`
- **Dependencies**: A.2

### A.4 — Replace hardcoded values with tokens
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer-template.html` (CSS section)
- **Action**:
  1. Replace `border-radius: 8px` → `border-radius: var(--radius-lg)` (cards)
  2. Replace `border-radius: 3px` → `border-radius: var(--radius-sm)` (badges, chips)
  3. Replace `font-size: 12px` → `font-size: var(--text-sm)` (meta, labels)
  4. Replace `font-size: 14px` → `font-size: var(--text-base)` (body text)
  5. Replace `font-family: 'Monaco', ...` → `font-family: var(--font-mono)` throughout
  6. Replace `padding: 24px` → `padding: var(--space-6)` (cards)
  7. Replace `margin-bottom: 24px` → `margin-bottom: var(--space-6)` (cards)
  8. Replace `gap: 10px` → `gap: var(--space-2)` or `var(--space-3)` as appropriate
  9. Replace `line-height: 1.7` → `line-height: var(--line-relaxed)` (cards)
- **Acceptance**: All uses of hardcoded spacing/typography/radius use tokens, visual identical
- **Risk**: Low
- **Dependencies**: A.2

### A.5 — Remove dead/duplicate CSS and inline styles
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer-template.html`, all components with `style={}`
- **Action**:
  1. Remove duplicate `.chip` definition at L2962-2995 (keep L2525-2561)
  2. Remove empty `@media (max-width: 600px) {}` at L1563
  3. Remove commented-out CSS blocks
  4. Convert 43 inline `style={}` in components to CSS classes:
     - `Feed.tsx`: 5 inline styles → `.feed-empty`, `.feed-loading`, `.feed-sentinel`, `.feed-end`
     - `ObservationCard.tsx`: 2 inline styles → `.concept-chip`, `.meta-row`
     - `ActivityBar.tsx`: 7 inline styles → CSS classes for bar segments
     - `ErrorBoundary.tsx`: 6 inline styles → `.error-boundary`, `.error-title`, etc.
     - `TerminalPreview.tsx`: 9 inline styles → CSS classes
     - `LogsModal.tsx`: 7 inline styles → CSS classes
     - `ContextSettingsModal.tsx`: 3 inline styles → CSS classes
     - `SummaryCard.tsx`: 1 inline style → CSS class
     - `Header.tsx`: 1 inline style → `.logo-container`
     - `GitHubStarsButton.tsx`: 2 inline styles → CSS classes
- **Acceptance**: Zero inline `style={}` in components, no duplicate CSS selectors, build succeeds
- **Risk**: Medium -- some inline styles may be dynamic; those need `style` attribute with CSS variables
- **Dependencies**: A.4

### A.6 — Phase A verification
- **Agent**: `magic-claude:ts-tdd-guide`
- **Action**:
  1. `npm run build-and-sync` — verify clean build
  2. Run Playwright screenshot comparison tests against A.1 baselines
  3. Verify light theme, dark theme, and system-preference detection
  4. Check no visual regressions
- **Acceptance**: All Playwright tests pass with <1% pixel diff from baseline
- **Risk**: Low
- **Dependencies**: A.1-A.5

### A.7 — Phase A code review
- **Agent**: `magic-claude:code-reviewer`
- **Action**: Review all CSS changes, token consistency, removed duplication
- **Acceptance**: No CRITICAL or HIGH issues
- **Dependencies**: A.6

### A.8 — Phase A simplification pass
- **Agent**: `magic-claude:ts-refactor-cleaner`
- **Action**: Dead code sweep on CSS -- find any classes no longer referenced by components
- **Acceptance**: No unused CSS classes remain
- **Dependencies**: A.7

---

## Phase B: Layout Architecture (Two-Panel, Session List)

**Goal**: Transform the single-column feed into a session-centric two-panel layout with a left session list and right detail view.

### B.1 — Add new API hook: `useSessionList`
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/hooks/useSessionList.ts` (new), `src/ui/viewer/types.ts`
- **Action**:
  1. Create `SessionListItem` type:
     ```typescript
     interface SessionListItem {
       id: number;
       session_id: string;
       project: string;
       request?: string;
       observationCount: number;
       created_at_epoch: number;
       status: 'completed' | 'active';
     }
     ```
  2. Create `useSessionList` hook that:
     - Fetches from `GET /api/summaries?offset=0&limit=50&project=P`
     - Groups sessions by day (using `created_at_epoch`)
     - Returns `{ sessions, isLoading, loadMore, hasMore, selectedId, selectSession }`
     - Listens to SSE `new_summary` events for real-time updates
  3. Write unit tests with mocked fetch
- **Acceptance**: Hook returns grouped session list, tests pass
- **Risk**: Low -- uses existing `/api/summaries` endpoint
- **Dependencies**: None (can start parallel with A)

### B.2 — Add API hook: `useSessionDetail`
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/hooks/useSessionDetail.ts` (new), `src/ui/viewer/types.ts`
- **Action**:
  1. Create hook that fetches a session's detail data:
     - Summary from `GET /api/session/:id`
     - Observations filtered by `memory_session_id` from `GET /api/observations?project=P&offset=0&limit=100`
     - Prompts filtered by `content_session_id` from `GET /api/prompts?project=P`
  2. Returns `{ summary, observations, prompts, isLoading }`
  3. Caches last N session details to avoid re-fetching
  4. Write unit tests
- **Acceptance**: Hook fetches and caches session details, tests pass
- **Risk**: Medium -- may need client-side filtering by `memory_session_id` if API doesn't support it; if so, fetch all and filter
- **Dependencies**: None

### B.3 — Create `SessionList` component (left panel)
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/components/SessionList.tsx` (new), CSS in `viewer-template.html`
- **Action**:
  1. Create component showing sessions grouped by day:
     ```
     Today
       Session #142 • 14:30 • 8 obs
       Session #141 • 10:15 • 12 obs
     Yesterday
       Session #140 • 16:45 • 3 obs
     ```
  2. Each session row shows: truncated request text, time, observation count, active indicator
  3. Selected session has highlighted background
  4. Infinite scroll for loading more sessions
  5. CSS: `~260px` width, sticky day headers, scroll overflow
  6. Add `data-testid` attributes for Playwright selectors
- **Acceptance**: Component renders grouped sessions, selection works, scroll loads more
- **Risk**: Low
- **Dependencies**: B.1

### B.4 — Create `SessionDetail` component (right panel)
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/components/SessionDetail.tsx` (new), CSS in `viewer-template.html`
- **Action**:
  1. Create component showing the selected session's content in structured sections:
     - Session summary (SummaryCard) at top
     - Observation list (ObservationCard[]) in chronological order
     - Prompt list (PromptCard[]) interleaved by timestamp
  2. Empty state when no session selected: "Select a session to view details"
  3. Loading state with skeleton placeholders
  4. CSS: flex-grow to fill remaining width, max-content-width ~800px, scroll overflow
  5. Add `data-testid` attributes for Playwright selectors
- **Acceptance**: Component renders session content in structured sections
- **Risk**: Low
- **Dependencies**: B.2

### B.5 — Create `TwoPanel` layout component and wire into App
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/components/TwoPanel.tsx` (new), `src/ui/viewer/App.tsx`, CSS
- **Action**:
  1. Create `TwoPanel` layout component:
     ```tsx
     <div className="two-panel">
       <aside className="panel-left">
         <SessionList ... />
       </aside>
       <main className="panel-right">
         <SessionDetail ... />
       </main>
     </div>
     ```
  2. CSS: `display: flex`, left panel `flex: 0 0 260px`, right panel `flex: 1`
  3. Responsive: below 768px, hide left panel and show mobile session selector
  4. Refactor `App.tsx`:
     - Replace `<Feed>` with `<TwoPanel>`
     - Move session-level state management (selected session, detail loading) to App
     - Keep SSE, filters, search, settings hooks as-is
  5. When no session selected, default to most recent session
  6. When in search/filter mode, right panel shows search results in feed mode (existing Feed component)
- **Acceptance**: Two-panel layout renders, session selection drives right panel content
- **Risk**: High -- largest structural change, must not break search/filter mode
- **Dependencies**: B.3, B.4

### B.6 — Move ActivityBar to bottom of left panel
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/components/SessionList.tsx`, `src/ui/viewer/components/ActivityBar.tsx`
- **Action**:
  1. Move `<ActivityBar>` from `FilterBar` to bottom of `SessionList`
  2. Make it horizontally oriented, fitting the 260px panel width
  3. Activity bar still filters date range on click
- **Acceptance**: Activity bar visible at bottom of session list, click-to-filter works
- **Risk**: Low
- **Dependencies**: B.5

### B.7 — Phase B Playwright tests
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `tests/ui/viewer-layout.spec.ts` (new)
- **Action**:
  1. Test two-panel layout renders with correct widths
  2. Test session list shows sessions grouped by day
  3. Test clicking a session shows its detail in right panel
  4. Test most recent session selected by default
  5. Test responsive collapse below 768px
  6. Test search mode shows results in feed format
  7. Update baseline screenshots
- **Acceptance**: All layout tests pass
- **Risk**: Low
- **Dependencies**: B.5

### B.8 — Phase B code review
- **Agent**: `magic-claude:code-reviewer`
- **Action**: Review layout architecture, hook design, component composition
- **Acceptance**: No CRITICAL or HIGH issues
- **Dependencies**: B.7

### B.9 — Phase B simplification pass
- **Agent**: `magic-claude:ts-refactor-cleaner`
- **Action**: Check for dead props in old Feed component, unused imports, over-fetching
- **Acceptance**: Clean component boundaries, no dead code
- **Dependencies**: B.8

---

## Phase C: Component Redesign (Cards, Header)

**Goal**: Redesign the ObservationCard, SummaryCard, and Header to match the new design direction.

### C.1 — Redesign ObservationCard
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/components/ObservationCard.tsx`, CSS
- **Action**:
  1. Replace inline type badge with left-border color accent:
     ```css
     .card[data-obs-type="architecture"] { border-left: 3px solid var(--color-accent-observation); }
     .card[data-obs-type="error_resolution"] { border-left: 3px solid var(--color-accent-error); }
     ```
  2. Make concepts always visible (not hidden behind facts toggle):
     - Concept chips shown below title, always visible
     - Files (read/modified) shown below concepts, always visible
  3. Facts/narrative expand in-place on card click (not toggle buttons):
     - Click card body → expand facts section
     - Click again → collapse
     - No separate facts/narrative toggle buttons
  4. Remove subtitle as separate field (merge into title or narrative)
  5. Tighter `line-height: var(--line-normal)` (1.5 instead of 1.7)
  6. Denser padding: `var(--space-4)` (16px instead of 24px)
- **Acceptance**: Cards show concepts/files always, expand in-place, denser layout
- **Risk**: Medium -- changing card interaction model
- **Dependencies**: A complete

### C.2 — Redesign SummaryCard
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/components/SummaryCard.tsx`, CSS
- **Action**:
  1. Make each section independently collapsible (click section header to toggle):
     - Default expanded: Completed, Next Steps
     - Default collapsed: Investigated, Learned
  2. Add smooth height animation for expand/collapse
  3. Tighter padding and line-height matching ObservationCard
  4. Keep session request as card title
- **Acceptance**: Sections independently collapse, default states correct
- **Risk**: Low
- **Dependencies**: A complete

### C.3 — Simplify Header
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/components/Header.tsx`, CSS
- **Action**:
  1. Remove from header:
     - Docs link (`<a href="https://docs.magic-claude-mem.ai">`)
     - `<GitHubStarsButton>` component
     - `<ThemeToggle>` component (will move to settings modal)
  2. Keep in header (4 elements):
     - Logo + processing indicator (existing)
     - Search bar (make it wider/more prominent)
     - Project selector dropdown (existing)
     - Settings button (existing, now also contains theme toggle)
     - Filter button (existing)
  3. Update `HeaderProps` to remove unused props
  4. Move theme toggle into `ContextSettingsModal` as a new section
  5. Delete `GitHubStarsButton.tsx` and `useGitHubStars.ts` (or keep but not in header)
  6. CSS: header becomes more compact, search bar takes prominent center position
- **Acceptance**: Header shows 4-5 elements, theme toggle in settings, no visual clutter
- **Risk**: Medium -- must update App.tsx prop passing
- **Dependencies**: A complete

### C.4 — Redesign PromptCard
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/components/PromptCard.tsx`, CSS
- **Action**:
  1. Match density of new ObservationCard
  2. Left-border accent color for prompts (purple)
  3. Truncate long prompts with "show more" expand
  4. Show prompt number badge
- **Acceptance**: Consistent look with other cards
- **Risk**: Low
- **Dependencies**: A complete

### C.5 — Phase C Playwright tests
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `tests/ui/viewer-cards.spec.ts` (new)
- **Action**:
  1. Test ObservationCard concepts always visible
  2. Test ObservationCard click-to-expand facts
  3. Test ObservationCard left-border color by type
  4. Test SummaryCard independent section collapse
  5. Test SummaryCard default expand/collapse states
  6. Test Header has exactly 4-5 elements
  7. Test theme toggle accessible in settings modal
  8. Update baseline screenshots
- **Acceptance**: All card and header tests pass
- **Risk**: Low
- **Dependencies**: C.1-C.4

### C.6 — Phase C code review
- **Agent**: `magic-claude:code-reviewer`
- **Action**: Review card interaction patterns, header simplification, removed components
- **Acceptance**: No CRITICAL or HIGH issues
- **Dependencies**: C.5

### C.7 — Phase C simplification pass
- **Agent**: `magic-claude:ts-refactor-cleaner`
- **Action**: Remove dead CSS for old card styles, check for unused exports
- **Acceptance**: No dead code from old card designs
- **Dependencies**: C.6

---

## Phase D: Interaction Layer (Filters, Keyboard Navigation)

**Goal**: Replace the filter bar with a command-palette overlay and add full keyboard navigation.

### D.1 — Create CommandPalette component
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/components/CommandPalette.tsx` (new), CSS
- **Action**:
  1. Create overlay component (~500px wide, centered, max-height 60vh):
     - Search input at top (auto-focused)
     - Filter sections below (Type, Concept, Show, Date range)
     - Current active filters shown as removable chips
     - "Clear All" button when filters active
  2. Triggered by:
     - Filter button in header
     - `f` keyboard shortcut
  3. Closes on:
     - `Esc` key
     - Click outside
     - Filter button toggle
  4. Backdrop overlay dims content behind
  5. Move `ActivityBar` into command palette (date range section)
  6. Content underneath stays stable (no layout shift)
  7. Combine search + filters: typing in the palette updates both query and filter state
- **Acceptance**: Palette opens/closes smoothly, filters apply in real-time, no layout shift
- **Risk**: Medium -- must coordinate with existing filter/search state
- **Dependencies**: B complete (layout in place)

### D.2 — Replace FilterBar with CommandPalette
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/App.tsx`, `src/ui/viewer/components/Header.tsx`
- **Action**:
  1. Remove `<FilterBar>` from Header
  2. Add `<CommandPalette>` to App, controlled by `filterPaletteOpen` state
  3. Wire filter button in header to toggle palette
  4. Pass all filter callbacks through to palette
  5. Remove `filterBarOpen` state from Header (no longer needed)
  6. Delete `FilterBar.tsx` component (or keep as internal to CommandPalette if useful)
- **Acceptance**: Filter bar gone, command palette replaces all filter functionality
- **Risk**: Medium
- **Dependencies**: D.1

### D.3 — Create `useKeyboardNavigation` hook
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/hooks/useKeyboardNavigation.ts` (new)
- **Action**:
  1. Create hook that listens for global keyboard events:
     - `j` / `k` → navigate sessions (next/prev) in session list
     - `Enter` → select/expand focused session
     - `/` → focus search input (in header or palette)
     - `Esc` → clear search, close palette, deselect
     - `f` → toggle filter palette
     - `?` → show keyboard shortcut help overlay
  2. Respect focus context: don't fire when user is typing in an input
  3. Returns `{ showHelp, setShowHelp }` for the help overlay
  4. Write unit tests for each shortcut
- **Acceptance**: All shortcuts work, don't interfere with input fields
- **Risk**: Medium -- focus management complexity
- **Dependencies**: B.5 (needs session list for j/k)

### D.4 — Create KeyboardShortcutHelp component
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/components/KeyboardShortcutHelp.tsx` (new), CSS
- **Action**:
  1. Small overlay showing shortcut list:
     ```
     j/k    Navigate sessions
     Enter  Select session
     /      Focus search
     f      Filter palette
     Esc    Clear/close
     ?      This help
     ```
  2. Opens on `?`, closes on `Esc` or any other key
  3. Positioned bottom-right, non-modal
- **Acceptance**: Help overlay shows and dismisses correctly
- **Risk**: Low
- **Dependencies**: D.3

### D.5 — Wire keyboard navigation into App
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/App.tsx`
- **Action**:
  1. Add `useKeyboardNavigation` hook to App
  2. Connect `j`/`k` to session list navigation
  3. Connect `Enter` to session selection
  4. Connect `/` to search bar focus
  5. Connect `f` to command palette toggle
  6. Connect `Esc` chain: palette → search → selection
  7. Add `<KeyboardShortcutHelp>` component
- **Acceptance**: Full keyboard navigation works end-to-end
- **Risk**: Medium
- **Dependencies**: D.1-D.4

### D.6 — Phase D Playwright tests
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `tests/ui/viewer-interactions.spec.ts` (new)
- **Action**:
  1. Test `f` opens command palette
  2. Test `Esc` closes command palette
  3. Test `j`/`k` navigates sessions
  4. Test `/` focuses search
  5. Test `?` shows help overlay
  6. Test filter chips in palette apply correctly
  7. Test clicking outside palette closes it
  8. Test keyboard shortcuts don't fire during text input
  9. Update baseline screenshots
- **Acceptance**: All interaction tests pass
- **Risk**: Low
- **Dependencies**: D.5

### D.7 — Phase D code review
- **Agent**: `magic-claude:code-reviewer`
- **Action**: Review keyboard handling, focus management, accessibility (ARIA)
- **Acceptance**: No CRITICAL or HIGH issues, proper ARIA attributes
- **Dependencies**: D.6

### D.8 — Phase D simplification pass
- **Agent**: `magic-claude:ts-refactor-cleaner`
- **Action**: Remove old FilterBar CSS, check event listener cleanup
- **Acceptance**: No dead filter bar code
- **Dependencies**: D.7

---

## Phase E: Performance (Virtual Scrolling)

**Goal**: Add virtual scrolling for sessions with 50+ observations to maintain smooth rendering.

### E.1 — Install `@tanstack/react-virtual`
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `package.json`
- **Action**:
  1. `npm install @tanstack/react-virtual`
  2. Verify it builds correctly with esbuild IIFE format
  3. Check bundle size impact (should be ~5-10KB gzipped)
- **Acceptance**: Package installed, build succeeds, bundle size acceptable
- **Risk**: Low
- **Dependencies**: None

### E.2 — Add virtual scrolling to SessionDetail observation list
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/components/SessionDetail.tsx`
- **Action**:
  1. Import `useVirtualizer` from `@tanstack/react-virtual`
  2. Wrap observation list in virtualizer when count > 30:
     ```tsx
     const rowVirtualizer = useVirtualizer({
       count: observations.length,
       getScrollElement: () => scrollRef.current,
       estimateSize: () => 120, // estimated card height
       overscan: 5,
     });
     ```
  3. For sessions with <30 observations, render normally (no virtualization overhead)
  4. Handle variable-height cards with `measureElement` callback
  5. Ensure click-to-expand on cards works with virtualized list
- **Acceptance**: Sessions with 50+ observations scroll smoothly, no jank
- **Risk**: Medium -- variable-height cards with expand/collapse need careful measurement
- **Dependencies**: E.1, B.4

### E.3 — Add virtual scrolling to SessionList (left panel)
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `src/ui/viewer/components/SessionList.tsx`
- **Action**:
  1. Virtualize session list for users with 100+ sessions
  2. Day group headers are sticky and non-virtualized (or treated as list items)
  3. Infinite scroll trigger integrated with virtualizer
- **Acceptance**: Session list scrolls smoothly with large datasets
- **Risk**: Medium -- sticky day headers with virtualization is tricky
- **Dependencies**: E.1, B.3

### E.4 — Phase E performance benchmarks
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `tests/ui/viewer-performance.spec.ts` (new)
- **Action**:
  1. Playwright test that navigates to a session with many observations
  2. Measure scroll FPS using `page.evaluate` with PerformanceObserver
  3. Verify <16ms frame time during scroll (60fps target)
  4. Test memory usage doesn't grow linearly with observation count
- **Acceptance**: Smooth scrolling at 60fps with 100+ observations
- **Risk**: Low
- **Dependencies**: E.2, E.3

### E.5 — Phase E code review
- **Agent**: `magic-claude:code-reviewer`
- **Action**: Review virtualizer configuration, measurement callbacks, memory usage
- **Acceptance**: No CRITICAL or HIGH issues
- **Dependencies**: E.4

---

## Phase F: Polish & Integration Testing

**Goal**: Final polish, comprehensive testing, CSS cleanup, and merge preparation.

### F.1 — Responsive design pass
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: CSS in `viewer-template.html`
- **Action**:
  1. Desktop (1200px+): Two-panel layout, full command palette
  2. Tablet (768px-1199px): Narrower session list (~200px), smaller palette
  3. Mobile (<768px): Single column, session selector dropdown, bottom sheet for filters
  4. Test all breakpoints
- **Acceptance**: Usable at all breakpoints
- **Risk**: Medium
- **Dependencies**: All previous phases

### F.2 — Accessibility audit
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: All components
- **Action**:
  1. Ensure all interactive elements have `aria-label` or visible text
  2. Command palette has `role="dialog"` and `aria-modal="true"`
  3. Session list has `role="listbox"`, sessions have `role="option"`
  4. Focus trap in command palette
  5. Color contrast meets WCAG AA (4.5:1 for text)
  6. Screen reader testing with Playwright + `aria-*` assertions
- **Acceptance**: No accessibility violations in automated checks
- **Risk**: Low
- **Dependencies**: D complete

### F.3 — CSS final cleanup
- **Agent**: `magic-claude:ts-refactor-cleaner`
- **Files**: `src/ui/viewer-template.html`
- **Action**:
  1. Organize CSS into logical sections with comment headers:
     ```css
     /* ═══════════ Design Tokens ═══════════ */
     /* ═══════════ Reset & Base ═══════════ */
     /* ═══════════ Layout ═══════════ */
     /* ═══════════ Header ═══════════ */
     /* ═══════════ Session List ═══════════ */
     /* ═══════════ Session Detail ═══════════ */
     /* ═══════════ Cards ═══════════ */
     /* ═══════════ Command Palette ═══════════ */
     /* ═══════════ Responsive ═══════════ */
     ```
  2. Remove any remaining dead CSS from deleted components
  3. Consolidate media queries (group by breakpoint)
  4. Verify total CSS line count (target: <2,500 lines, down from 3,515)
- **Acceptance**: Organized, deduplicated CSS under 2,500 lines
- **Risk**: Low
- **Dependencies**: All previous phases

### F.4 — Full integration test suite
- **Agent**: `magic-claude:ts-tdd-guide`
- **Files**: `tests/ui/viewer-integration.spec.ts` (new)
- **Action**:
  1. Full user journey: open viewer → see session list → click session → view details
  2. Search flow: type query → results appear → clear → back to session view
  3. Filter flow: open palette → select type filter → results filter → clear
  4. Theme switch: change in settings → UI updates → persists on reload
  5. Real-time: SSE pushes new observation → appears in current session
  6. Keyboard full flow: `/` → search → `Esc` → `j`/`k` navigate → `Enter` select
  7. Mobile responsive: resize → single column → session selector works
- **Acceptance**: All integration tests pass
- **Risk**: Low
- **Dependencies**: All previous phases

### F.5 — Final code review
- **Agent**: `magic-claude:code-reviewer`
- **Action**: Full review of all changes across the feature branch
- **Acceptance**: No CRITICAL, HIGH, or MEDIUM issues remaining
- **Dependencies**: F.4

### F.6 — Security review
- **Agent**: `magic-claude:ts-security-reviewer`
- **Action**: Review for XSS in card rendering, secure event handling, no exposed secrets
- **Acceptance**: No security issues
- **Dependencies**: F.5

### F.7 — Build verification and merge
- **Agent**: Direct execution
- **Action**:
  1. `npm run build-and-sync` — clean build
  2. `npm run test` — all tests pass
  3. Playwright full suite — all pass
  4. Manual smoke test on localhost:37777
  5. Merge `feature/viewer-redesign` into `main`
- **Acceptance**: Clean merge, no conflicts, all tests pass
- **Risk**: Low
- **Dependencies**: F.6

---

## Testing Strategy

### Unit Tests (Vitest)
- `useSessionList` hook
- `useSessionDetail` hook
- `useKeyboardNavigation` hook
- Filter state management
- Data formatting utilities

### Component Tests (Vitest + React Testing Library)
- Card expand/collapse behavior
- SummaryCard section toggle
- CommandPalette filter chip interaction
- KeyboardShortcutHelp rendering

### E2E Tests (Playwright CLI)
- **Phase A**: `tests/ui/viewer.spec.ts` — visual regression baselines
- **Phase B**: `tests/ui/viewer-layout.spec.ts` — two-panel layout verification
- **Phase C**: `tests/ui/viewer-cards.spec.ts` — card redesign verification
- **Phase D**: `tests/ui/viewer-interactions.spec.ts` — keyboard and palette tests
- **Phase E**: `tests/ui/viewer-performance.spec.ts` — scroll performance
- **Phase F**: `tests/ui/viewer-integration.spec.ts` — full user journeys

### Playwright Configuration
```typescript
// playwright.config.ts
export default defineConfig({
  testDir: './tests/ui',
  use: {
    baseURL: 'http://localhost:37777',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
});
```

---

## Risks & Mitigations

### Risk: Two-panel layout breaks search/filter mode
- **Mitigation**: Search mode falls back to full-width feed layout (existing Feed component). Test this transition explicitly in Phase B.

### Risk: Virtual scrolling with variable-height cards
- **Mitigation**: Use `measureElement` callback from `@tanstack/react-virtual`. Only enable virtualization for sessions with >30 observations. Test with expand/collapse.

### Risk: Keyboard shortcuts conflict with input fields
- **Mitigation**: Check `document.activeElement.tagName` before firing shortcuts. Whitelist input elements. Test explicitly in Playwright.

### Risk: 4x theme deduplication breaks system-preference detection
- **Mitigation**: `useTheme.ts` already handles system preference via `window.matchMedia` and sets `data-theme` attribute. Verify in Phase A.3 that this works without the `@media` CSS blocks.

### Risk: Large CSS refactor introduces visual regressions
- **Mitigation**: Playwright screenshot comparison at every phase boundary. <1% pixel diff tolerance.

### Risk: esbuild doesn't bundle @tanstack/react-virtual correctly
- **Mitigation**: Test in Phase E.1 before writing virtualization code. The IIFE format should work since the library has no platform-specific code.

### Risk: Session-centric layout doesn't work well when filtering across sessions
- **Mitigation**: In filter/search mode, fall back to chronological feed view (existing behavior). The two-panel layout is only for browsing mode.

---

## Files Created (New)
- `playwright.config.ts`
- `tests/ui/viewer.spec.ts`
- `tests/ui/viewer-layout.spec.ts`
- `tests/ui/viewer-cards.spec.ts`
- `tests/ui/viewer-interactions.spec.ts`
- `tests/ui/viewer-performance.spec.ts`
- `tests/ui/viewer-integration.spec.ts`
- `src/ui/viewer/hooks/useSessionList.ts`
- `src/ui/viewer/hooks/useSessionDetail.ts`
- `src/ui/viewer/hooks/useKeyboardNavigation.ts`
- `src/ui/viewer/components/SessionList.tsx`
- `src/ui/viewer/components/SessionDetail.tsx`
- `src/ui/viewer/components/TwoPanel.tsx`
- `src/ui/viewer/components/CommandPalette.tsx`
- `src/ui/viewer/components/KeyboardShortcutHelp.tsx`

## Files Modified (Major)
- `src/ui/viewer-template.html` (CSS overhaul)
- `src/ui/viewer/App.tsx` (layout + state management)
- `src/ui/viewer/components/Header.tsx` (simplification)
- `src/ui/viewer/components/ObservationCard.tsx` (redesign)
- `src/ui/viewer/components/SummaryCard.tsx` (collapsible sections)
- `src/ui/viewer/components/PromptCard.tsx` (density)
- `src/ui/viewer/types.ts` (new types)
- `package.json` (new dependencies)

## Files Potentially Removed
- `src/ui/viewer/components/GitHubStarsButton.tsx` (moved out of header, may keep for other use)
- `src/ui/viewer/hooks/useGitHubStars.ts` (if GitHubStarsButton removed)
- `src/ui/viewer/components/FilterBar.tsx` (replaced by CommandPalette)
- `src/ui/viewer/components/FilterChip.tsx` (may be kept and reused in CommandPalette)

---

## Success Criteria

- [ ] CSS uses design tokens throughout (spacing, typography, radius, shadow, font)
- [ ] Theme variables defined exactly twice (`:root` light + `[data-theme="dark"]`)
- [ ] Zero inline `style={}` in components (except truly dynamic values)
- [ ] Two-panel layout with session list + detail view
- [ ] ObservationCard shows concepts/files always visible, left-border type accent
- [ ] SummaryCard has independently collapsible sections
- [ ] Header has 4-5 elements (logo, search, project, filter, settings)
- [ ] Command palette replaces filter bar
- [ ] Full keyboard navigation (j/k, Enter, /, Esc, f, ?)
- [ ] Virtual scrolling for 50+ observation sessions
- [ ] Responsive at desktop/tablet/mobile breakpoints
- [ ] Light/dark theme fully working
- [ ] Warm earthy palette preserved
- [ ] Monaspace Radon font preserved
- [ ] All Playwright tests passing
- [ ] CSS under 2,500 lines (down from 3,515)
- [ ] Clean merge to main
