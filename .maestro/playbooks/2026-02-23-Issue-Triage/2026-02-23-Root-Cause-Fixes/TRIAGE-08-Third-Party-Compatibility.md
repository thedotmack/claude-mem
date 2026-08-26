# Phase 08: Third-Party Compatibility & UX — Ecosystem Support

Compatibility issues with Codex CLI, Cursor, and the viewer UI. Also fixes the `/api/logs` endpoint that reads entire files into memory, and the CORS error on settings save.

**Issues resolved:** #744 (Codex CLI), #838, #1049 (Cursor), #1203 (/api/logs OOM), #1029 (CORS), #1213 (session custom-title)

## Tasks

- [x] Fix Codex CLI compatibility (#744):
  - In `src/cli/handlers/session-init.ts`, verify the handler doesn't throw on undefined `prompt` (not just empty string)
  - Also check `session_id` format differences — Codex CLI may use a different format than Claude Code
  - **Done:** (1) `claudeCodeAdapter` now falls back through `session_id → id → sessionId` for session ID field. (2) `getPlatformAdapter` returns `rawAdapter` for unknown platforms instead of throwing (Codex, future CLIs). (3) `session-init` handler guards against undefined `sessionId` with graceful skip. (4) 10 new tests in `hook-lifecycle.test.ts` covering all cases. 1019 tests pass.

- [x] Fix Cursor IDE integration (#838, #1049):
  - Check `src/services/integrations/CursorHooksInstaller.ts` for Cursor-specific issues
  - The Cursor adapter likely sends a different payload format — find the input normalization in `src/cli/adapters/` and handle Cursor's format
  - Session-init returning HTTP 400 suggests a missing required field — make the handler tolerant of missing optional fields
  - **Done:** (1) `cursorAdapter` now tries `conversation_id → generation_id → id` for session ID and `prompt → query → input → message` for prompt field, plus `workspace_roots[0] → cwd → process.cwd()` for cwd. (2) `handleSessionInitByClaudeId` in SessionRoutes.ts now only requires `contentSessionId` — `project` defaults to `'unknown'` and `prompt` defaults to `'[media prompt]'` when missing. (3) 16 new tests in `hook-lifecycle.test.ts` covering all Cursor adapter field fallbacks, undefined/null input handling, and formatOutput. 1036 tests pass.

- [x] Fix `/api/logs` reading entire file into memory (#1203):
  - In `src/services/worker/http/routes/LogsRoutes.ts` (around line 52-53), the endpoint reads the entire log file synchronously
  - Replace with a reverse line reader: read from the end of the file to get the last N lines
  - Use `fs.createReadStream` with a byte range or a simple `readFileSync` + `split('\n').slice(-lines)` — the latter is still better than reading 100MB+ into a JSON response
  - **Done:** Replaced `readFileSync` (full-file load) with exported `readLastLines()` function that reads from the end of the file in expanding chunks (64KB initial → doubles as needed → 10MB cap). Returns only the last N lines without ever loading the whole file into memory. Added 12 unit tests covering empty files, trailing newline handling, files larger than initial chunk size, and zero-line requests. 1048 tests pass, 0 regressions.

- [x] Fix Settings CORS error (#1029):
  - Find CORS middleware in the server setup
  - Ensure `Access-Control-Allow-Methods` includes `PUT`, `PATCH`, `DELETE` (not just GET/POST)
  - Ensure `Access-Control-Allow-Headers` includes `Content-Type`
  - **Done:** Added explicit `methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']` and `allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']` to the CORS config in `src/services/worker/http/middleware.ts`. Added 6 new preflight CORS tests verifying PUT/PATCH/DELETE methods, Content-Type header, localhost allow-origin, and external origin rejection. 1054 tests pass, 0 regressions.

- [x] Add session custom-title for agent attribution (#1213):
  - Add optional `custom_title` column to sdk_sessions table (migration)
  - Accept `customTitle` in the `/api/sessions/init` endpoint and store it
  - This is a simple schema addition, not a new feature system
  - **Done:** (1) Migration 23 adds nullable `custom_title TEXT` column to `sdk_sessions` in both `MigrationRunner` and `SessionStore`. (2) `createSDKSession()` in both modular (`sessions/create.ts`) and class (`SessionStore`) forms now accepts optional `customTitle` parameter — stored on insert, backfilled on idempotent re-call only if not already set. (3) `/api/sessions/init` extracts `customTitle` from request body and passes through. (4) `getSessionById` and `getSdkSessionsBySessionIds` include `custom_title` in SELECT. (5) Types updated: `SessionBasic` and `SessionFull` include `custom_title: string | null`. (6) 5 new tests in `sessions.test.ts` covering creation with title, null default, backfill, no-overwrite, and empty string handling. 1059 tests pass, 0 regressions.

- [x] Run `npm test` and fix any failures
  - **Done:** Full test suite passes cleanly — 1059 pass, 3 skip, 0 fail across 58 test files (1950 expect() calls). No regressions from any of the TRIAGE-08 changes.
