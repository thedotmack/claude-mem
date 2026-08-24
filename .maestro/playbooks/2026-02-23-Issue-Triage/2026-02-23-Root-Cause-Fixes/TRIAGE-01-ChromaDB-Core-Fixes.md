# Phase 01: ChromaDB Core Fixes — The #1 Issue Cluster (~25 issues)

The v10.3.0 migration from JS Chroma bindings to Python chroma-mcp via uvx is the single largest source of bugs. The critical root cause: `buildCommandArgs()` in ChromaMcpManager.ts never reads the `CLAUDE_MEM_PYTHON_VERSION` setting despite it existing in SettingsDefaultsManager. Without `--python` pinning, uvx picks whatever Python is available, and Python 3.14 breaks pydantic. Secondary: Windows path separators break chromadb's rust bindings, and there's no way to disable Chroma for users who don't want it.

**Issues resolved:** #1196, #1206, #1208 (Python pinning), #1199 (Windows paths), #707 (disable Chroma), #1183, #1188 (metadata errors), #1162 (Rust panic), #642 (JSON parse error), #1182 (SSL)

## Root Cause Validation

**Python version pinning** — CONFIRMED BUG: `ChromaMcpManager.ts:buildCommandArgs()` (line 177-221) constructs uvx args but NEVER reads `CLAUDE_MEM_PYTHON_VERSION` from settings. The setting exists in `SettingsDefaultsManager.ts` (line 96, default `'3.13'`) but is unused. Fix is 5 lines in `buildCommandArgs()`.

**Windows backslash paths** — CONFIRMED BUG: `DEFAULT_CHROMA_DATA_DIR` (line 29) uses `path.join()` which produces `C:\Users\...\.claude-mem\chroma` on Windows. Chromadb's rust bindings throw `Access Denied (OS error 5)` on backslash paths.

**SSL defaults** — ALREADY CORRECT: `CLAUDE_MEM_CHROMA_SSL` defaults to `'false'` (SettingsDefaultsManager line 124). The `buildCommandArgs()` remote mode only adds `--ssl` when `chromaSsl` is truthy (line 196). No fix needed here unless users explicitly override.

**Metadata conversion** — LIKELY STILL AN ISSUE: `addDocuments()` passes metadata to chroma-mcp via MCP. If any metadata value is null/undefined/nested, chroma-mcp may reject it. The `ChromaDocument` interface already constrains to `string | number`, but the backfill path reads raw SQLite rows which could have nulls.

## Tasks

- [x] Fix Python version pinning in `src/services/sync/ChromaMcpManager.ts`:
  - In `buildCommandArgs()`, read `CLAUDE_MEM_PYTHON_VERSION` from settings (already loaded on line 178)
  - Add `'--python', pythonVersion` to BOTH the local-mode args (line 216-220) and remote-mode args (line 189-212)
  - The setting already exists as `settings.CLAUDE_MEM_PYTHON_VERSION` — just read it
  - Also check env var `CLAUDE_MEM_PYTHON_VERSION` as override: `process.env.CLAUDE_MEM_PYTHON_VERSION || settings.CLAUDE_MEM_PYTHON_VERSION || '3.13'`
  - This is a ~5 line change, do NOT create any new files or utility modules
  - **DONE**: Added `pythonVersion` from env/settings/default chain, added `'--python', pythonVersion` to both local and remote mode args.

- [x] Fix Windows backslash paths for Chroma data directory in `src/services/sync/ChromaMcpManager.ts`:
  - On line 29, `DEFAULT_CHROMA_DATA_DIR` uses `path.join()` which produces backslashes on Windows
  - Fix: add `.replace(/\\/g, '/')` when passing the path as a uvx argument in `buildCommandArgs()` (line 219)
  - This ONLY needs to be applied to the `--data-dir` argument passed to uvx, not to the constant itself
  - Also apply the same fix to the remote-mode args if any paths are passed there
  - This is a 1-line change
  - **DONE**: Applied `.replace(/\\/g, '/')` to the `--data-dir` argument only.

- [x] Add `CLAUDE_MEM_CHROMA_ENABLED` setting for SQLite-only fallback mode:
  - Add `CLAUDE_MEM_CHROMA_ENABLED: 'true'` to `SettingsDefaultsManager.ts` defaults and the `SettingsDefaults` interface
  - In `src/services/worker-service.ts`, find where `ChromaSync` is instantiated and passed to `SearchOrchestrator`
  - If `CLAUDE_MEM_CHROMA_ENABLED` is `'false'`, pass `null` instead of a ChromaSync instance
  - `SearchOrchestrator` already handles `null` chromaSync gracefully (line 54-62 in SearchOrchestrator.ts) — SQLite search still works
  - Also skip the `backfillAllProjects()` call when Chroma is disabled
  - This is ~10 lines across 2 files, do NOT create any new files
  - **DONE**: Added setting to interface+defaults. DatabaseManager.initialize() skips ChromaSync when disabled. getChromaSync() returns null (not throws). Updated SearchManager to accept `ChromaSync | null`. ResponseProcessor uses optional chaining (`?.`). Worker-service skips ChromaMcpManager init when disabled.

- [x] Add try/catch around Chroma metadata in the backfill path:
  - In `ChromaSync.ts`, the `addDocuments()` method (line 257) calls `chromaMcp.callTool('chroma_add_documents', ...)` with metadata
  - The metadata is built by `formatObservationDocs()` (line 122) which already constrains types via the `ChromaDocument` interface
  - However, `baseMetadata.subtitle` (line 143) could be null if subtitle is empty, and `concepts.join(',')` could produce empty string
  - Add a simple sanitization: before the `chroma_add_documents` call, filter out null/undefined values from metadata objects
  - In `addDocuments()`, before the callTool, add: `const cleanMetadatas = batch.map(d => Object.fromEntries(Object.entries(d.metadata).filter(([_, v]) => v !== null && v !== undefined && v !== '')))`
  - Also wrap the entire `addDocuments` call in try/catch — if a batch fails, log the error and continue (don't let one bad metadata entry stop the entire backfill)
  - **DONE**: Added metadata sanitization (filter null/undefined/empty) and try/catch per batch in addDocuments().

- [x] Add a defensive try/catch in `ChromaMcpManager.callTool()` for Rust panics:
  - The existing `callTool()` method (line 231) throws on `result.isError` but does NOT catch underlying transport errors
  - The `await this.client!.callTool(...)` on line 238 can throw if the chroma-mcp subprocess panics (e.g., HNSW index corruption from chromadb v1.1.1)
  - Wrap the `this.client!.callTool(...)` in try/catch. If it throws with a transport error (subprocess died), set `this.connected = false` so the next call triggers reconnect
  - Do NOT add a circuit breaker or consecutive failure tracking — keep it simple
  - **DONE**: Wrapped callTool in try/catch, sets `this.connected = false` on transport error for auto-reconnect.

- [x] Run `npm test` and fix any failures introduced by the above changes. Run `npm run build-and-sync` to verify the build succeeds.
  - **DONE**: 932 tests pass, 21 pre-existing failures (none from our changes). Build succeeds.
