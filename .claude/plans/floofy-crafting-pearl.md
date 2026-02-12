# Fix All 296 TypeScript Compilation Errors

## Context

After completing the Bun → Node.js + better-sqlite3 migration, `tsc --noEmit` reports 296 pre-existing TypeScript errors across 42 files. These errors were masked because the project relied on esbuild (which ignores types) and bun:test (which has looser type checking). Fixing them improves code quality and enables stricter type checking going forward.

## Error Inventory (296 total)

| Category | Count | Root Cause |
|----------|-------|------------|
| Missing Component literals | 148 | Logger `Component` type missing 13 string values |
| DOM lib missing | 42 | tsconfig.json `lib` lacks `"dom"` for React viewer |
| `unknown` data from fetch | 32 | `res.json()` returns `unknown` in strict TS |
| Record vs SearchResult types | 26 | `ObservationRecord[]` assigned to `ObservationSearchResult[]` |
| `value` on EventTarget | 16 | DOM lib missing (HTMLElement props) |
| Null possibly errors | 6 | Refs possibly null in useSpinningFavicon |
| WorkerRef visibility | 2 | `private sseBroadcaster` vs interface contract |
| ProcessEnv typing | 1 | `process.env` has `undefined` values |
| SDKAgent null vs undefined | 2 | `null` passed where `undefined` expected |
| Missing module | 1 | Wrong import path for ModeManager |
| HOOK_EXIT_CODES | 1 | Missing `USER_MESSAGE_ONLY` value |
| EventType string cast | 1 | `string` not assignable to `EventType` |
| `orderBy: 'relevance'` | 2 | Literal not in union type |
| Feed entries `any` | 1 | IntersectionObserver callback param |
| App.tsx state setters | 3 | `DataItem[]` returned instead of specific type |
| Misc type mismatches | 12 | Various minor issues |

## Fix 1: Add missing Component literals (148 errors → 0)

**File:** `src/utils/logger.ts:18`

Add 13 missing string literals to the `Component` type:

```
Current:  'HOOK' | 'WORKER' | 'SDK' | 'PARSER' | 'DB' | 'SYSTEM' | 'HTTP' | 'SESSION' | 'CHROMA' | 'FOLDER_INDEX'
Add:      'SEARCH' | 'CHROMA_SYNC' | 'BRANCH' | 'PROCESS' | 'CURSOR' | 'QUEUE' | 'IMPORT' | 'CONSOLE' | 'SECURITY' | 'SETTINGS' | 'ENV' | 'CONFIG' | 'PROJECT_NAME'
```

## Fix 2: Add `dom` lib to tsconfig.json (~60 errors → 0)

**File:** `tsconfig.json:7`

Change `"lib": ["ES2022"]` → `"lib": ["ES2022", "dom", "dom.iterable"]`

This fixes: TS2304 (window, document, Image, etc.), TS2812 (scrollTop, scrollHeight), TS2339 (.value on HTMLInputElement/HTMLSelectElement), TS2584 (document not found), TS7006 (IntersectionObserver entries), and TS18047 (null ref checks become valid).

## Fix 3: Type-assert fetch responses in viewer hooks (~32 errors → 0)

**Files:**
- `src/ui/viewer/hooks/useSettings.ts` — cast `data` from `.json()` as `Partial<Settings>`
- `src/ui/viewer/hooks/useContextPreview.ts` — cast `data` as expected shape
- `src/ui/viewer/hooks/useStats.ts` — cast `data` as stats shape
- `src/ui/viewer/components/LogsModal.tsx` — cast `data` as log entries
- `src/services/sync/ChromaSync.ts` — cast `result.content` (2 sites)

Pattern: `.then(res => res.json()).then((data: ExpectedType) => ...)` or `.then((data) => { const typed = data as ExpectedType; ... })`

## Fix 4: Fix ObservationRecord → ObservationSearchResult (26 errors → 0)

