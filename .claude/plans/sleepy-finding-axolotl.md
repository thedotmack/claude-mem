# Viewer UI: Search, Filtering, and Timeline Scrubbing

## Context

The viewer UI at http://localhost:37777 is a live chronological feed of observations, summaries, and prompts. It supports project filtering and infinite scroll pagination but has no search, no type/concept/date filtering, and no way to navigate to a specific point in time.

The worker API already supports all of this server-side: `/api/search` handles semantic search (Chroma) + metadata filtering (type, concepts, date range, project), and `/api/timeline` provides chronological context around anchor points. The gap is purely in the UI — these capabilities are only accessible to Claude via MCP tools, not to humans in the browser.

This plan adds three features to the open-source viewer:
1. **Search bar** — text search using existing `/api/search?format=json`
2. **Filter bar** — multi-select chips for type, concept, item kind, date range
3. **Activity bar** — visual timeline showing observation density per day, click to navigate

## Architecture

### Data flow modes

The viewer currently has two modes:
- **Live mode** (no filter): SSE streaming + pagination, merged with dedup
- **Project filter mode**: pagination only, SSE ignored

This plan adds a third:
- **Search/filter mode**: results from `/api/search?format=json`, SSE ignored, own pagination via offset

A single `FilterState` object replaces the current `currentFilter` string. The `isFilterMode` flag is true when anything beyond project is set (query, types, concepts, dates, item kinds). When `isFilterMode` is false and project is set, existing project-filter behavior is preserved.

### API integration

All filtering uses `GET /api/search?format=json` with these params:

| FilterState field | API param | Notes |
|---|---|---|
| `query` | `query` | Triggers Chroma semantic search |
| `project` | `project` | Direct pass-through |
| `obsTypes` | `obs_type` | Comma-separated: `bugfix,feature` |
| `concepts` | `concepts` | Comma-separated: `how-it-works,gotcha` |
| `itemKinds` | `type` | Comma-separated: `observations,sessions` |
| `dateStart` | `dateStart` | ISO date string |
| `dateEnd` | `dateEnd` | ISO date string |
| — | `offset`, `limit` | Pagination (limit=50) |
| — | `format` | Always `json` |

Response shape (`SearchManager.ts:332`):
```json
{ "observations": [...], "sessions": [...], "prompts": [...], "totalResults": N, "query": "..." }
```

`ObservationSearchResult` extends `ObservationRow` (adds optional `rank`/`score`) — superset of viewer's `Observation` type. Compatible.

### Activity density

No dedicated density endpoint exists. The activity bar fetches `/api/search?format=json&limit=1000&project=...` with a 90-day date range, then buckets results client-side by day. This avoids adding a new server endpoint. If this proves slow on large datasets, a dedicated `/api/activity` endpoint can be added later.

## New types — `src/ui/viewer/types.ts`

```typescript
export interface FilterState {
  query: string;
  project: string;
  obsTypes: string[];
  concepts: string[];
  itemKinds: Array<'observations' | 'sessions' | 'prompts'>;
  dateStart: string;
  dateEnd: string;
}

export interface SearchResponse {
  observations: Observation[];
  sessions: Summary[];
  prompts: UserPrompt[];
  totalResults: number;
  query: string;
}

export interface ActivityDay {
  date: string;       // YYYY-MM-DD
  count: number;
  observations: number;
  summaries: number;
  prompts: number;
}
```

## New constants — `src/ui/viewer/constants/filters.ts`

```typescript
export const OBSERVATION_TYPES = ['bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision'] as const;
export const OBSERVATION_CONCEPTS = ['how-it-works', 'why-it-exists', 'what-changed', 'problem-solution', 'gotcha', 'pattern', 'trade-off'] as const;
export const ITEM_KINDS = ['observations', 'summaries', 'prompts'] as const;
```

## New hooks

### `useFilters` — `src/ui/viewer/hooks/useFilters.ts`

Manages immutable `FilterState`. Exposes `setQuery`, `setProject`, `toggleObsType`, `toggleConcept`, `toggleItemKind`, `setDateRange`, `clearAll`. Derives `hasActiveFilters` and `isFilterMode` (true when anything beyond project is set).

### `useSearch` — `src/ui/viewer/hooks/useSearch.ts`

Takes `FilterState`, debounces query by 300ms, builds URL params, calls `GET /api/search?format=json&...`. Returns `{ results, isSearching, hasMore, loadMore, totalResults }`. Manages its own offset for pagination. Resets offset when any filter changes.

### `useActivityDensity` — `src/ui/viewer/hooks/useActivityDensity.ts`

Takes `project` string. Fetches 90-day window via `/api/search?format=json&limit=1000&dateStart=...&dateEnd=...&project=...`. Buckets by day using `created_at_epoch`. Returns `{ days: ActivityDay[], isLoading }`. Caches result, refetches only on project change.

## New components

### `SearchBar` — `src/ui/viewer/components/SearchBar.tsx`

Text input with search icon, clear button, loading spinner. Renders in Header between logo and status area. Keyboard: Enter submits, Escape clears.

### `FilterBar` — `src/ui/viewer/components/FilterBar.tsx`

Collapsible bar between Header and Feed. Contains:
- Type chips (multi-select, reuse existing `.chip` CSS from `viewer-template.html:2000`)
- Concept chips (multi-select)
- Item kind chips (multi-select)
- Date range inputs (native `<input type="date">`)
- Clear All button
- Stacks vertically on mobile (<600px)

