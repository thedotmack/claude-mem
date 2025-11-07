# Claude-Mem Source Code Analysis Report

## Executive Summary

Analyzed all 58 files in the `/Users/alexnewman/Scripts/claude-mem/src` directory. This report categorizes each file by purpose, usage status, and documents the cleanup of dead code files.

**Cleanup Status**: ✅ **7 dead code files successfully removed** (51 files remaining)

---

## **Directory: src/bin** (2 files)

### `src/bin/cleanup-duplicates.ts`
- **Purpose**: Utility script to remove duplicate observations and summaries from the database
- **Used?**: **No** - Standalone CLI utility, not imported anywhere
- **Notes**: Maintenance tool for database cleanup. Keeps earliest entry (MIN(id)) for each duplicate group. Not part of the runtime system.

### `src/bin/import-xml-observations.ts`
- **Purpose**: Import tool to restore XML observations back into SQLite database
- **Used?**: **No** - Standalone CLI utility, not imported anywhere
- **Notes**: Data migration tool. Parses XML timestamps and matches them to transcript files. Not part of the runtime system.

---

## **Directory: src/hooks** (7 files, 1 deleted)

### `src/hooks/cleanup-hook.ts`
- **Purpose**: SessionEnd hook that marks sessions as completed and notifies worker
- **Used?**: **Yes** - Built to `plugin/scripts/cleanup-hook.js`, registered in `plugin/hooks/hooks.json`
- **Notes**: Core hook, actively used

### `src/hooks/context-hook.ts`
- **Purpose**: SessionStart hook that injects recent observations into Claude Code sessions
- **Used?**: **Yes** - Built to `plugin/scripts/context-hook.js`, registered in hooks.json, also called by user-message-hook
- **Notes**: Core hook displaying context timeline with progressive disclosure (index view)

### `src/hooks/hook-response.ts`
- **Purpose**: Utility module for creating standardized hook responses
- **Used?**: **Yes** - Imported by new-hook.ts, save-hook.ts, summary-hook.ts
- **Notes**: Shared helper for hook JSON output