**Root cause:** `ObservationRecord` (database.ts) is missing fields that `ObservationSearchResult` (types.ts) requires: `subtitle`, `facts`, `narrative`, `concepts`, `files_read`, `files_modified`. Same for `SessionSummaryRecord` missing `files_read`, `files_edited`, `notes`.

**Fix approach:** Add the missing optional fields to `ObservationRecord` and `SessionSummaryRecord` in `src/types/database.ts`. These fields exist in the database schema (added by migrations) but were never added to the Record types:

```typescript
// ObservationRecord — add:
subtitle?: string | null;
facts?: string | null;
narrative?: string | null;
concepts?: string | null;
files_read?: string | null;
files_modified?: string | null;

// SessionSummaryRecord — add:
files_read?: string | null;
files_edited?: string | null;
notes?: string | null;
```

Then update return types in `SearchManager.ts` and search strategies to accept `ObservationRecord[]` where `ObservationSearchResult[]` is expected (add `as` casts at the ~15 assignment sites), OR better: change the variable types from `ObservationSearchResult[]` to `ObservationRecord[]` where FTS rank/score fields aren't used.

## Fix 5: Add `USER_MESSAGE_ONLY` to HOOK_EXIT_CODES (1 error → 0)

**File:** `src/shared/hook-constants.ts`

Add `USER_MESSAGE_ONLY: 0` (or appropriate value) to `HOOK_EXIT_CODES`.

## Fix 6: Cast `event` string to `EventType` (1 error → 0)

**File:** `src/cli/hook-command.ts:14`

Change `getEventHandler(event)` → `getEventHandler(event as EventType)`

## Fix 7: Fix WorkerRef interface mismatch (2 errors → 0)

**File:** `src/services/worker-service.ts`

The `sseBroadcaster` property is `private` in `WorkerService` but the `WorkerRef` interface expects it public. Fix: pass `this as unknown as WorkerRef` at the 2 call sites, OR change `private sseBroadcaster` to `public sseBroadcaster` (simpler, since it's already exposed via the interface contract).

## Fix 8: Fix ProcessEnv typing (1 error → 0)

**File:** `src/services/worker-service.ts:296`

Change `env: process.env` → `env: process.env as Record<string, string>`

## Fix 9: Fix SDKAgent null → undefined (2 errors → 0)

**File:** `src/services/worker/SDKAgent.ts`

Change `session.memorySessionId` (which is `string | null`) to use `?? undefined` or `|| undefined` at the 2 usage sites (lines 89, 117).

## Fix 10: Fix ModeManager import path (1 error → 0)

**File:** `src/services/worker/http/routes/SettingsRoutes.ts:16`

Change `../../domain/ModeManager.js` → `../../../domain/ModeManager.js` (needs one more `../` to reach `src/services/domain/`).

## Fix 11: Fix `orderBy: 'relevance'` type mismatch (2 errors → 0)

**File:** `src/services/worker/search/strategies/ChromaSearchStrategy.ts`

The `orderBy` value `'relevance'` isn't in the accepted union for the SessionStore methods. Fix: filter it out before passing, or add `'relevance'` to the accepted type.

## Fix 12: Fix App.tsx state setter types (3 errors → 0)

**File:** `src/ui/viewer/App.tsx` (lines 73, 76, 79)

The `loadMore()` returns `DataItem[]` but state expects specific types. Fix: add type assertions on the spread results, or type the `loadMore` return more precisely.

## Execution Order

1. **Fix 1** (Component type) — single line change, eliminates 148 errors
2. **Fix 2** (dom lib) — single line change, eliminates ~60 errors
3. **Fix 4** (Record types) — extend database types, eliminates 26 errors
4. **Fix 3** (fetch unknown) — type assertions in 5 files, eliminates 32 errors
5. **Fixes 5-12** (misc) — one-liner fixes across 7 files, eliminates ~13 errors

## Verification

1. `npx tsc --noEmit` — zero errors
2. `npx vitest run` — 805+ tests still pass
3. `npm run build` — esbuild succeeds