### `FilterChip` — `src/ui/viewer/components/FilterChip.tsx`

Reusable chip button using existing `.chip` / `.chip.selected` CSS classes.

### `ActivityBar` — `src/ui/viewer/components/ActivityBar.tsx`

Horizontal bar chart, 60px tall. Each day = one vertical bar, height proportional to count. Color-coded: blue (observations), amber (summaries), purple (prompts) — matching existing `--color-border-observation`, `--color-border-summary`, `--color-border-prompt` vars. Click selects day as date filter, drag selects range. Hover tooltip: "Feb 10 — 12 obs, 2 summaries". On mobile (<480px): group by week.

### `SearchResultsBadge` — `src/ui/viewer/components/SearchResultsBadge.tsx`

Slim bar above feed: "N results for 'query'" + clear button. Only renders when `isFilterMode`.

## Modified files

### `App.tsx`

Replace `currentFilter` string with `useFilters()` hook. Add `useSearch(filters)` and `useActivityDensity(filters.project)`. Data flow:
- `isFilterMode` true → feed receives `search.results.observations/sessions/prompts`
- `isFilterMode` false, project set → existing project-filter pagination behavior
- Neither → SSE + pagination merge (existing)

Add `filterBarOpen` state. Render `FilterBar` and `SearchResultsBadge`.

### `Header.tsx`

Add `SearchBar` component. Add filter toggle button (funnel icon) with active badge showing count of active filters. Pass new props: `query`, `onQueryChange`, `isSearching`, `resultCount`, `filterCount`, `onFilterToggle`.

### `constants/api.ts`

Add `SEARCH: '/api/search'` endpoint constant.

### `constants/ui.ts`

Add `SEARCH_DEBOUNCE_MS: 300`, `SEARCH_PAGE_SIZE: 50`, `ACTIVITY_BAR_DAYS: 90`.

### `viewer-template.html`

Add CSS for: `.search-bar`, `.filter-bar`, `.filter-bar.collapsed`/`.expanded`, `.activity-bar`, `.activity-bar-column`, `.search-results-badge`, `.filter-toggle-btn`, responsive breakpoints. All use existing CSS custom properties.

## Files summary

| File | Action |
|------|--------|
| `src/ui/viewer/types.ts` | Add `FilterState`, `SearchResponse`, `ActivityDay` |
| `src/ui/viewer/constants/filters.ts` | New: type/concept/kind constants |
| `src/ui/viewer/constants/api.ts` | Add `SEARCH` endpoint |
| `src/ui/viewer/constants/ui.ts` | Add search/activity constants |
| `src/ui/viewer/hooks/useFilters.ts` | New: filter state management |
| `src/ui/viewer/hooks/useSearch.ts` | New: search API integration |
| `src/ui/viewer/hooks/useActivityDensity.ts` | New: timeline density data |
| `src/ui/viewer/components/SearchBar.tsx` | New: search input |
| `src/ui/viewer/components/FilterBar.tsx` | New: collapsible filter panel |
| `src/ui/viewer/components/FilterChip.tsx` | New: reusable chip button |
| `src/ui/viewer/components/ActivityBar.tsx` | New: timeline visualization |
| `src/ui/viewer/components/SearchResultsBadge.tsx` | New: result count display |
| `src/ui/viewer/App.tsx` | Refactor: FilterState, search integration |
| `src/ui/viewer/components/Header.tsx` | Modify: add SearchBar + filter toggle |
| `src/ui/viewer-template.html` | Add CSS for all new components |

## Implementation phases

### Phase 1: Search bar + useFilters + useSearch

Core search functionality. Creates the FilterState foundation that phases 2-3 build on.

Files: `types.ts`, `constants/filters.ts`, `constants/api.ts`, `constants/ui.ts`, `hooks/useFilters.ts`, `hooks/useSearch.ts`, `components/SearchBar.tsx`, `components/SearchResultsBadge.tsx`, `App.tsx`, `Header.tsx`, `viewer-template.html`

### Phase 2: Filter bar with chips + date range

Multi-select filtering by type, concept, item kind, date range.

Files: `components/FilterBar.tsx`, `components/FilterChip.tsx`, `App.tsx` (add filterBarOpen), `Header.tsx` (add filter toggle), `viewer-template.html` (filter CSS)

### Phase 3: Activity bar (timeline scrubbing)

Visual density chart with click-to-navigate.

Files: `hooks/useActivityDensity.ts`, `components/ActivityBar.tsx`, `FilterBar.tsx` (embed ActivityBar), `viewer-template.html` (activity bar CSS)

### Phase 4: Polish + mobile

Mobile responsive adjustments, keyboard navigation, ARIA attributes, animation polish.

## Verification

1. `npm run build-and-sync` — build succeeds
2. Open http://localhost:37777 — viewer loads, existing feed works unchanged
3. Type in search bar → results appear, feed switches to search mode
4. Clear search → back to live SSE feed
5. Open filter bar → select "bugfix" type → only bugfix observations shown
6. Select date range → feed filters by date
7. Activity bar shows density, click on a day → date filter applied
8. Mobile: all components stack correctly, no overflow
9. Theme: switch dark/light — all new components respect theme variables
