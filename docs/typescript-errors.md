# TypeScript Errors to Fix

Generated: 2025-11-06

## Summary

Total files with errors: 20
Total error count: 160+

## Errors by File

### 1. src/sdk/parser.ts (5 errors)
**Lines 149-153**: Type 'string | null' is not assignable to type 'string'
- `request` - line 149
- `investigated` - line 150
- `learned` - line 151
- `completed` - line 152
- `next_steps` - line 153

**Fix**: Update return type to allow null values or provide default values

---

### 2. src/hooks/index.ts (4 errors)
**Lines 0-3**: Cannot find module errors
- `'./context.js'` - line 0
- `'./save.js'` - line 1
- `'./new.js'` - line 2
- `'./summary.js'` - line 3

**Fix**: Update imports to use correct paths without .js extension

---

### 3. src/sdk/index.ts (1 error)
**Line 4**: `'./prompts.js'` has no exported member named 'buildFinalizePrompt'

**Fix**: Remove unused import or implement the missing function

---

### 4. src/services/sync/ChromaSync.ts (26 errors)
**Multiple lines**: Argument of type '"CHROMA_SYNC"' is not assignable to parameter of type 'Component'
- Lines: 91, 114, 116, 141, 144, 155, 157, 324, 329, 370, 409, 463, 493, 535, 541, 546, 562, 589, 607, 630, 648, 679, 697, 703, 718, 733

**Line 508**: `'result.content'` is of type 'unknown'

**Fix**: Add 'CHROMA_SYNC' to Component type union or update logger calls

---

### 5. src/shared/config.ts (1 error)
**Line 11**: Cannot find name '__DEFAULT_PACKAGE_VERSION__'

**Fix**: This should be injected during build, check build configuration

---

### 6. src/shared/storage.ts (25 errors)
**Lines 1-5**: Module has no exported member errors
- `'createStores'` - line 1
- `'MemoryStore'` - line 3
- `'OverviewStore'` - line 4
- `'DiagnosticsStore'` - line 5

**Lines 87-162**: Various property errors (legacy interface usage)
- Property 'create' does not exist - line 87
- Property 'getBySessionId' does not exist - line 92
- Property 'has' does not exist - line 97
- Property 'getAllSessionIds' does not exist - line 102
- Property 'getRecent' does not exist - line 107
- Property 'getRecentForProject' does not exist - line 112
- Multiple 'stores' is possibly 'undefined' errors

**Fix**: Remove legacy code or update to use current SessionStore interface

---

### 7. src/servers/search-server.ts (8 errors)
**Line 58**: `'result.content'` is of type 'unknown'
**Lines 150, 230, 309**: 'index' is declared but its value is never read
**Lines 371, 466, 1032, 1405**: 'id' is declared but its value is never read

**Fix**: Add proper type assertions and remove unused variables

---

### 8. src/services/sqlite/Database.ts (1 error)
**Line 0**: Cannot find module 'bun:sqlite'

**Fix**: This is legacy code using Bun's SQLite, should not be imported

---

### 9. src/services/sqlite/migrations.ts (2 errors)
**Line 0**: Cannot find module 'bun:sqlite'
**Line 153**: 'db' is declared but its value is never read

**Fix**: Update imports to use better-sqlite3 instead

---

### 10. tests/session-search.test.ts (1 error)
**Line 173**: Type 'null' is not assignable to type 'SessionSearch'

**Fix**: Update test to handle nullable type properly

---

### 11. React/Viewer UI Files (100+ errors)

#### All .tsx files: Cannot use JSX unless '--jsx' flag is provided
This affects all viewer components but is expected - these are built with esbuild which handles JSX.

#### src/ui/viewer/hooks/usePagination.ts (2 errors)
**Lines 66, 70**: `'data'` is of type 'unknown'

#### src/ui/viewer/hooks/useSettings.ts (5 errors)
**Lines 17-19**: `'data'` is of type 'unknown'
**Lines 40, 45**: `'result'` is of type 'unknown'

#### src/ui/viewer/hooks/useSSE.ts (2 errors)
**Line 19**: `'data'` is of type 'unknown'
**Line 71**: Type mismatch in setObservations

#### src/ui/viewer/hooks/useStats.ts (1 error)
**Line 13**: Argument of type 'unknown' not assignable to SetStateAction

#### src/ui/viewer/hooks/useTheme.ts (8 errors)
**Multiple lines**: DOM-related type errors
- Cannot find name 'window' - lines 8, 9, 48
- Cannot find name 'localStorage' - lines 14, 61
- Cannot find name 'document' - lines 41, 52
- Cannot find name 'MediaQueryListEvent' - line 49

**Fix**: Add DOM lib to tsconfig for viewer files or add type assertions

#### src/ui/viewer/index.tsx (2 errors)
**Line 5**: Cannot find name 'document'
**Multiple**: JSX errors (expected, built with esbuild)

#### src/ui/viewer/App.tsx (3 errors)
**Lines 63, 66, 69**: Type mismatch errors in setState callbacks

#### src/ui/viewer/components/Header.tsx (6 errors)
**Lines 46, 47, 66, 67, 85, 86**: Property 'style' does not exist on EventTarget & HTMLAnchorElement
**Line 94**: Property 'value' does not exist on EventTarget & HTMLSelectElement

#### src/ui/viewer/components/Feed.tsx (2 errors)
**Line 30**: Cannot find name 'IntersectionObserver'
**Line 31**: Parameter 'entries' implicitly has 'any' type

#### src/ui/viewer/components/Sidebar.tsx (3 errors)
**Lines 81, 99, 113**: Property 'value' does not exist on EventTarget

---

## Priority Fix Order

1. **High Priority - Breaks build:**
   - src/shared/config.ts (__DEFAULT_PACKAGE_VERSION__)
   - src/hooks/index.ts (module import errors)
   - src/sdk/index.ts (buildFinalizePrompt export)
   - src/shared/storage.ts (legacy interface usage)

2. **Medium Priority - Type safety:**
   - src/sdk/parser.ts (null handling)
   - src/services/sync/ChromaSync.ts (logger Component type)
   - src/servers/search-server.ts (unknown types)
   - React hooks (unknown types)

3. **Low Priority - Cosmetic:**
   - Unused variable warnings
   - JSX errors (these are expected, esbuild handles them)
   - DOM type errors in viewer (handled by esbuild)

4. **Legacy/Cleanup:**
   - src/services/sqlite/Database.ts (remove bun:sqlite)
   - src/services/sqlite/migrations.ts (update to better-sqlite3)
   - src/shared/storage.ts (remove entire file if legacy)