### `src/hooks/index.ts` 🗑️ **DELETED**
- **Purpose**: Export barrel for hooks module
- **Used?**: **No** - Not imported anywhere
- **Notes**: **DELETED**. Exports were outdated (referenced `context.js`, `save.js`, etc. which don't exist). The actual hooks are built as standalone executables, not imported as modules.

### `src/hooks/new-hook.ts`
- **Purpose**: UserPromptSubmit hook that creates session records and saves raw user prompts
- **Used?**: **Yes** - Built to `plugin/scripts/new-hook.js`, registered in hooks.json
- **Notes**: Core hook, actively used

### `src/hooks/save-hook.ts`
- **Purpose**: PostToolUse hook that captures tool executions and sends to worker
- **Used?**: **Yes** - Built to `plugin/scripts/save-hook.js`, registered in hooks.json
- **Notes**: Core hook, actively used

### `src/hooks/summary-hook.ts`
- **Purpose**: Stop hook that requests session summaries from worker
- **Used?**: **Yes** - Built to `plugin/scripts/summary-hook.js`, registered in hooks.json
- **Notes**: Core hook, actively used

### `src/hooks/user-message-hook.ts`
- **Purpose**: SessionStart hook that displays context to users via stderr
- **Used?**: **Yes** - Built to `plugin/scripts/user-message-hook.js`, registered in hooks.json
- **Notes**: Runs context-hook via execSync to show colored output. Active hook.

---

## **Directory: src/sdk** (3 files, 1 deleted)

### `src/sdk/index.ts` 🗑️ **DELETED**
- **Purpose**: Export barrel for SDK module
- **Used?**: **No** - Not imported anywhere
- **Notes**: **DELETED**. Exported SDK functions but nothing imported from this module directly. Files import directly from prompts.ts and parser.ts instead.

### `src/sdk/parser.test.ts`
- **Purpose**: Regression tests for XML parsing (v4.2.5 and v4.2.6 bugfixes)
- **Used?**: **No** - Test file, not part of runtime
- **Notes**: Test suite with 18 tests validating observation/summary parsing edge cases

### `src/sdk/parser.ts`
- **Purpose**: XML parser for observation and summary blocks from SDK responses
- **Used?**: **Yes** - Imported by worker-service.ts
- **Notes**: Core parsing logic, actively used

### `src/sdk/prompts.ts`
- **Purpose**: Prompt builders for Claude Agent SDK
- **Used?**: **Yes** - Imported by worker-service.ts
- **Notes**: Generates init, observation, and summary prompts for SDK agent

---

## **Directory: src/servers** (1 file)

### `src/servers/search-server.ts`
- **Purpose**: MCP search server exposing 9 search tools with hybrid Chroma + FTS5 search
- **Used?**: **Yes** - Built to `plugin/search-server.mjs`, configured in `plugin/.mcp.json`
- **Notes**: 1,782 lines. Core search server providing progressive disclosure search tools.

---

## **Directory: src/services/sqlite** (6 files)

### `src/services/sqlite/Database.ts`
- **Purpose**: Base database class with better-sqlite3
- **Used?**: **Yes** - Imported by SessionStore.ts, SessionSearch.ts, index.ts
- **Notes**: Foundation class for SQLite operations

### `src/services/sqlite/index.ts`
- **Purpose**: Export barrel for sqlite module
- **Used?**: **Yes** - Imported by storage.ts
- **Notes**: Exports all store types and utilities

### `src/services/sqlite/migrations.ts`
- **Purpose**: Database migration function for schema changes
- **Used?**: **Yes** - Imported by index.ts
- **Notes**: Handles SQLite schema migrations

### `src/services/sqlite/SessionSearch.ts`
- **Purpose**: FTS5 full-text search implementation
- **Used?**: **Yes** - Imported by search-server.ts
- **Notes**: Provides searchObservations, searchSessions, searchUserPrompts, findByConcept, findByFile, findByType

### `src/services/sqlite/SessionStore.ts`
- **Purpose**: CRUD operations for sessions, observations, summaries, user prompts
- **Used?**: **Yes** - Imported by all hooks, worker-service.ts, search-server.ts, bin utilities
- **Notes**: Core database store, heavily used throughout the system

### `src/services/sqlite/types.ts`
- **Purpose**: TypeScript type definitions for database records
- **Used?**: **Yes** - Imported by search-server.ts
- **Notes**: Defines ObservationSearchResult, SessionSummarySearchResult, UserPromptSearchResult

---

## **Directory: src/services/sync** (1 file)

### `src/services/sync/ChromaSync.ts`
- **Purpose**: Vector database synchronization service for semantic search
- **Used?**: **Yes** - Imported by worker-service.ts
- **Notes**: 737 lines. Manages Chroma vector embeddings for observations, summaries, and prompts. Critical for hybrid search.

---

## **Directory: src/services** (1 file)

### `src/services/worker-service.ts`
- **Purpose**: Express HTTP server managed by PM2, handles SDK agent sessions
- **Used?**: **Yes** - Built to `plugin/worker-service.cjs`, started by PM2
- **Notes**: 1,173 lines. Core worker service with 14 HTTP/SSE endpoints. Serves viewer UI, manages SDK sessions, broadcasts SSE updates.

---

## **Directory: src/shared** (2 files, 3 deleted)

### `src/shared/config.ts` 🗑️ **DELETED**
- **Purpose**: Package configuration (name, version, description)
- **Used?**: **No** - Not imported anywhere
- **Notes**: **DELETED**. Read from package.json but no code used these exports. The actual version reading happens inline in worker-service.ts.

### `src/shared/paths.ts`
- **Purpose**: Path utilities and directory management
- **Used?**: **Yes** - Imported by search-server.ts
- **Notes**: Provides VECTOR_DB_DIR and other path constants. Actively used.

### `src/shared/storage.ts` 🗑️ **DELETED**
- **Purpose**: Unified storage provider interface (SQLite abstraction layer)
- **Used?**: **No** - Not imported anywhere
- **Notes**: **DELETED**. Defined IStorageProvider interface and SQLiteStorageProvider but nothing used this abstraction. Direct SessionStore usage is preferred.

### `src/shared/types.ts` 🗑️ **DELETED**
- **Purpose**: Core type definitions (Settings interface)
- **Used?**: **No** - Not imported anywhere
- **Notes**: **DELETED**. Defined Settings interface but no code imported it. Settings are read/written as raw JSON objects.

### `src/shared/worker-utils.ts`
- **Purpose**: Worker health checks and PM2 management
- **Used?**: **Yes** - Imported by context-hook.ts, new-hook.ts, save-hook.ts, summary-hook.ts, cleanup-hook.ts, user-message-hook.ts
- **Notes**: Core utility, actively used by all hooks

---

## **Directory: src/utils** (1 file, 2 deleted)

### `src/utils/logger.ts`
- **Purpose**: Structured logging with correlation IDs and data flow tracking
- **Used?**: **Yes** - Imported by parser.ts, save-hook.ts, summary-hook.ts, worker-service.ts
- **Notes**: Core logger, actively used

### `src/utils/platform.ts` 🗑️ **DELETED**
- **Purpose**: Platform-specific utilities for Windows/Unix compatibility
- **Used?**: **No** - Not imported anywhere
- **Notes**: **DELETED**. Provided installUv(), getShellConfigPaths(), getAliasDefinition() but nothing used these. Likely leftover from earlier installer/setup code.

### `src/utils/usage-logger.ts` 🗑️ **DELETED**
- **Purpose**: Usage data logger for API cost tracking (JSONL files)
- **Used?**: **No** - Not imported anywhere
- **Notes**: **DELETED**. Defined UsageLogger class but it was never instantiated. Usage tracking may be handled differently now.

---

## **Directory: src/ui** (24 files + assets)

### `src/ui/claude-mem-logo-for-dark-mode.webp`
- **Purpose**: Logo asset for dark mode
- **Used?**: **Yes** - Referenced in Header.tsx, bundled into viewer.html
- **Notes**: Web UI asset

### `src/ui/claude-mem-logomark.webp`
- **Purpose**: Logomark asset
- **Used?**: **Yes** - Referenced in Header.tsx, bundled into viewer.html
- **Notes**: Web UI asset

### `src/ui/viewer-template.html`
- **Purpose**: HTML template for viewer UI
- **Used?**: **Yes** - Build process uses this to generate plugin/ui/viewer.html
- **Notes**: Build artifact template

### `src/ui/viewer/App.tsx`
- **Purpose**: Root React component for viewer UI
- **Used?**: **Yes** - Entry point for viewer, imported by index.tsx
- **Notes**: Main app component

### `src/ui/viewer/index.tsx`
- **Purpose**: React app entry point
- **Used?**: **Yes** - Built by esbuild into viewer-bundle.js
- **Notes**: Mounts React app

### `src/ui/viewer/types.ts`
- **Purpose**: TypeScript types for viewer UI
- **Used?**: **Yes** - Imported by multiple viewer components
- **Notes**: Type definitions for Observation, Summary, UserPrompt, etc.

### **src/ui/viewer/assets/fonts/** (2 files)
- `monaspace-radon-var.woff` and `monaspace-radon-var.woff2`
- **Purpose**: Monaspace Radon font files for viewer UI
- **Used?**: **Yes** - Embedded in viewer.html via esbuild
- **Notes**: Font assets

### **src/ui/viewer/components/** (8 files)
All actively used by App.tsx:
- `ErrorBoundary.tsx` - Error boundary wrapper
- `Feed.tsx` - Infinite scroll feed component
- `Header.tsx` - Top navigation with project selector, stats, settings
- `ObservationCard.tsx` - Observation display card
- `PromptCard.tsx` - User prompt display card
- `Sidebar.tsx` - Project filtering sidebar
- `SummaryCard.tsx` - Session summary display card
- `ThemeToggle.tsx` - Light/dark mode toggle

### **src/ui/viewer/constants/** (4 files)
All actively used by viewer components:
- `api.ts` - API endpoint URLs
- `settings.ts` - Default settings constants
- `timing.ts` - Timing constants (reconnect delays, polling intervals)
- `ui.ts` - UI constants (page sizes, etc.)

### **src/ui/viewer/hooks/** (5 files)
All actively used by viewer components:
- `usePagination.ts` - Infinite scroll pagination hook
- `useSSE.ts` - Server-sent events hook for real-time updates
- `useSettings.ts` - Settings management hook
- `useStats.ts` - Worker stats fetching hook
- `useTheme.ts` - Theme (light/dark) management hook

### **src/ui/viewer/utils/** (2 files)
All actively used by viewer components:
- `data.ts` - Data merging and deduplication utilities
- `formatters.ts` - Date/time formatting utilities

---

## Dead Code Summary

### **🗑️ Deleted Files** (7 files - all removed)
1. **src/hooks/index.ts** ✅ DELETED - Outdated export barrel, referenced non-existent files
2. **src/shared/config.ts** ✅ DELETED - Package config not used anywhere, version read inline instead
3. **src/shared/storage.ts** ✅ DELETED - Abstraction layer not used, direct SessionStore usage preferred
4. **src/shared/types.ts** ✅ DELETED - Settings interface not imported anywhere
5. **src/sdk/index.ts** ✅ DELETED - Export barrel, but imports happened directly from parser/prompts instead
6. **src/utils/platform.ts** ✅ DELETED - Platform utilities not used, legacy installer code
7. **src/utils/usage-logger.ts** ✅ DELETED - UsageLogger class never instantiated

### **Utility/Maintenance Scripts** (not dead, just not runtime code) (2 files)
8. **src/bin/cleanup-duplicates.ts** - Maintenance CLI tool
9. **src/bin/import-xml-observations.ts** - Data migration CLI tool

### **Test Files** (not dead, just not runtime code) (1 file)
10. **src/sdk/parser.test.ts** - Regression test suite

---

## File Count Summary

- **Total files** (before cleanup): 58
- **Total files** (after cleanup): **51** ✅
- **Deleted dead code**: **7 files** 🗑️
- **Actively used at runtime**: 43 files
- **Utility/maintenance scripts**: 2 files
- **Test files**: 1 file
- **Build templates**: 1 file (viewer-template.html)
- **Assets**: 4 files (2 logos, 2 fonts)

---

## Cleanup Actions Completed ✅

1. **✅ Removed all dead code** (7 files deleted):
   - ✅ Deleted `src/hooks/index.ts`
   - ✅ Deleted `src/shared/config.ts`
   - ✅ Deleted `src/shared/storage.ts`
   - ✅ Deleted `src/shared/types.ts`
   - ✅ Deleted `src/sdk/index.ts`
   - ✅ Deleted `src/utils/platform.ts`
   - ✅ Deleted `src/utils/usage-logger.ts`

2. **✅ Kept utility scripts** for maintenance purposes:
   - ✅ Kept `src/bin/cleanup-duplicates.ts`
   - ✅ Kept `src/bin/import-xml-observations.ts`

3. **✅ Kept test files** for regression testing:
   - ✅ Kept `src/sdk/parser.test.ts`

## Next Steps

1. **Build and test** to ensure no broken imports:
   ```bash
   npm run build
   ```

2. **Run TypeScript diagnostics** to catch any missing references:
   ```bash
   npx tsc --noEmit
   ```

3. **Commit the cleanup**:
   ```bash
   git add -A
   git commit -m "Remove dead code files"
   ```
