# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [12.4.9] - 2026-04-30

Patches in 7 critical fixes from PR #2219 (integration/critical-fixes-april):

- #2211 build/bundle drift — remove stale macOS binary + regen artifacts (closes #2158, #2200, #2154)
- #2204 strip privacy tags before summarization (closes #2149)
- #2205 preserve relevance order in semantic search (closes #2153)
- #2208 restore Windows spawn (PR #751 re-apply) + Windows CI
- #2209 Codex transcript ingestion + queue self-deadlock on Windows (closes #2192)
- #2206 isolate SDK boundary — close 6 issues at 3 call sites
- #2210 standalone batch — npm peer deps, marketplace self-heal, cache prune

## [12.4.8] - 2026-04-28

## Bug Fixes

- **timeline tool:** Coerce stringified numeric anchors (e.g. `"123"`) into the observation-ID dispatch path so they no longer fall through to ISO-timestamp parsing and return wrong-epoch windows. The HTTP layer always sends anchor as a string, so this fixes anchor lookups via MCP and HTTP across the board. (#2176)

## Tests

- Added a 7-case regression suite covering JS-number anchors, stringified-number anchors (incl. whitespace-padded), session-ID anchors (`S<n>`), ISO-timestamp anchors, garbage anchors, and explicit numeric-not-found behavior. The suite runs against a real in-memory SQLite `SessionStore` to exercise the full dispatch path.

## Refactors

- Extracted `parseNumericAnchor` helper in `SearchManager` to centralize anchor coercion across timeline handlers.

## [12.4.7] - 2026-04-26

## Cynical deletion + review fixes

This release wraps up the cynical-deletion sweep (PR #2141) — closing 27 issues by removing two anti-patterns that were breeding bugs:

- **Defenders** (orphan cleanup, duplicate liveness probes, restart-port-steal logic) replaced with fail-fast or single-source paths.
- **Tolerators** (silent JSON drops, drifted SSE/SQL filters, passthrough Zod schemas) replaced with strict boundaries.

### Highlights
- Multi-account isolation via `CLAUDE_MEM_DATA_DIR` + per-UID worker port (`37700 + uid % 100`), with `CLAUDE_MEM_WORKER_PORT` override (#2101)
- New `CLAUDE_MEM_INTERNAL=1` trust boundary replaces cwd-based observer-session detection
- Shared `shouldEmitProjectRow` predicate keeps SSE broadcast and pagination filters in sync
- Pinned `chroma-mcp` to 0.2.6 for reproducible installs
- Install/uninstall: shared `shutdown-helper` releases file locks before overwrite/delete (#2106)
- Migration 30: `observations.metadata` column added (#2116)
- Proxy env vars stripped from spawned subprocesses to prevent user proxy config leaking into AI API calls

### Review-comment fixes (post-PR)
- `worker-service` restart now exits 1 with error if `spawnDaemon` fails (Greptile P1)
- `shutdown-helper` distinguishes `AbortError` (slow worker) from connection-refused (gone) (Greptile P2)
- `hooks.json` `$HOME` cache lookup quoted to support paths with spaces
- `timeline-report` SKILL works on Windows (no `process.getuid()` requirement)
- `opencode-plugin` validates `CLAUDE_MEM_WORKER_PORT` before use
- `uninstall` only strips alias lines, not function declarations
- `MemoryRoutes` trims whitespace-only `project` before precedence resolution
- Migration 21 preserves `metadata` column when rebuilding observations table

### Closes
#2087, #2089, #2094, #2099, #2101, #2103, #2106, #2116, #2139, #2140, and 17 more (see PR #2141).

## [12.4.5] - 2026-04-26

## Bug Fixes

- **Fix observation persistence on fresh installs (#2139)**: `SessionStore` was missing migration 28's column additions, so freshly created `pending_messages` tables had no `tool_use_id` or `worker_pid` columns. Every queue claim and observation insert failed silently with "no such column" errors and nothing reached memory. Added `addPendingMessagesToolUseIdAndWorkerPidColumns` mirror in `SessionStore.ts` (matches the existing `addObservationSubagentColumns` / `addObservationsUniqueContentHashIndex` mirror pattern). Already-broken DBs at "v29 with no v28 columns" self-heal on next worker boot via column-existence guards. Dedup DELETE + UNIQUE index creation are now wrapped in a transaction matching the v29 mirror precedent.

Thanks to @drdah123 for the precise diagnosis and reproduction in the issue report.

## [12.4.4] - 2026-04-26

## Bug fix: stop draining the observation queue on /clear

When users typed `/clear` in Claude Code (or logged out, exited, or hit `prompt_input_exit`), every still-pending observation in the worker queue was being marked `abandoned` and never processed. The same shim was wired across Claude Code, Gemini CLI, the transcripts processor, OpenCode plugin, and OpenClaw — five surfaces, all draining the queue on what should be benign session-end signals.

This release removes the `SessionEnd → session-complete` hook entirely. The worker self-completes via its SDK-agent generator's finally-block, so no external completion call is needed. Pending observations now finish processing naturally instead of being abandoned.

Explicit user-initiated session deletion (via the viewer UI's `DELETE /api/sessions/:id`) still drains the queue — that's the only path that should.

### What changed

- Removed `SessionEnd` hook block from `plugin/hooks/hooks.json`
- Removed `POST /api/sessions/complete` route + Zod schema in `SessionRoutes.ts`
- Deleted `src/cli/handlers/session-complete.ts` and its registry entry
- Removed the call from `src/services/transcripts/processor.ts`
- Removed the call from the OpenCode plugin's `session.deleted` handler
- Removed the Gemini CLI installer's `SessionEnd → session-complete` mapping
- Removed `scheduleSessionComplete`, `pendingCompletionTimers`, and `completionDelayMs` from OpenClaw

### Background

This bug had been quietly draining queues since **November 7, 2025** (~6 months). The wiring crept in as a "cleanup hook stops the spinner" side effect (#4416), got rationalized as canonical architecture (#6682, #14793), and survived multiple refactors that preserved it instead of questioning it. Full timeline in PR #2136.

## [12.4.3] - 2026-04-25

One-time pollution cleanup migration plus the v12.4.1 / v12.4.2 ship-blocker fixes folded into a single release.

## Headline

**One-shot DB cleanup migration** (`CleanupV12_4_3.ts`) — runs once per data directory at worker startup, marker-file gated, opt-out via `CLAUDE_MEM_SKIP_CLEANUP_V12_4_3=1`. Cleans:
- `observer-sessions` rows that polluted user-facing search/timeline before the observer-sessions filter shipped (cascades to `user_prompts`, `observations`, `session_summaries`).
- Stuck `pending_messages` chains (≥10 rows per session in `failed`/`processing`) left over from the pre-v12.4.2 context-overflow loop.
- `~/.claude-mem/chroma/` and `chroma-sync-state.json` so `backfillAllProjects` rebuilds vectors from the cleaned SQLite.

Backups before any delete: `VACUUM INTO` first, with a `copyFileSync` fallback that also mirrors `-wal` / `-shm` sidecars so a WAL-mode restore is complete. Pre-flight `statfsSync` disk check before backup. The marker is only written after SQLite purges succeed; Chroma-wipe failures record the error on the marker rather than re-running the backup on every boot.

- **Context-overflow loop fix** (`SDKAgent.ts`): both overflow detection paths (`'prompt is too long'` / `'Prompt is too long'`) now clear `memorySessionId` and force a fresh session via the new `resetSessionForFreshStart` helper before aborting/throwing. Stops the infinite retry seen in pre-v12.4.2 logs.
- **`<task-notification>` storage leak** (`tag-stripping.ts` + `session-init.ts` + `SessionRoutes.ts`): dual-layer filter at the hook and at the worker HTTP boundary. `isInternalProtocolPayload` uses a tempered greedy body with negative lookahead so adjacent and surrounded protocol tags can't span across user text. 256 KB size guard before the regex prevents ReDoS on malformed payloads.

## v12.4.1 trivial fixes

- `mcpServers: {}` on `SDKAgent` and `KnowledgeAgent` spawns prevents host MCP server inheritance.
- `McpIntegrations.ts`: `.agent` → `.agents` path correction.
- `hooks.json`: `file-context` timeout `2000` → `60` (was 33 minutes); explicit `shell: bash` on hooks that use bash-only syntax.

## Cleanup-migration counts (sample run)

11 sessions + 3 cascade rows + 141 pending_messages purged in 1.1s; 277 MB pre-cleanup backup written.

## Tests

New: `tests/infrastructure/cleanup-v12_4_3.test.ts` — real on-disk SQLite under a tmpdir, exercises the happy path, idempotency, opt-out env var, no-DB marker, threshold-boundary preservation. Writing these tests caught a real counting bug (bun:sqlite `result.changes` inflates with FTS triggers) and the regex false positive (greedy `[\s\S]*` spanning two protocol blocks).

## Notes

- The migration is intentionally NOT atomic across the two transactions: if `runStuckPendingPurge` fails after `runObserverSessionsPurge` commits, the observer rows stay deleted and the cleanup retries on next boot. Both purges are idempotent.
- A user low on disk at first post-upgrade boot will retry on the next boot with adequate space (the marker is not written on disk-skip).

## [12.4.2] - 2026-04-25

## Two ship-blockers from yesterday's triage + 5 trivial fixes

### Worker reliability
- **Context overflow no longer loops forever.** When the Claude SDK throws `Prompt is too long`, `SDKAgent` now clears `session.memorySessionId` and sets `session.forceInit = true` before throwing — so the immediately-following crash-recovery spawn starts a fresh SDK session instead of resuming the same overflowed context. In the wild this had stranded 68+ pending messages on a single poisoned session before the windowed RestartGuard finally abandoned the queue.
- **`<task-notification>` payloads no longer pollute `user_prompts`.** Claude Code's autonomous protocol blocks (emitted on background `Agent` completion) were being captured as if they were user prompts — 471 such rows in one local DB. New `isInternalProtocolPayload()` predicate in `src/utils/tag-stripping.ts` blocks them at both the hook layer (`session-init.ts`) and the worker boundary (`SessionRoutes.ts`). Conservative deny-list — does NOT touch `<command-name>` / `<command-message>` which wrap real user slash-commands.

### Triage cleanup (from yesterday's open-issue review)
- **#2092**: `worker-service.cjs` build banner now CJS-safe (no `import.meta.url`); `node -c` passes for the first time in several releases.
- **#2100**: PreToolUse Read hook timeout reduced from `2000` (s, plainly a typo) to `60`.
- **#2131**: `"shell": "bash"` added to every hook in `plugin/hooks/hooks.json` so Claude Code on Windows routes through Git Bash instead of cmd.exe.
- **#2132**: Antigravity context file path corrected from `.agent/rules` to `.agents/rules`.
- **#2088**: Worker SDK `query()` calls now pass `mcpServers: {}` to suppress inheritance of the user's global MCP servers (Serena, etc.) into observer/knowledge sessions.

### Notes
- Cleanup of polluted rows is included in the worker — fresh installs are clean. To clean an existing DB: `sqlite3 ~/.claude-mem/claude-mem.db "DELETE FROM user_prompts WHERE prompt_text LIKE '<task-notification>%';"` (the AFTER-DELETE trigger handles FTS).
- The 5 triage fixes were authored from a multi-agent review of 38 open issues against the v12.3.0–v12.4.1 cleanup arc.

## [12.4.1] - 2026-04-25

## perf(chroma): Cache backfill watermarks to skip per-restart Chroma scans

Worker restarts were re-scanning Chroma's full metadata for every project on every boot to determine which sqlite ids were already embedded. With ~253 projects and ~92k embeddings, this pegged `chroma-mcp` at 100–422% CPU on each spawn.

### What changed
- New `~/.claude-mem/chroma-sync-state.json` watermark cache — per-project highest synced sqlite_id for observations, summaries, and prompts.
- Backfill SQL changed from `id NOT IN (huge list)` to `id > watermark`.
- Live `syncObservation` / `syncSummary` / `syncUserPrompt` bump the watermark on success.
- One-time bootstrap derives initial watermarks from a single Chroma scan if the state file is missing — after that, Chroma metadata is never scanned again on startup.
- Watermark advances per batch, so partial-failure runs resume cleanly.

### Result
- Chroma CPU on worker restart: **422% → 0%**.
- State file size for 253 projects: **~3.7 KB**.
- Backfill startup time: **seconds → near-instant** after bootstrap.

## [12.3.9] - 2026-04-22

## Highlights

### 🔐 Security observation types + Telegram notifier
- New observation types: `security_alert` 🚨 (high-priority, triggers notifications) and `security_note` 🔐 (low-priority).
- Fire-and-forget Telegram notifier — MarkdownV2 formatting, per-observation error isolation, no token logging.
- Five env vars control behavior. `CLAUDE_MEM_TELEGRAM_ENABLED` master toggle defaults on (no-op without bot token + chat ID).

### ⚡ Stop hook: fire-and-forget summarize
- Eliminated the ~110s terminal block when a session ended. Summarize handler now enqueues and returns immediately.
- Server-side `SessionCompletionHandler` finalizes off the hook's critical path (generator + HTTP fallback), with singleton sharing across the worker.

### 🐛 Hooks: worker-port precedence + Windows (#2086 / PR #2084)
- Hooks now resolve endpoint with the same precedence as the worker: env (`CLAUDE_MEM_WORKER_PORT`, `CLAUDE_MEM_WORKER_HOST`) > settings.json > defaults.
- Looser sed regex handles both quoted and unquoted JSON port values.
- Windows fallback to 37777 when per-uid formula doesn't apply.

### 🔧 Bug fixes (reviewer rounds on PR #2084)
- Don't remove in-memory session after a failed finalize; preserve crash-recovery state at 3 sites.
- Eliminate double-broadcast of `session_completed` on fallback path.
- Sync `DatabaseManager.getSessionById` return type.
- `TelegramNotifier` now respects `settings.json` (not just env).
- Hardcoded 🚨 emoji replaced with per-type mapping.

### 📝 Docs
- `version-bump` skill now covers `npm publish` + all 6 manifest paths so `npx claude-mem@<version>` always resolves. Adds `git grep` pre-flight for new manifests.

### ⚙️ Chores
-

## [12.3.8] - 2026-04-21

## 🔧 Fix

**Detect PID reuse in the worker start-guard so containers can restart cleanly.** (#2082)

The `kill(pid, 0)` liveness check false-positived when the worker's PID file outlived its PID namespace — most commonly after `docker stop` / `docker start` with a bind-mounted `~/.claude-mem`. The new worker would boot as the same low PID (often 11) as the old one, `kill(0)` would report "alive," and the worker would refuse to start *against its own prior incarnation*. Symptom: container appeared to start, immediately exited cleanly with no user-visible error, worker never came up.

### What changed

- Capture an opaque **process-start identity token** alongside the PID and verify identity, not just liveness:
  - **Linux**: `/proc/<pid>/stat` field 22 (starttime in jiffies) — cheap, no exec, same signal `pgrep`/`systemd` use.
  - **macOS / POSIX**: `ps -p <pid> -o lstart=` with `LC_ALL=C` pinned so the emitted timestamp is locale-independent across environments.
  - **Windows**: unchanged — falls back to liveness-only. The PID-reuse scenario doesn't affect Windows deployments the way containers do.
- `verifyPidFileOwnership` emits a DEBUG log when liveness passes but the token mismatches, so the "PID reused" case is distinguishable from "process dead" in production logs.
- PID files written by older versions are token-less; `verifyPidFileOwnership` falls back to the existing liveness-only behavior for backwards compatibility. **No migration required.**

### Surface

Shared helpers (`PidInfo`, `captureProcessStartToken`, `verifyPidFileOwnership`) live in `src/supervisor/process-registry.ts` and are re-exported from `ProcessManager.ts` to preserve the existing public surface. Both entry points updated: `worker-service.ts` GUARD 1 and `supervisor/index.ts` `validateWorkerPidFile`.

### Tests

+14 new tests covering token capture, ownership verification, backwards compatibility for tokenless PID files, and the container-restart regression scenario. Zero regressions.

## [12.3.7] - 2026-04-20

## What's Changed

**Refactor: remove bearer auth and platform_source context filter** (#2081)

- Drop bearer-token auth from the worker API. Worker binds localhost-only and CORS restricts origins to localhost — the token added friction for every internal client (hooks, CLI, viewer, sync script) with no real security benefit for single-user local deployments.
- Drop the unused `platform_source` query-time filter from the `/api/context/inject` pipeline (ContextBuilder, ObservationCompiler, SearchRoutes, context handler, transcripts processor). The DB column stays — only the WHERE-clause filter and its plumbing are removed.
- Replace the removed auth with a simple in-memory rate limiter (300 req/min) as a lightweight compensating control. Limiter normalises IPv4-mapped IPv6, emits `Retry-After` on 429, and has a size-guarded prune that never runs on localhost.

## Cleanup

- Deleted `src/shared/auth-token.ts` and all its dependents (`worker-utils.ts` Authorization header, `ViewerRoutes.ts` token injection, CORS `allowedHeaders: ['Authorization']`, `sync-marketplace.cjs` admin restart header).
- Stopped tracking `.docker-blowout-data/claude-mem.db` and added the directory to `.gitignore`.

## Full Changelog
https://github.com/thedotmack/claude-mem/compare/v12.3.6...v12.3.7

## [12.3.6] - 2026-04-20

## Viewer fix: drop the rate limiter

v12.3.5 kept the 300 req/min rate limiter from v12.3.3's "security hardening" bundle. That tripped the live viewer within seconds (it polls logs and stats) and served it "Rate limit exceeded" errors.

**Fix**: remove the rate limiter entirely. The worker is localhost-only (enforced via CORS), so there's no abuse surface to protect. Rate-limiting a single-user local process is security theater.

### Still kept from v12.3.3 hardening
- 5 MB JSON body limit
- Path traversal protection
- Localhost-only CORS
- Everything else from v12.3.5

No upgrade action required.

## [12.3.5] - 2026-04-20

## Restored v12.3.3 fixes minus bearer auth

v12.3.3 shipped 25 bug fixes under "Issue Blowout 2026" but also introduced bearer-token auth that broke SessionStart context injection for everyone. v12.3.4 rolled everything back to v12.3.2 to unblock users.

**v12.3.5 restores all 25 fixes**, with the bearer-auth mechanism surgically removed.

### Kept hardening from v12.3.3
- 5 MB JSON body limit
- In-memory rate limiter (300 req/min/IP)
- Path traversal protection on `watch.context.path`
- `RestartGuard` (time-windowed restart counter)
- Idle session eviction on pool slot allocation
- WAL checkpoint + `journal_size_limit`
- Periodic `clearFailed()` for pending_messages
- FTS5 keyword-search fallback when ChromaDB is unavailable
- `ResponseProcessor` marks non-XML responses as failed (with retry) instead of confirming
- `/health` reports `activeSessions`
- Summarize hook wraps `workerHttpRequest` in try/catch (no more blocking exit code 2)
- UserPromptSubmit session-init waits for worker health on Linux/WSL
- MCP loopback self-check uses `process.execPath` instead of bare `node`
- Nounset-safe `TTY_ARGS` in `docker/claude-mem/run.sh`

### Removed from v12.3.3
- `src/shared/auth-token.ts` (deleted)
- `requireAuth` middleware and its wiring in `Server.ts`/`Middleware.ts`
- `Authorization: Bearer` injection in `worker-utils.ts` (hook client), `ViewerRoutes.ts` (browser token injection), viewer `authFetch`, and the OpenCode plugin

### Upgrade notes
- `~/.claude-mem/worker-auth-token` from a previous 12.3.3 install is harmless and can be deleted.
- If your Claude Code session kept the 12.3.3 daemon alive, restart Claude Code once so the fresh 12.3.5 daemon takes over.

## [12.3.4] - 2026-04-20

## Rollback of v12.3.3

v12.3.3 (Issue Blowout 2026, PR #2080) broke SessionStart context injection — new sessions received no memory context from claude-mem. This release reverts to the v12.3.2 tree state while the regression is investigated.

### Reverted
- #2080 — Issue Blowout 2026 (25 bugs across worker, hooks, security, and search)

### Notes
No functional changes from v12.3.2. A follow-up release will re-land the v12.3.3 fixes individually once the context regression is identified and resolved.

## [12.3.3] - 2026-04-20

## Issue Blowout 2026 — 25 bugs across worker, hooks, security, and search

### Security Hardening
- Bearer token authentication for all worker API endpoints with auto-generated tokens
- Path traversal protection on context write paths
- Per-user worker port derivation (37700 + uid%100) to prevent cross-user data leakage
- Rate limiting (300 req/min/IP) and reduced JSON body limit (50MB → 5MB)
- Caller headers can no longer override the bearer auth token

### Worker Stability
- Time-windowed RestartGuard replaces flat counter — prevents stranding pending messages on long sessions
- Idle session eviction prevents pool slot deadlock when all slots are full
- MCP loopback self-check uses process.execPath instead of bare 'node'
- Age-scoped failed message purge (1h retention) instead of clearing all
- RestartGuard decay anchored to real successes, not object creation time

### Search & Chroma
- FTS5 keyword fallback when ChromaDB is unavailable for all search handlers
- doc_type:'observation' filter on Chroma queries feeding observation hydration
- Project filtering passed to Chroma queries and SQLite hydration in all endpoints
- Bounded post-import Chroma sync with concurrency limit of 8
- FTS5 MATCH input escaped as quoted literal phrases to prevent syntax errors
- LIKE metacharacters escaped in prompt text search
- date_desc ordering respected in FTS session search

### Hooks Reliability
- Summarize hook wrapped in try/catch to prevent exit code 2 on network failures
- Session-init gated on health check success — no longer runs when worker unreachable
- Health-check wait loop added to UserPromptSubmit for Linux/WSL startup race

### Database & Performance
- Periodic WAL checkpoint and journal_size_limit to prevent unbounded WAL growth
- FTS5 availability cached at construction time (no DDL probe per query)
- _fts5Available downgraded when FTS table creation fails

### Viewer UI
- response.ok check added to settings save and initial load flows
- Auth failure handling in saveSettings

## [12.3.2] - 2026-04-20

## Bug Fixes

- **Search**: Fix `concept`/`concepts` parameter mismatch in `/api/search/by-concept` (#1916)
- **Search**: Add FTS5 keyword fallback when ChromaDB is unavailable (#1913, #2048)
- **Database**: Add periodic `clearFailed()` to purge stale pending messages (#1957)
- **Database**: Add WAL checkpoint schedule and `journal_size_limit` to prevent unbounded growth (#1956)
- **Worker**: Mark messages as failed (with retry) instead of confirming on non-XML responses (#1874)
- **Worker**: Include `activeSessions` in `/health` endpoint for queue liveness monitoring (#1867)
- **Docker**: Fix nounset-safe `TTY_ARGS` expansion in `run.sh`
- **Search**: Cache `isFts5Available()` at construction time (Greptile review)

## Closed Issues

#1908, #1953, #1916, #1913, #2048, #1957, #1956, #1874, #1867

## [12.3.1] - 2026-04-20

## Error Handling & Code Quality

This patch release resolves error handling anti-patterns across the entire codebase (91 files), improving resilience and correctness.

### Bug Fixes

- **OpenRouterAgent**: Restored assistant replies to `conversationHistory` — multi-turn context was lost after method extraction (#2078)
- **ChromaSync**: Fixed cross-type dedup collision where `observation#N`, `session_summary#N`, and `user_prompt#N` could silently drop results
- **Timeline queries**: Fixed logger calls wrapping Error inside an object instead of passing directly
- **FTS migrations**: Preserved non-Error failure details instead of silently dropping them

### Error Handling Improvements

- Replaced 301 error handling anti-patterns across 91 files:
  - Narrowed overly broad try-catch blocks into focused error boundaries
  - Replaced unsafe `error as Error` casts with `instanceof` checks
  - Added structured error logging where catches were previously empty
  - Extracted large try blocks into dedicated helper methods
- **Installer resilience**: Moved filesystem operations (`mkdirSync`) inside try/catch in Cursor, Gemini CLI, Goose MCP, and OpenClaw installers to maintain numeric return-code contracts
- **GeminiCliHooksInstaller**: Install/uninstall paths now catch `readGeminiSettings()` failures instead of throwing past the `0/1` return contract
- **OpenClawInstaller**: Malformed `openclaw.json` now throws instead of silently returning `{}` and potentially wiping user config
- **WindsurfHooksInstaller**: Added null-safe parsing of `hooks.json` with optional chaining
- **McpIntegrations**: Goose YAML updater now throws when claude-mem markers exist but regex replacement fails
- **EnvManager**: Directory setup and existing-file reads are now wrapped in structured error logging
- **WorktreeAdoption**: `adoptedSqliteIds` mutation delayed until SQL update succeeds
- **Import script**: Guard against malformed timestamps before `toISOString()`
- **Runtime CLI**: Guard `response.json()` parsing with controlled error output

### Documentation

- Added README for Docker claude-mem harness

## [12.3.0] - 2026-04-20

## New features

### Basic claude-mem Docker container (`docker/claude-mem/`)
A ready-to-run container for ad-hoc claude-mem testing with zero local setup beyond Docker.

- `FROM node:20`; layers pinned Bun (1.3.12) + uv (0.11.7) + the built plugin
- Non-root `node` user so `--permission-mode bypassPermissions` works headlessly
- `build.sh`, `run.sh` (auto-extracts OAuth from macOS Keychain or `~/.claude/.credentials.json`, falls back to `ANTHROPIC_API_KEY`), `entrypoint.sh`
- Persistent `.claude-mem/` mount so the observations DB survives container exit

Validated end-to-end: `PostToolUse` hook → queue → worker SDK call under subscription OAuth → `<observation>` XML → `observations` table → Chroma sync.

### SWE-bench evaluation harness (`evals/swebench/`)
Two-container split (our agent image + the upstream SWE-bench harness) for measuring claude-mem's effect on resolve rate.

- `Dockerfile.agent` → `claude-mem/swebench-agent:latest` (same non-root, version-pinned approach)
- `run-instance.sh` — two-turn ingest/fix protocol per instance; shallow clone at `base_commit` with full-clone fallback
- `run-batch.py` — parallel orchestrator with OAuth extraction, per-container naming, timeout enforcement + force-cleanup, `--overwrite` guard against silent truncation of partial results
- `eval.sh` — wraps `python -m swebench.harness.run_evaluation`
- `summarize.py` — aggregates per-instance reports
- `smoke-test.sh` — one-instance smoke test

### Fixes / hardening (from PR review)
- `chmod 600` on extracted OAuth creds files
- Grouped `{ chmod || true; }` so bash precedence can't mask failed `curl|sh` installs
- macOS creds: Keychain-first with file fallback for migrated / older setups
- `smoke-test.sh` `TIMEOUT` now actually enforced via `timeout`/`gtimeout` plus `docker rm -f` on exit 124
- Container naming + force-cleanup in `run-batch.py` timeout handler prevents orphan containers
- Fixed stdin-redirection collision in the consolidated `smoke-test.sh` JSON parser
- Drop `exec` in `run.sh` so the EXIT trap fires and cleans the temp creds file

**PR:** https://github.com/thedotmack/claude-mem/pull/2076

## [12.2.3] - 2026-04-19

## Fixed

- **Parser: stop warning on normal observation responses (#2074).** Eliminated the `PARSER Summary response contained <observation> tags instead of <summary> — prompt conditioning may need strengthening` warning that fired on every normal observation turn. The warning was inherited from #1345 when `parseSummary` was only called after summary prompts; after #1633's refactor it runs on every response, so the observation-only fallthrough always tripped. Gated the entire observation-on-summary path on `coerceFromObservation` so only genuine summary-turn coercion failures log.

**Full diff:** https://github.com/thedotmack/claude-mem/compare/v12.2.2...v12.2.3

## [12.2.2] - 2026-04-19

## Subagent summary disable + labeling

Claude Code subagents (the Task tool and built-in agents like Explore/Plan/Bash) no longer trigger a session summary on Stop, and every observation row now carries the originating subagent's identity.

### Features

- **Subagent Stop hooks skip summarization.** When a hook fires inside a subagent (identified by `agent_id` on stdin), the handler short-circuits before bootstrapping the worker. Only the main assistant owns the session summary. Sessions started with `--agent` (which set `agent_type` but not `agent_id`) still own their summary.
- **Observations are labeled by subagent.** The `observations` table gains two new nullable columns — `agent_type` and `agent_id` — populated end-to-end from the hook stdin through the pending queue into storage. Main-session rows remain `NULL`. Labels survive worker restarts via matching columns on `pending_messages`.

### Safety

- Defense-in-depth guard on the worker `/api/sessions/summarize` route so direct API callers can't bypass the hook-layer short-circuit.
- `pickAgentField` type guard at the adapter edge validates the hook input: must be a non-empty string ≤128 characters, otherwise dropped.
- Content-hash dedup intentionally excludes `agent_type`/`agent_id` so the same semantic observation from a subagent and its parent merges to a single row.

### Schema

- Migration 010 (version 27) adds the two columns to `observations` and `pending_messages`, plus indexes on `observations.agent_type` and `observations.agent_id`. Idempotent, state-aware logging.

### Tests

- 17 new unit tests: adapter extraction (length cap boundary, empty-string rejection, type guards), handler short-circuit behavior, DB-level labeling and dedup invariants.

PR: #2073

## [12.2.1] - 2026-04-19

## What's Fixed

### Break infinite summary-retry loop (#1633)

When the summary agent returned `<observation>` tags instead of `<summary>` tags, the parser rejected the response, no summary was stored, the session completed without a summary, and a new session was spawned with ~5–6 KB of extra prompt context — repeating indefinitely.

**Three layers of defense (PR #2072):**

- **Parser coercion** — when a summary is expected, observation fields are mapped to summary fields (title → request/completed, narrative → investigated, facts → learned) instead of discarding the response.
- **Stronger prompt** — summary prompts now include an explicit tag-requirement block and a closing reminder so the LLM is much less likely to emit observation tags in the first place.
- **Circuit breaker** — per-session counter caps consecutive summary failures at 3; further summarize requests are skipped until a success resets it. Explicit `<skip_summary/>` responses are treated as neutral, not failures.

**Edge cases handled:**

- Empty leading `<observation>` blocks fall through to the first populated one.
- Empty `<summary></summary>` wrappers fall back to observation coercion.
- Multiple observation blocks are iterated via a global regex.

Full details: #2072

## [12.2.0] - 2026-04-18

## Highlights

**Worktree Adoption** — When a git worktree is merged back into its parent branch, its observations are now consolidated into the parent project's view, so memory follows the code after a merge.

## Features

- **Worktree adoption engine** — consolidates merged-worktree observations under the parent project (#2052)
- **`npx claude-mem adopt`** — new CLI command with `--dry-run` and `--branch X` flags for manual adoption
- **Auto-adoption on worker startup** — merged worktrees are adopted automatically when the worker service starts
- **CWD-based project remap** — project identity derived from `pending_messages.cwd`, applied on worker startup
- **Parent + worktree read scope** — worktree sessions now include parent repo observations in their read scope
- **Composite project names** — parent/worktree naming prevents observations from crossing worktrees
- **Merged-into-parent badge** — UI now flags observations that have been adopted from a merged worktree
- **Observer-sessions project hidden** — internal bookkeeping project no longer appears in UI lists

## Fixes

- Drop orphan flag when filtering empty-string spawn args (#2049)
- Self-heal Chroma metadata on re-run
- Schema guard, startup adoption path, and query parity hardening
- Git operation timeouts + dry-run sentinel fixes
- Context derivation uses explicit `projects` array rather than cwd

## Chores

- Removed auto-generated per-directory `CLAUDE.md` files across the tree

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v12.1.6...v12.2.0

## [12.1.6] - 2026-04-16

## Fix

**Critical regression fix (#2049): observations no longer save on Claude Code 2.1.109+**

Resolves 100% observation/summary failure on Claude Code 2.1.109+ caused by a latent bug in how the bundled Agent SDK emits the `--setting-sources` flag.

### Root cause

The Agent SDK emits `["--setting-sources", ""]` whenever `settingSources` defaults to `[]`. Our existing Bun-compat filter stripped the empty string but left an orphan `--setting-sources` flag, which then consumed the following `--permission-mode` as its value. Claude Code 2.1.109+ rejects this with:

```
Error processing --setting-sources:
  Invalid setting source: --permission-mode.
```

Every observation SDK spawn crashed with exit code 1 before any data could be written.

### Fix

`ProcessRegistry.createPidCapturingSpawn` now uses a pair-aware filter: when an empty-string arg follows a `--flag`, both are dropped together. The SDK default (no setting sources) is preserved by omission.

### Credits

Thanks to @GigiTiti-Kai for the detailed root-cause report in #2049.

## [12.1.5] - 2026-04-15

Users on v12.1.3 experience 100% observation failure due to empty-string arg filtering corrupting `--setting-sources` on Claude Code 2.1.109+. The fix already landed in v12.1.4 (commit 3d92684 — `fix: filter empty string args before Bun spawn()`). This release forces the update to propagate across npm and the marketplace so every user gets the fix.

## Backlog cleanup
Also shipped earlier today: the April 2026 backlog consolidation merged 93 PRs and 147 issues into 138 clean tracking issues (95 bugs, 43 feature requests).

## Upgrade
```bash
npm install -g claude-mem@12.1.5
```

## [12.1.4] - 2026-04-15

## Bug Fixes

- **Revert unauthorized $CMEM branding**: A prior Claude instance inserted `$CMEM` token branding into the context injection header during a compression refactor. Reverted back to the original descriptive format: `# [project] recent context, datetime`

## [12.1.3] - 2026-04-15

## What's Changed

### Reverted
- **Remove overengineered summary salvage logic** (#1850) — Reverts PR #1718 which fabricated synthetic summaries from observation data when the AI returned `<observation>` instead of `<summary>` tags. Missing a summary is preferable to creating a fake one with poorly-mapped fields.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v12.1.2...v12.1.3

## [12.1.2] - 2026-04-15

## Community PRs merged (15)

**Runtime & reliability**
- #1698 Reap stuck generators in reapStaleSessions (@ousamabenyounes)
- #1697 Circuit breaker on OpenClaw worker client (@ousamabenyounes)
- #1696 Resolve Setup hook reference, warn on macOS-only binary (@ousamabenyounes)
- #1693 Session lifecycle guards to prevent runaway API spend (@ousamabenyounes)
- #1692 Resolve Gemini CLI 0.37.0 session capture failures (@ousamabenyounes)

**Cross-platform & hooks**
- #1833 Replace hardcoded nvm/homebrew PATH with login-shell resolution (@masak1yu)
- #1781 Filter empty-string args before Bun spawn() (@biswanath-cmd)
- #1780 Fix npx search, default Codex context to workspace-local AGENTS (@enma998)

**Data integrity**
- #1820 Use parent project name for worktree observation writes (@0xLeathery)
- #1771 Exclude primary-key index from unique-constraint check in migration 7 (@derjochenmeyer)
- #1770 Restrict ~/.claude-mem/.env permissions to 0600 (@derjochenmeyer)
- #1729 Preserve targeted file reads and invalidate on mtime (@quangtran88)
- #1776 Coerce corpus route filters (@suyua9)

**Docs**
- #1777 Document CLAUDE_MEM_MODE (@AviArora02-commits)
- #1765 Update opencode install instructions (@s-uryansh)

## Held for rebase
- #1748, #1694, #1695 — developed conflicts during batch merge

## Test baseline
1429 pass / 11 fail (improved from 18 fail at v12.1.1)

## [12.1.1] - 2026-04-15

14 community PRs merged + 1 post-merge bug fix. This patch addresses the most impactful bugs across summary persistence, MCP compliance, cross-platform compatibility, and data integrity.

### Highlights

**Summary pipeline fix** — When the LLM returns `<observation>` tags instead of `<summary>` tags (~72% of the time on v12.0.x), data is now salvaged into a synthetic summary instead of being silently discarded. (#1718)

**MCP compliance** — `list_corpora` now returns proper `CallToolResult` objects instead of bare arrays that crashed MCP clients. Search and timeline tools now declare `inputSchema.properties`. (#1701, #1555)

**Data integrity** — Ghost observations with no content fields are now filtered before storage. Search queries are now scoped to the current project via `WHERE project = ?`. (#1676, #1688... wait, #1688 wasn't in this batch)

### Bug Fixes

- **fix(ResponseProcessor):** salvage synthetic summary when AI returns `<observation>` instead of `<summary>` (#1718)
- **fix(ResponseProcessor):** broadcast uses `summaryForStore` to support salvaged summaries (post-merge fix for #1718)
- **fix(hooks):** soft-fail SessionStart health check on cold start (#1725)
- **fix(deps):** upgrade glob ^11.0.3 → ^13.0.0 for CVE fix (#1724, #1717)
- **fix(MCP):** wrap `list_corpora` response in CallToolResult shape (#1701, #1700)
- **fix(MCP):** declare inputSchema properties for search and timeline tools (#1555, #1384, #1413)
- **fix(config):** use bun to run mcp-server.cjs instead of node shebang (#1658, #1648)
- **fix(parser):** filter ghost observations with no content fields (#1676, #1625)
- **fix(chroma):** set cwd to homedir when spawning chroma-mcp to prevent .env.local crash (#1679, #1297)
- **fix(Windows):** avoid DEP0190 deprecation by using single-string spawnSync (#1677, #1503)
- **fix(worker):** suppress false ERROR when duplicate daemon loses port bind race (#1680, #1447)
- **fix(session):** expose `summaryStored` in session status for silent summary loss detection (#1686, #1633)
- **fix(cross-platform):** add .gitattributes to enforce LF endings on plugin scripts (#1678, #1342)
- **fix(tests):** remove leaky mock.module() that polluted parallel workers (#1666, #1299)

### Docs

- Add Language Support section to smart-explore/SKILL.md (#1670, #1651)
- Remove misplaced tree-sitter docs from mem-search/SKILL.md

### Contributors

@ousamabenyounes (10 PRs), @aaronwong1989, @kbroughton, @joao-oliveira-softtor, @octo-patch, @ck0park

## [12.1.0] - 2026-04-09

## Knowledge Agents

Build queryable AI "brains" from your claude-mem observation history. Compile a filtered slice of your past work into a corpus, prime it into a Claude session, and ask questions conversationally — getting synthesized, grounded answers instead of raw search results.

### New Features

- **Knowledge Agent system** — full lifecycle: build, prime, query, reprime, rebuild, delete
- **6 new MCP tools**: `build_corpus`, `list_corpora`, `prime_corpus`, `query_corpus`, `rebuild_corpus`, `reprime_corpus`
- **8 new HTTP API endpoints** on the worker service (`/api/corpus/*`)
- **CorpusBuilder** — searches observations, hydrates full records, calculates stats, persists to `~/.claude-mem/corpora/`
- **CorpusRenderer** — renders observations into full-detail prompt text for the 1M token context window
- **KnowledgeAgent** — manages Agent SDK sessions with session resume for multi-turn Q&A
- **Auto-reprime** — expired sessions are automatically reprimed and retried (only for session errors, not all failures)
- **Knowledge agent skill** (`/knowledge-agent`) for guided corpus creation

### Security & Robustness

- Path traversal prevention in CorpusStore (alphanumeric name validation + resolved path check)
- System prompt hardened against instruction injection from untrusted corpus content
- Runtime name validation on all MCP corpus tool handlers
- Question field validated as non-empty string
- Session state only persisted after successful prime (not null on failure)
- Refreshed session_id persisted after query execution
- E2e curl wrappers hardened with connect-timeout and transport failure fallback

### Documentation

- New docs page: Knowledge Agents usage guide with Quick Start, architecture diagram, filter reference, and API reference
- Knowledge agent skill page with workflow examples
- Added to docs navigation

### Testing

- Comprehensive e2e test suite (31 tests) covering full corpus lifecycle

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v12.0.1...v12.1.0

## [12.0.1] - 2026-04-08

## 🔴 Hotfix: MCP server crashed with `Cannot find module 'bun:sqlite'` under Node

v12.0.0 shipped a broken MCP server bundle that crashed on the very first `require()` call because a transitive import pulled `bun:sqlite` (a Bun-only module) into a bundle that runs under Node. Every MCP-only client (Codex and any flow that boots the MCP tool surface) was completely broken on v12.0.0.

### Root cause

`src/servers/mcp-server.ts` imported `ensureWorkerStarted` from `worker-service.ts`, which transitively pulled in `DatabaseManager` → `bun:sqlite`. The bundle ballooned from ~358KB (v11.0.1) to ~1.96MB (v12.0.0) and `node mcp-server.cjs` immediately threw `Error: Cannot find module 'bun:sqlite'`.

### Fix

- **Extracted** `ensureWorkerStarted` and Windows spawn-cooldown helpers into a new lightweight `src/services/worker-spawner.ts` module that has zero database/SQLite/ChromaDB imports
- **Wired** `mcp-server.ts` and `worker-service.ts` through the new module via a thin back-compat wrapper
- **Fixed** `resolveWorkerRuntimePath()` to find Bun on every platform (not just Windows) so the MCP server running under Node can correctly spawn the worker daemon under Bun
- **Added** two build-time guardrails in `scripts/build-hooks.js`:
  - Regex check: fails the build if `mcp-server.cjs` ever contains a `require("bun:*")` call
  - Bundle size budget: fails the build if `mcp-server.cjs` exceeds 600KB
- **Improved** error messages when Bun cannot be located (now names the install URL and explains *why* Bun is required)
- **Validated** `workerScriptPath` at the spawner entry point with empty-string and existsSync guards
- **Memoized** `resolveWorkerRuntimePath()` to skip repeated PATH lookups during crash loops, while never caching the not-found result so a long-running MCP server can recover if Bun is installed mid-session

### Verification

- `node mcp-server.cjs` exits cleanly under Node
- JSON-RPC `initialize` + `tools/list` + `tools/call search` all succeed end-to-end
- Bundle is back to ~384KB with zero `require("bun:sqlite")` calls
- 47 unit tests pass (44 ProcessManager + 3 worker-spawner)
- Both build guardrails verified to trip on simulated regressions
- Smoke test: MCP server serves the full 7-tool surface

### What this means for users

- **MCP-only clients (Codex, etc.):** v12.0.0 was broken; v12.0.1 restores full functionality
- **Claude Code users:** worker startup via the SessionStart hook continued working under Bun on v12.0.0, but the MCP tool surface (`mem-search`, `timeline`, `get_observations`, `smart_*`) was unreliable. v12.0.1 fixes that completely.
- **Plugin developers:** new build-time guardrails prevent this regression class from shipping again

PR: #1645
Merge commit: `abd55977`

## [12.0.0] - 2026-04-07

# claude-mem v12.0.0

A major release delivering intelligent file-read gating, expanded language support for smart-explore, platform source isolation, and 40+ bug fixes across Windows, Linux, and macOS.

## Highlights

### File-Read Decision Gate
Claude Code now intelligently gates redundant file reads. When a file has prior observations in the timeline, the PreToolUse hook injects the observation history and blocks the read — saving tokens and keeping context focused. The gate supports both `Read` and `Edit` tools, uses `permissionDecision` deny with a rich timeline payload, and includes file-size thresholds and observation deduplication.

### Smart-Explore: 24 Language Support
The `smart-explore` skill now supports **24 programming languages** via tree-sitter AST parsing: TypeScript, JavaScript, Python, Rust, Go, Java, C, C++, C#, Ruby, PHP, Swift, Kotlin, Scala, Bash, CSS, SCSS, HTML, Lua, Haskell, Elixir, Zig, TOML, and YAML. User-installable grammars with `--legacy-peer-deps` support for tree-sitter version conflicts.

### Platform Source Isolation
Claude and Codex sessions are now fully isolated with `platform_source` column on `sdk_sessions`. Each platform gets its own session namespace, preventing cross-contamination between different AI coding tools. Normalized at route boundaries for consistent behavior.

### Codex & OpenClaw Support
- Codex plugin manifest added for marketplace discoverability
- OpenClaw: `workerHost` config for Docker deployments
- OpenClaw: handle stale `plugins.allow` and non-interactive TTY in installer

## New Features

- **File-read decision gate** — blocks redundant file reads with observation timeline injection (#1564, #1629, #1641)
- **24-language smart-explore** — AST-based code exploration across all major languages
- **Platform source isolation** — Claude/Codex session namespacing with DB migration
- **CLAUDE.local.md support** — `CLAUDE_MEM_FOLDER_USE_LOCAL_MD` setting for writing to local-only config
- **OpenClaw workerHost** — Docker deployment support for OpenClaw plugin
- **Codex plugin manifest** — discoverability in Codex marketplace
- **File-size threshold** — skip file-read gating for small files
- **Observation deduplication** — prevent duplicate observations in timeline gate

## Bug Fixes

### Worker & Startup
- Fix worker startup crash with missing observation columns (#1641)
- Fix SessionStart hooks failing on cold start due to worker race condition
- Fix worker daemon being killed by its own hooks (#1490)
- Fail worker-start hook if worker never becomes healthy
- Fix readiness timeout logging on reused-worker path (#1491)
- Remove dead `USER_MESSAGE_ONLY` exit code that caused SessionStart hook errors
- Decouple MCP health from loopback self-check

### Data Integrity
- Fix migration version conflict: `addSessionPlatformSourceColumn` now correctly uses v25
- Add migration for `generated_by_model` and `relevance_count` columns
- Wire `generated_by_model` into observation write path
- Use null-byte delimiter in observation content hash to prevent collisions
- Persist session completion to database in `completeByDbId` (#1532)
- Handle bare path strings in `files_modified`/`files_read` columns (#1359)
- Guard `json_each()` calls against legacy bare-path rows
- Deduplicate session init to prevent multiple prompt records

### Security
- Prevent shell injection in summary workflow (#1285)
- Sanitize observation titles in file-context deny reason (strip newlines, collapse whitespace)
- Normalize `platformSource` at route boundary to prevent filter inconsistencies
- Escape `filePath` in recovery hints to prevent malformed output
- Address path safety, SQL injection, and gate scoping in file-read hook

### Windows
- Fix `isMainModule` CJS branch failure on Bun — add `CLAUDE_MEM_MANAGED` fallback
- Use `cmd /c` to execute `bun.cmd` on Windows
- Prefer `bun.cmd` over bun shell script on Windows
- Add `shell: true` on Windows to spawn bun from npm

### Cross-Platform
- Replace GNU `sort -V` with POSIX-portable version sort
- Resolve `node not found` on nvm/homebrew installations
- Resolve hook failures when `CLAUDE_PLUGIN_ROOT` is not injected (#1533)
- Fix bun-runner signal exit handling — scope to `start` subcommand only
- Guard `/stream` SSE endpoint with 503 before DB initialization
- Provide empty JSON fallback when stdin is not piped (#1560)

### Parser & Content
- Strip `<persisted-output>` tags from memory
- Strip `<system-reminder>` tags from persisted memory and DRY up regex
- Skip `parseSummary` false positives with no sub-tags (#1360)
- Handle bare filenames in `regenerate-claude-md.ts` (#1514)
- Handle bare filenames in `path-utils.ts isDirectChild`
- Handle single-quoted paths and dangling var edge case
- Strip hardcoded `__dirname`/`__filename` from bundled CJS output
- Add PHP grammar support to smart-file-read parser (#1617)

### Installer & Config
- Make post-install allowlist write guaranteed
- Harden plugin manifest sync script
- Fix `expand ~` to home directory before project resolution
- Update default model from `claude-sonnet-4-5` to `claude-sonnet-4-6` (#1390)
- Fix Gemini conversation history truncation to prevent O(N²) token cost growth

## Refactoring

- Rename formatters to `AgentFormatter`/`HumanFormatter` for semantic clarity

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v11.0.1...v12.0.0

## [11.0.1] - 2026-04-06

**Patch release** — Changes `CLAUDE_MEM_SEMANTIC_INJECT` default from `true` to `false`.

### What changed
- Per-prompt Chroma vector search on `UserPromptSubmit` is now **opt-in** rather than opt-out
- Reduces latency and context noise for users who haven't explicitly enabled it
- Users can re-enable via `CLAUDE_MEM_SEMANTIC_INJECT=true` in `~/.claude-mem/settings.json`

### Why
The semantic inject fires on every prompt and often surfaces tangentially related observations. A more precise file-context approach (PreToolUse timeline gate) is in development as a replacement.

## [11.0.0] - 2026-04-05

## claude-mem v11.0.0

**4 releases today** · 21 commits · 6,051 insertions · 34 files changed

### Features

#### Semantic Context Injection (#1568)
Every `UserPromptSubmit` now queries ChromaDB for the top-N most relevant past observations and injects them as context. Replaces recency-based "last N observations" with relevance-based semantic search. Survives `/clear`, skips trivial prompts (<20 chars), and degrades gracefully when Chroma is unavailable.

#### Tier Routing by Queue Complexity
The SDK agent now inspects pending queue complexity before selecting a model. Simple tool-only queues (Read, Glob, Grep) route to Haiku; mixed/complex queues use the default model. Production result: **~52% cost reduction** on SDK agent usage with quality indistinguishable from Sonnet. Includes a new `observation_feedback` table for future Thompson Sampling optimization.

#### Multi-Machine Observation Sync (#1570)
New `claude-mem-sync` CLI with `push`, `pull`, `sync`, and `status` commands. Bidirectional sync of observations and session summaries between machines via SSH/SCP with deduplication by `(created_at, title)`. Tested syncing 3,400+ observations between two physical servers — a session on the remote machine used transferred memory to deliver a real feature PR.

#### Orphaned Message Drain (#1567)
When `deleteSession()` aborts the SDK agent via SIGTERM, pending messages are now marked abandoned instead of remaining in `pending` status forever. Production evidence: 15 orphaned messages found before fix → 0 orphaned messages over 23 days after fix.

### Bug Fixes

#### Installer Regression Fixed (v10.7.0 → v10.7.1)
The install simplification in v10.7.0 over-applied scope — it replaced the entire `runInstallCommand` with just two `claude` CLI commands, gutting the interactive IDE multi-select, `--ide` flag, and all 13 IDE-specific setup dispatchers. v10.7.1 restores the full installer for all non-Claude-Code IDEs while keeping the native plugin delegation for Claude Code.

#### 3 Upstream Production Bugs (#1566)
Found via analysis of 543K log lines over 17 days across two servers:
- **summarize.ts**: Skip summary when transcript has no assistant message (was causing ~30 errors/day)
- **ChromaSync.ts**: Fallback to `chroma_update_documents` when add fails with "IDs already exist"
- **HealthMonitor.ts**: Replace HTTP-based port check with atomic socket bind (eliminates TOCTOU race on simultaneous session starts)

#### Other Fixes
- Concept-type cleanup log downgraded from error to debug (reduces log noise)

### Breaking Change

**Strict Observer Response Contract** — The memory agent can no longer return prose-style skip responses like "Skipping — no substantive tool executions." `buildObservationPrompt` now requires `<observation>` XML blocks or an empty response. `ResponseProcessor` warns when non-XML content is received. This prevents silent data loss from the observer deciding on its own that tool output isn't worth recording.

### Community

Features in this release were contributed by **Alessandro Costa** ([@alessandropcostabr](https://github.com/alessandropcostabr)) — semantic injection, tier routing, multi-machine sync, orphan drain, and the 3-bug production fix. All PRs include production data from real multi-server deployments.

### Release History

This release consolidates v10.7.0 through v11.0.0, all shipped on April 4, 2026. For the full v10.x era (267 commits, 39 releases), see [v10.7.0](https://github.com/thedotmack/claude-mem/releases/tag/v10.7.0) and earlier.

## [10.7.2] - 2026-04-05

## Bug Fix

- **fix**: Downgrade concept-type cleanup log from error to debug (#1606) — reduces noise in logs by treating routine concept-type cleanup as debug-level rather than error-level logging.

## [10.7.1] - 2026-04-05

## Bug Fix

**Restore full interactive installer** — the install simplification in v10.7.0 (commit 21b10b46) over-applied scope and replaced the entire `runInstallCommand` with just two `claude` CLI commands. This gutted the interactive IDE multi-select, `--ide` flag, and all 13 IDE-specific setup dispatchers.

### What changed
- **Claude Code**: now uses native `claude plugin marketplace add` + `claude plugin install` (the intended simplification)
- **All other IDEs** (Gemini CLI, OpenCode, Windsurf, OpenClaw, Codex CLI, Copilot CLI, Antigravity, Goose, Crush, Roo Code, Warp): full installer flow restored — file copy, marketplace registration, interactive multi-select via `@clack/prompts`, and IDE-specific setup
- `--ide <id>` flag works again for direct IDE targeting

## [10.7.0] - 2026-04-04

## What's New

### Simplified Installation
- Install command now delegates to native Claude Code plugin system: `claude plugin marketplace add thedotmack/claude-mem && claude plugin install claude-mem`
- Reduced install.ts from 536 lines to 36 lines

### Multi-IDE Support (NPX CLI)
- Gemini CLI hooks installer with lifecycle event mapping
- Windsurf hooks installer with project registry and context injection
- OpenCode plugin installer with AGENTS.md context injection
- OpenClaw plugin installer
- Codex CLI transcript watcher integration
- MCP factory pattern for Copilot CLI, Antigravity, Goose, Crush, Roo Code, Warp

### Uninstall Improvements
- Worker shutdown now waits for process exit before file deletion
- IDE-specific hooks and config are cleaned up during uninstall

### Bug Fixes
- Fixed bundle path resolution using `import.meta.url` instead of `process.cwd()`
- Fixed Windsurf registry key collision for same-named workspace directories
- AGENTS.md injection failures now logged instead of silently swallowed
- Session tracking Map capped at 1000 entries to prevent memory leaks
- Fixed double-shebang in NPX CLI bundle
- Fixed corrupt JSON handling in Gemini CLI status command

### Other
- Restored version-bump skill for future releases
- Added IDE context files for Windsurf, Warp, Copilot, and agent rules

## [10.6.3] - 2026-03-29

### Bug Fixes

- **Fix MCP server crash**: Removed erroneous `import.meta.url` ESM-compat banner from CJS files that caused Node.js startup failures
- **Fix 7 critical bugs** affecting all non-dev-machine users and Windows:
  - Hook registration paths corrected for plugin distribution
  - Worker service spawn handling hardened for Windows
  - Environment sanitization for cross-platform compatibility
  - ProcessManager Windows spawn catch block improvements
  - SessionEnd inline hook exemption in regression tests
  - `summarize.ts` warning log now includes `sessionId` for triage
- **CodeRabbit review feedback** addressed from PR #1518

### Improvements

- **Gemini CLI integration**: Strip ANSI color codes from timeline display, provide markdown fallback

### Files Changed

- `plugin/hooks/hooks.json`
- `plugin/scripts/mcp-server.cjs`
- `plugin/scripts/worker-service.cjs`
- `scripts/build-hooks.js`
- `src/cli/handlers/summarize.ts`
- `src/services/infrastructure/ProcessManager.ts`
- `src/services/worker-service.ts`
- `src/supervisor/env-sanitizer.ts`
- `tests/infrastructure/plugin-distribution.test.ts`
- `tests/supervisor/env-sanitizer.test.ts`

## [10.6.2] - 2026-03-21

## fix: Activity spinner stuck spinning forever

The viewer UI activity spinner would spin indefinitely because `isAnySessionProcessing()` queried all pending/processing messages in the database globally — including orphaned messages from dead sessions that no generator would ever process. These orphans caused `isProcessing=true` forever.

### Changes

- Scoped `isAnySessionProcessing()` and `hasPendingMessages()` to only check sessions in the active in-memory Map, so orphaned DB messages no longer affect the spinner
- Added `terminateSession()` method enforcing a restart-or-terminate invariant — every generator exit must either restart or fully clean up
- Fixed 3 zombie paths in the `.finally()` handler that previously left sessions alive in memory with no generator running
- Fixed idle-timeout race condition where fresh messages arriving between idle abort and cleanup could be silently dropped
- Removed redundant bare `isProcessing: true` broadcast and eliminated double-iteration in `broadcastProcessingStatus()`
- Replaced inline `require()` with proper accessor via `sessionManager.getPendingMessageStore()`
- Added 8 regression tests for session termination invariant

## [10.6.1] - 2026-03-18

### New Features
- **Timeline Report Skill** — New `/timeline-report` skill generates narrative "Journey Into [Project]" reports from claude-mem's development history with token-aware economics
- **Git Worktree Detection** — Timeline report automatically detects git worktrees and uses parent project as data source
- **Compressed Context Output** — Markdown context injection compressed ~53% (tables → compact flat lines), reducing token overhead in session starts
- **Full Observation Fetch** — Added `full=true` parameter to `/api/context/inject` for fetching all observations

### Improvements
- Split `TimelineRenderer` into separate markdown/color rendering paths
- Fixed timestamp ditto marker leaking across session summary boundaries

### Security
- Removed arbitrary file write vulnerability (`dump_to_file` parameter)

## [10.6.0] - 2026-03-18

## OpenClaw: System prompt context injection

The OpenClaw plugin no longer writes to `MEMORY.md`. Instead, it injects the observation timeline into each agent's system prompt via the `before_prompt_build` hook using `appendSystemContext`. This keeps `MEMORY.md` under the agent's control for curated long-term memory. Context is cached for 60 seconds per project.

## New `syncMemoryFileExclude` config

Exclude specific agent IDs from automatic context injection (e.g., `["snarf", "debugger"]`). Observations are still recorded for excluded agents — only the context injection is skipped.

## Fix: UI settings now preserve falsy values

The viewer settings hook used `||` instead of `??`, which silently replaced backend values like `'0'`, `'false'`, and `''` with UI defaults. Fixed with nullish coalescing. Frontend defaults now aligned with backend `SettingsDefaultsManager`.

## Documentation

- Updated `openclaw-integration.mdx` and `openclaw/SKILL.md` to reflect system prompt injection behavior
- Fixed "prompt injection" → "context injection" terminology to avoid confusion with the OWASP security term

## [10.5.6] - 2026-03-16

## Patch: Process Supervisor Hardening & Logging Cleanup

### Fixes
- **Downgrade HTTP request/response logging from INFO to DEBUG** — eliminates noisy per-request log spam from the viewer UI polling
- **Fix `isPidAlive(0)` returning true** — PID 0 is the kernel scheduler, not a valid child process
- **Fix signal handler race condition** — added `shutdownInitiated` flag to prevent duplicate shutdown cascades when signals arrive before `stopPromise` is set
- **Remove unused `dataDir` parameter** from `ShutdownCascadeOptions`
- **Export and reuse env sanitizer constants** — `Server.ts` now imports `ENV_PREFIXES`/`ENV_EXACT_MATCHES` from `env-sanitizer.ts` instead of duplicating them
- **Rename `zombiePidFiles` to `deadProcessPids`** — now returns actual PID array instead of a boolean
- **Use `buildWorkerUrl` helper** in `workerHttpRequest` instead of inline URL construction
- **Remove unused `getWorkerPort` imports** from observation and session-init handlers
- **Upgrade `reapSession` failure log** from debug to warn level
- **Clean up `.gitignore`** — remove stale `~*/`, `http*/`, `https*/` patterns and duplicate `datasets/` entry

### Tests
- Rewrote supervisor index tests to use temp directories instead of relying on real `~/.claude-mem/worker.pid`
- Added deterministic test cases for missing, invalid, stale, and alive PID file states
- Removed unused `dataDir` from shutdown test fixtures

## [10.5.5] - 2026-03-09

### Bug Fix

- **Fixed empty context queries after mode switching**: Switching from a non-code mode (e.g., law-study) back to code mode left stale observation type/concept filters in `settings.json`, causing all context queries to return empty results. All modes now read types/concepts from their mode JSON definition uniformly.

### Cleanup

- Removed dead `CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES` and `CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS` settings constants
- Deleted `src/constants/observation-metadata.ts` (no longer needed)
- Removed observation type/concept filter UI controls from the viewer's Context Settings modal

## [10.5.4] - 2026-03-09

## Bug Fixes

- **fix: restore modes to correct location** — All modes (`code`, code language variants, `email-investigation`) were erroneously moved from `plugin/modes/` to `plugin/hooks/modes/` during the v10.5.3 release, breaking mode loading. This patch restores them to `plugin/modes/` where they belong.

## [10.5.3] - 2026-03-09

## What's New

### Law Study Mode

Adds `law-study` — a purpose-built claude-mem mode for law students.

**Observation Types:**
- **Case Holding** — 2-3 sentence brief with extracted legal rule
- **Issue Pattern** — exam trigger or fact pattern that signals a legal issue
- **Prof Framework** — professor's analytical lens and emphasis for a topic
- **Doctrine / Rule** — legal test or standard synthesized from cases/statutes
- **Argument Structure** — legal argument or counter-argument worked through analytically
- **Cross-Case Connection** — insight linking cases or doctrines to reveal a deeper principle

**Concepts (cross-cutting tags):**
`exam-relevant` · `minority-position` · `gotcha` · `unsettled-law` · `policy-rationale` · `course-theme`

**Chill Variant** — `law-study--chill` records only high-signal items: issue patterns, gotchas, and professor frameworks. Skips routine case holdings unless the result is counterintuitive.

**CLAUDE.md Template** — `law-study-CLAUDE.md` is a drop-in template for any law study project directory. It configures Claude as a Socratic legal study partner: precise case briefs, critical document analysis, issue spotting, and doctrine synthesis — without writing exam answers for the student.

Activate with: `/mode law-study` or `/mode law-study--chill`

## [10.5.2] - 2026-02-26

## Smart Explore Benchmark Docs & Skill Update

### Documentation
- Published smart-explore benchmark report to public docs — full A/B comparison with methodology, raw data tables, quality assessment, and decision framework
- Added benchmark report to docs.json navigation under Best Practices

### Smart Explore Skill
- Updated token economics with benchmark-accurate data (11-18x savings on exploration, 4-8x on file understanding)
- Added "map first" core principle as decision heuristic for tool selection
- Added AST completeness guarantee to smart_unfold documentation (never truncates, unlike Explore agents)
- Added Explore agent escalation guidance for multi-file synthesis tasks
- Updated smart_unfold token range from ~1-7k to ~400-2,100 based on measurements
- Updated Explore agent token range from ~20-40k to ~39-59k based on measurements

## [10.5.1] - 2026-02-26

### Bug Fix

- Restored hooks.json to pre-smart-explore configuration (re-adds Setup hook, separate worker start command, PostToolUse matcher)

## [10.5.0] - 2026-02-26

## Smart Explore: AST-Powered Code Navigation

This release introduces **Smart Explore**, a token-optimized structural code search system built on tree-sitter AST parsing. It applies the same progressive disclosure pattern used in human-readable code outlines — but programmatically, for AI agents.

### Why This Matters

The standard exploration cycle (Glob → Grep → Read) forces agents to consume entire files to understand code structure. A typical 800-line file costs ~12,000 tokens to read. Smart Explore replaces this with a 3-layer progressive disclosure workflow that delivers the same understanding at **6-12x lower token cost**.

### 3 New MCP Tools

- **`smart_search`** — Walks directories, parses all code files via tree-sitter, and returns ranked symbols with signatures and line numbers. Replaces the Glob → Grep discovery cycle in a single call (~2-6k tokens).
- **`smart_outline`** — Returns the complete structural skeleton of a file: all functions, classes, methods, properties, imports (~1-2k tokens vs ~12k for a full Read).
- **`smart_unfold`** — Expands a single symbol to its full source code including JSDoc, decorators, and implementation (~1-7k tokens).

### Token Economics

| Approach | Tokens | Savings |
|----------|--------|---------|
| smart_outline + smart_unfold | ~3,100 | 8x vs Read |
| smart_search (cross-file) | ~2,000-6,000 | 6-12x vs Explore agent |
| Read (full file) | ~12,000+ | baseline |
| Explore agent | ~20,000-40,000 | baseline |

### Language Support

10 languages via tree-sitter grammars: TypeScript, JavaScript, Python, Rust, Go, Java, C, C++, Ruby, PHP.

### Other Changes

- Simplified hooks configuration
- Removed legacy setup.sh script
- Security fix: replaced `execSync` with `execFileSync` to prevent command injection in file path handling

## [10.4.4] - 2026-02-26

## Fix

- **Remove `save_observation` from MCP tool surface** — This tool was exposed as an MCP tool available to Claude, but it's an internal API-only feature. Removing it from the MCP server prevents unintended tool invocation and keeps the tool surface clean.

## [10.4.3] - 2026-02-25

## Bug Fixes

- **Fix PostToolUse hook crashes and 5-second latency (#1220)**: Added missing `break` statements to all 7 switch cases in `worker-service.ts` preventing fall-through execution, added `.catch()` on `main()` to handle unhandled promise rejections, and removed redundant `start` commands from hook groups that triggered the 5-second `collectStdin()` timeout
- **Fix CLAUDE_PLUGIN_ROOT fallback for Stop hooks (#1215)**: Added POSIX shell-level `CLAUDE_PLUGIN_ROOT` fallback in `hooks.json` for environments where the variable isn't injected, added script-level self-resolution via `import.meta.url` in `bun-runner.js`, and regression test added in `plugin-distribution.test.ts`

## Maintenance

- Synced all version files (plugin.json was stuck at 10.4.0)

## [10.4.2] - 2026-02-25

## Bug Fixes

- **Fix PostToolUse hook crashes and 5-second latency (#1220)**: Added missing `break` statements to all 7 switch cases in `worker-service.ts` preventing fall-through execution, added `.catch()` on `main()` to handle unhandled promise rejections, and removed redundant `start` commands from hook groups that triggered the 5-second `collectStdin()` timeout
- **Fix CLAUDE_PLUGIN_ROOT fallback for Stop hooks (#1215)**: Added POSIX shell-level `CLAUDE_PLUGIN_ROOT` fallback in `hooks.json` for environments where the variable isn't injected, added script-level self-resolution via `import.meta.url` in `bun-runner.js`, and regression test added in `plugin-distribution.test.ts`
- **Sync plugin.json version**: Fixed `plugin.json` being stuck at 10.4.0 while other version files were at 10.4.1

## [10.4.1] - 2026-02-24

### Refactor
- **Skills Conversion**: Converted `/make-plan` and `/do` commands into first-class skills in `plugin/skills/`.
- **Organization**: Centralized planning and execution instructions alongside `mem-search`.
- **Compatibility**: Added symlinks for `openclaw/skills/` to ensure seamless integration with OpenClaw.

### Chore
- **Version Bump**: Aligned all package and plugin manifests to v10.4.1.

## [10.4.0] - 2026-02-24

Massive reliability release: 30+ root-cause bug fixes across 10 triage phases, plus new features for agent attribution, Chroma control, and broader platform support.

### New Features

- **Session custom titles** — Agents can now set `custom_title` on sessions for attribution (migration 23, new endpoint)
- **Chroma toggle** — `CLAUDE_MEM_CHROMA_ENABLED` setting allows SQLite-only fallback mode (#707)
- **Plugin disabled state** — Early exit check in all hook entry points when plugin is disabled (#781)
- **Context re-injection guard** — `contextInjected` session flag prevents re-injecting context on every UserPromptSubmit turn (#1079)

### Bug Fixes

#### Data Integrity
- SHA-256 content-hash deduplication on observation INSERT (migration 22 with backfill + index)
- Project name collision fix: `getCurrentProjectName()` now returns `parent/basename`
- Empty project string guard with cwd-derived fallback
- Stuck `isProcessing` reset: pending work older than 5 minutes auto-clears

#### ChromaDB
- Python version pinning in uvx args for both local and remote mode (#1196, #1206, #1208)
- Windows backslash-to-forward-slash path conversion for `--data-dir` (#1199)
- Metadata sanitization: filter null/undefined/empty values in `addDocuments()` (#1183, #1188)
- Transport error auto-reconnect in `callTool()` (#1162)
- Stale transport retry with transparent reconnect (#1131)

#### Hook Lifecycle
- Suppress `process.stderr.write` in `hookCommand()` to prevent diagnostic output showing as error UI (#1181)
- Route all `console.error()` through logger instead of stderr
- Verified all 7 handlers return `suppressOutput: true` (#598, #784)

#### Worker Lifecycle
- PID file mtime guard prevents concurrent restart storms (#1145)
- `getInstalledPluginVersion()` ENOENT/EBUSY handling (#1042)

#### SQLite Migrations
- Schema initialization always creates core tables via `CREATE TABLE IF NOT EXISTS`
- Migrations 5-7 check actual DB state instead of version tracking (fixes version collision between old/new migration systems, #979)
- Crash-safe temp table rebuilds

#### Platform Support
- **Windows**: `cmd.exe /c` uvx spawn, PowerShell `$_` elimination with WQL filtering, `windowsHide: true`, FTS5 runtime probe with fallback (#1190, #1192, #1199, #1024, #1062, #1048, #791)
- **Cursor IDE**: Adapter field fallbacks, tolerant session-init validation (#838, #1049)
- **Codex CLI**: `session_id` fallbacks, unknown platform tolerance, undefined guard (#744)

#### API & Infrastructure
- `/api/logs` OOM fix: tail-read replaces full-file `readFileSync` (64KB expanding chunks, 10MB cap, #1203)
- CORS: explicit methods and allowedHeaders (#1029)
- MCP type coercion for batch endpoints: string-to-array for `ids` and `memorySessionIds`
- Defensive observation error handling returns 200 on recoverable errors instead of 500
- `.git/` directory write guard on all 4 CLAUDE.md/AGENTS.md write sites (#1165)

#### Stale AbortController Fix
- `lastGeneratorActivity` timestamp tracking with 30s timeout (#1099)
- Stale generator detection + abort + restart in `ensureGeneratorRunning`
- `AbortSignal.timeout(30000)` in `deleteSession` prevents indefinite hang

### Installation
- `resolveRoot()` replaces hardcoded marketplace path using `CLAUDE_PLUGIN_ROOT` env var (#1128, #1166)
- `installCLI()` path correction and `verifyCriticalModules()` post-install check
- Build-time distribution verification for skills, hooks, and plugin manifest (#1187)

### Testing
- 50+ new tests across hook lifecycle, context re-injection, plugin distribution, migration runner, data integrity, stale abort controller, logs tail-read, CORS, MCP type coercion, and smart-install
- 68 files changed, ~4200 insertions, ~900 deletions

## [10.3.3] - 2026-02-23

### Bug Fixes

- Fixed session context footer to reference the claude-mem skill instead of MCP search tools for accessing memories

## [10.3.2] - 2026-02-23

## Bug Fixes

- **Worker startup readiness**: Worker startup hook now waits for full DB/search readiness before proceeding, fixing the race condition where hooks would fire before the worker was initialized on first start (#1210)
- **MCP tool naming**: Renamed `save_memory` to `save_observation` for consistency with the observation-based data model (#1210)
- **MCP search instructions**: Updated MCP server tool descriptions to accurately reflect the 3-layer search workflow (#1210)
- **Installer hosting**: Serve installer JS from install.cmem.ai instead of GitHub raw URLs for reliability
- **Installer routing**: Added rewrite rule so install.cmem.ai root path correctly serves the install script
- **Installer build**: Added compiled installer dist so CLI installation works out of the box

## [10.3.1] - 2026-02-19

## Fix: Prevent Duplicate Worker Daemons and Zombie Processes

Three root causes of chroma-mcp timeouts identified and fixed:

### PID-based daemon guard
Exit immediately on startup if PID file points to a live process. Prevents the race condition where hooks firing simultaneously could start multiple daemons before either wrote a PID file.

### Port-based daemon guard
Exit if port 37777 is already bound — runs before WorkerService constructor registers keepalive signal handlers that previously prevented exit on EADDRINUSE.

### Guaranteed process.exit() after HTTP shutdown
HTTP shutdown (POST /api/admin/shutdown) now calls `process.exit(0)` in a `try/finally` block. Previously, zombie workers stayed alive after shutdown, and background tasks reconnected to chroma-mcp, spawning duplicate subprocesses contending for the same data directory.

## [10.3.0] - 2026-02-18

## Replace WASM Embeddings with Persistent chroma-mcp MCP Connection

### Highlights

- **New: ChromaMcpManager** — Singleton stdio MCP client communicating with chroma-mcp via `uvx`, replacing the previous ChromaServerManager (`npx chroma run` + `chromadb` npm + ONNX/WASM)
- **Eliminates native binary issues** — No more segfaults, WASM embedding failures, or cross-platform install headaches
- **Graceful subprocess lifecycle** — Wired into GracefulShutdown for clean teardown; zombie process prevention with kill-on-failure and stale `onclose` handler guards
- **Connection backoff** — 10-second reconnect backoff prevents chroma-mcp spawn storms
- **SQL injection guards** — Added parameterization to ChromaSync ID exclusion queries
- **Simplified ChromaSync** — Reduced complexity by delegating embedding concerns to chroma-mcp

### Breaking Changes

None — backward compatible. ChromaDB data is preserved; only the connection mechanism changed.

### Files Changed

- `src/services/sync/ChromaMcpManager.ts` (new) — MCP client singleton
- `src/services/sync/ChromaServerManager.ts` (deleted) — Old WASM/native approach
- `src/services/sync/ChromaSync.ts` — Simplified to use MCP client
- `src/services/worker-service.ts` — Updated startup sequence
- `src/services/infrastructure/GracefulShutdown.ts` — Subprocess cleanup integration

## [10.2.6] - 2026-02-18

## Bug Fixes

### Zombie Process Prevention (#1168, #1175)

Observer Claude CLI subprocesses were accumulating as zombies — processes that never exited after their session ended, causing massive resource leaks on long-running systems.

**Root cause:** When observer sessions ended (via idle timeout, abort, or error), the spawned Claude CLI subprocesses were not being reliably killed. The existing `ensureProcessExit()` in `SDKAgent` only covered the happy path; sessions terminated through `SessionRoutes` or `worker-service` bypassed process cleanup entirely.

**Fix — dual-layer approach:**

1. **Immediate cleanup:** Added `ensureProcessExit()` calls to the `finally` blocks in both `SessionRoutes.ts` and `worker-service.ts`, ensuring every session exit path kills its subprocess
2. **Periodic reaping:** Added `reapStaleSessions()` to `SessionManager` — a background interval that scans `~/.claude-mem/observer-sessions/` for stale PID files, verifies the process is still running, and kills any orphans with SIGKILL escalation

This ensures no observer subprocess survives beyond its session lifetime, even in crash scenarios.

## [10.2.5] - 2026-02-18

### Bug Fixes

- **Self-healing message queue**: Renamed `claimAndDelete` → `claimNextMessage` with atomic self-healing — automatically resets stale processing messages (>60s) back to pending before claiming, eliminating stuck messages from generator crashes without external timers
- **Removed redundant idle-timeout reset**: The `resetStaleProcessingMessages()` call during idle timeout in worker-service was removed (startup reset kept), since the atomic self-healing in `claimNextMessage` now handles recovery inline
- **TypeScript diagnostic fix**: Added `QUEUE` to logger `Component` type

### Tests

- 5 new tests for self-healing behavior (stuck recovery, active protection, atomicity, empty queue, session isolation)
- 1 new integration test for stuck recovery in zombie-prevention suite
- All existing queue tests updated for renamed method

## [10.2.4] - 2026-02-18

## Chroma Vector DB Backfill Fix

Fixes the Chroma backfill system to correctly sync all SQLite observations into the vector database on worker startup.

### Bug Fixes

- **Backfill all projects on startup** — `backfillAllProjects()` now runs on worker startup, iterating all projects in SQLite and syncing missing observations to Chroma. Previously `ensureBackfilled()` existed but was never called, leaving Chroma with incomplete data after cache clears.

- **Fixed critical collection routing bug** — Backfill now uses the shared `cm__claude-mem` collection (matching how DatabaseManager and SearchManager operate) instead of creating per-project orphan collections that no search path reads from.

- **Hardened collection name sanitization** — Project names with special characters (e.g., "YC Stuff") are sanitized for Chroma's naming constraints, including stripping trailing non-alphanumeric characters.

- **Eliminated shared mutable state** — `ensureBackfilled()` and `getExistingChromaIds()` now accept project as a parameter instead of mutating instance state, keeping a single Chroma connection while avoiding fragile property mutation across iterations.

- **Chroma readiness guard** — Backfill waits for Chroma server readiness before running, preventing spurious error logs when Chroma fails to start.

### Changed Files

- `src/services/sync/ChromaSync.ts` — Core backfill logic, sanitization, parameter passing
- `src/services/worker-service.ts` — Startup backfill trigger + readiness guard
- `src/utils/logger.ts` — Added `CHROMA_SYNC` log component

## [10.2.3] - 2026-02-17

## Fix Chroma ONNX Model Cache Corruption

Addresses the persistent embedding pipeline failures reported across #1104, #1105, #1110, and subsequent sessions. Three root causes identified and fixed:

### Changes

- **Removed nuclear `bun pm cache rm`** from both `smart-install.js` and `sync-marketplace.cjs`. This was added in v10.2.2 for the now-removed sharp dependency but destroyed all cached packages, breaking the ONNX resolution chain.
- **Added `bun install` in plugin cache directory** after marketplace sync. The cache directory had a `package.json` with `@chroma-core/default-embed` as a dependency but never ran install, so the worker couldn't resolve it at runtime.
- **Moved HuggingFace model cache to `~/.claude-mem/models/`** outside `node_modules`. The ~23MB ONNX model was stored inside `node_modules/@huggingface/transformers/.cache/`, so any reinstall or cache clear corrupted it.
- **Added self-healing retry** for Protobuf parsing failures. If the downloaded model is corrupted, the cache is cleared and re-downloaded automatically on next use.

### Files Changed

- `scripts/smart-install.js` — removed `bun pm cache rm`
- `scripts/sync-marketplace.cjs` — removed `bun pm cache rm`, added `bun install` in cache dir
- `src/services/sync/ChromaSync.ts` — moved model cache, added corruption recovery

## [10.2.2] - 2026-02-17

## Bug Fixes

- **Removed `node-addon-api` dev dependency** — was only needed for `sharp`, which was already removed in v10.2.1
- **Simplified native module cache clearing** in `smart-install.js` and `sync-marketplace.cjs` — replaced targeted `@img/sharp` directory deletion and lockfile removal with `bun pm cache rm`
- Reduced ~30 lines of brittle file system manipulation to a clean Bun CLI command

## [10.2.1] - 2026-02-16

## Bug Fixes

- **Bun install & sharp native modules**: Fixed stale native module cache issues on Bun updates, added `node-addon-api` as a dev dependency required by sharp (#1140)
- **PendingMessageStore consolidation**: Deduplicated PendingMessageStore initialization in worker-service; added session-scoped filtering to `resetStaleProcessingMessages` to prevent cross-session message resets (#1140)
- **Gemini empty response handling**: Fixed silent message deletion when Gemini returns empty summary responses — now logs a warning and preserves the original message (#1138)
- **Idle timeout session scoping**: Fixed idle timeout handler to only reset messages for the timed-out session instead of globally resetting all sessions (#1138)
- **Shell injection in sync-marketplace**: Replaced `execSync` with `spawnSync` for rsync calls to eliminate command injection via gitignore patterns (#1138)
- **Sharp cache invalidation**: Added cache clearing for sharp's native bindings when Bun version changes (#1138)
- **Marketplace install**: Switched marketplace sync from npm to bun for package installation consistency (#1140)

## [10.1.0] - 2026-02-16

## SessionStart System Message & Cleaner Defaults

### New Features

- **SessionStart `systemMessage` support** — Hooks can now display user-visible ANSI-colored messages directly in the CLI via a new `systemMessage` field on `HookResult`. The SessionStart hook uses this to render a colored timeline summary (separate from the markdown context injected for Claude), giving users an at-a-glance view of recent activity every time they start a session.

- **"View Observations Live" link** — Each session start now appends a clickable `http://localhost:{port}` URL so users can jump straight to the live observation viewer.

### Performance

- **Truly parallel context fetching** — The SessionStart handler now uses `Promise.all` to fetch both the markdown context (for Claude) and the ANSI-colored timeline (for user display) simultaneously, eliminating the serial fetch overhead.

### Defaults Changes

- **Cleaner out-of-box experience** — New installs now default to a streamlined context display:
  - Read tokens column: hidden (`CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: false`)
  - Work tokens column: hidden (`CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: false`)
  - Savings amount: hidden (`CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: false`)
  - Full observation expansion: disabled (`CLAUDE_MEM_CONTEXT_FULL_COUNT: 0`)
  - Savings percentage remains visible by default

  Existing users are unaffected — your `~/.claude-mem/settings.json` overrides these defaults.

### Technical Details

- Added `systemMessage?: string` to `HookResult` interface (`src/cli/types.ts`)
- Claude Code adapter now forwards `systemMessage` in hook output (`src/cli/adapters/claude-code.ts`)
- Context handler refactored for parallel fetch with graceful fallback (`src/cli/handlers/context.ts`)
- Default settings tuned in `SettingsDefaultsManager` (`src/shared/SettingsDefaultsManager.ts`)

## [10.0.8] - 2026-02-16

## Bug Fixes

### Orphaned Subprocess Cleanup
- Add explicit subprocess cleanup after SDK query loop using existing `ProcessRegistry` infrastructure (`getProcessBySession` + `ensureProcessExit`), preventing orphaned Claude subprocesses from accumulating
- Closes #1010, #1089, #1090, #1068

### Chroma Binary Resolution
- Replace `npx chroma run` with absolute binary path resolution via `require.resolve`, falling back to `npx` with explicit `cwd` when the binary isn't found directly
- Closes #1120

### Cross-Platform Embedding Fix
- Remove `@chroma-core/default-embed` which pulled in `onnxruntime` + `sharp` native binaries that fail on many platforms
- Use WASM backend for Chroma embeddings, eliminating native binary compilation issues
- Closes #1104, #1105, #1110

## [10.0.7] - 2026-02-14

## Chroma HTTP Server Architecture

- **Persistent HTTP server**: Switched from in-process Chroma to a persistent HTTP server managed by the new `ChromaServerManager` for better reliability and performance
- **Local embeddings**: Added `DefaultEmbeddingFunction` for local vector embeddings — no external API required
- **Pinned chromadb v3.2.2**: Fixed compatibility with v2 API heartbeat endpoint
- **Server lifecycle improvements**: Addressed PR review feedback for proper start/stop/health check handling

## Bug Fixes

- Fixed SDK spawn failures and sharp native binary crashes
- Added `plugin.json` to root `.claude-plugin` directory for proper plugin structure
- Removed duplicate else block from merge artifact

## Infrastructure

- Added multi-tenancy support for claude-mem Pro
- Updated OpenClaw install URLs to `install.cmem.ai`
- Added Vercel deploy workflow for install scripts
- Added `.claude/plans` and `.claude/worktrees` to `.gitignore`

## [10.0.6] - 2026-02-13

## Bug Fixes

- **OpenClaw: Fix MEMORY.md project query mismatch** — `syncMemoryToWorkspace` now includes both the base project name and the agent-scoped project name (e.g., both "openclaw" and "openclaw-main") when querying for context injection, ensuring the correct observations are pulled into MEMORY.md.

- **OpenClaw: Add feed botToken support for Telegram** — Feeds can now configure a dedicated `botToken` for direct Telegram message delivery, bypassing the OpenClaw gateway channel. This fixes scenarios where the gateway bot token couldn't be used for feed messages.

## Other

- Changed OpenClaw plugin kind from "integration" to "memory" for accuracy.

## [10.0.5] - 2026-02-13

## OpenClaw Installer & Distribution

This release introduces the OpenClaw one-liner installer and fixes several OpenClaw plugin issues.

### New Features

- **OpenClaw Installer** (`openclaw/install.sh`): Full cross-platform installer script with `curl | bash` support
  - Platform detection (macOS, Linux, WSL)
  - Automatic dependency management (Bun, uv, Node.js)
  - Interactive AI provider setup with settings writer
  - OpenClaw gateway detection, plugin install, and memory slot configuration
  - Worker startup and health verification with rich diagnostics
  - TTY detection, `--provider`/`--api-key` CLI flags
  - Error recovery and upgrade handling for existing installations
  - jq/python3/node fallback chain for JSON config writing
- **Distribution readiness tests** (`openclaw/test-install.sh`): Comprehensive test suite for the installer
- **Enhanced `/api/health` endpoint**: Now returns version, uptime, workerPath, and AI status

### Bug Fixes

- Fix: use `event.prompt` instead of `ctx.sessionKey` for prompt storage in OpenClaw plugin
- Fix: detect both `openclaw` and `openclaw.mjs` binary names in gateway discovery
- Fix: pass file paths via env vars instead of bash interpolation in `node -e` calls
- Fix: handle stale plugin config that blocks OpenClaw CLI during reinstall
- Fix: remove stale memory slot reference during reinstall cleanup
- Fix: remove opinionated filters from OpenClaw plugin

## [10.0.4] - 2026-02-12

## Revert: v10.0.3 chroma-mcp spawn storm fix

v10.0.3 introduced regressions. This release reverts the codebase to the stable v10.0.2 state.

### What was reverted

- Connection mutex via promise memoization
- Pre-spawn process count guard
- Hardened `close()` with try-finally + Unix `pkill -P` fallback
- Count-based orphan reaper in `ProcessManager`
- Circuit breaker (3 failures → 60s cooldown)
- `etime`-based sorting for process guards

### Files restored to v10.0.2

- `src/services/sync/ChromaSync.ts`
- `src/services/infrastructure/GracefulShutdown.ts`
- `src/services/infrastructure/ProcessManager.ts`
- `src/services/worker-service.ts`
- `src/services/worker/ProcessRegistry.ts`
- `tests/infrastructure/process-manager.test.ts`
- `tests/integration/chroma-vector-sync.test.ts`

## [10.0.3] - 2026-02-11

## Fix: Prevent chroma-mcp spawn storm (PR #1065)

Fixes a critical bug where killing the worker daemon during active sessions caused **641 chroma-mcp Python processes** to spawn in ~5 minutes, consuming 75%+ CPU and ~64GB virtual memory.

### Root Cause

`ChromaSync.ensureConnection()` had no connection mutex. Concurrent fire-and-forget `syncObservation()` calls from multiple sessions raced through the check-then-act guard, each spawning a chroma-mcp subprocess via `StdioClientTransport`. Error-driven reconnection created a positive feedback loop.

### 5-Layer Defense

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| **0** | Connection mutex via promise memoization | Coalesces concurrent callers onto a single spawn attempt |
| **1** | Pre-spawn process count guard (`execFileSync('ps')`) | Kills excess chroma-mcp processes before spawning new ones |
| **2** | Hardened `close()` with try-finally + Unix `pkill -P` fallback | Guarantees state reset even on error, kills orphaned children |
| **3** | Count-based orphan reaper in `ProcessManager` | Kills by count (not age), catches spawn storms where all processes are young |
| **4** | Circuit breaker (3 failures → 60s cooldown) | Stops error-driven reconnection positive feedback loop |

### Additional Fix

- Process guards now use `etime`-based sorting instead of PID ordering for reliable age determination (PIDs wrap and don't guarantee ordering)

### Testing

- 16 new tests for mutex, circuit breaker, close() hardening, and count guard
- All tests pass (947 pass, 3 skip)

Closes #1063, closes #695. Relates to #1010, #707.

**Contributors:** @rodboev

## [10.0.2] - 2026-02-11

## Bug Fixes

- **Prevent daemon silent death from SIGHUP + unhandled errors** — Worker process could silently die when receiving SIGHUP signals or encountering unhandled errors, leaving hooks without a backend. Now properly handles these signals and prevents silent crashes.
- **Hook resilience and worker lifecycle improvements** — Comprehensive fixes for hook command error classification, addressing issues #957, #923, #984, #987, and #1042. Hooks now correctly distinguish between worker unavailability errors and other failures.
- **Clarify TypeError order dependency in error classifier** — Fixed error classification logic to properly handle TypeError ordering edge cases.

## New Features

- **Project-scoped statusline counter utility** — Added `statusline-counts.js` for tracking observation counts per project in the Claude Code status line.

## Internal

- Added test coverage for hook command error classification and process manager
- Worker service and MCP server lifecycle improvements
- Process manager enhancements for better cross-platform stability

### Contributors
- @rodboev — Hook resilience and worker lifecycle fixes (PR #1056)

## [10.0.1] - 2026-02-11

## What's Changed

### OpenClaw Observation Feed
- Enabled SSE observation feed for OpenClaw agent sessions, allowing real-time streaming of observations to connected OpenClaw clients
- Fixed `ObservationSSEPayload.project` type to be nullable, preventing type errors when project context is unavailable
- Added `EnvManager` support for OpenClaw environment configuration

### Build Artifacts
- Rebuilt worker service and MCP server with latest changes

## [10.0.0] - 2026-02-11

## OpenClaw Plugin — Persistent Memory for OpenClaw Agents

Claude-mem now has an official [OpenClaw](https://openclaw.ai) plugin, bringing persistent memory to agents running on the OpenClaw gateway. This is a major milestone — claude-mem's memory system is no longer limited to Claude Code sessions.

### What It Does

The plugin bridges claude-mem's observation pipeline with OpenClaw's embedded runner (`pi-embedded`), which calls the Anthropic API directly without spawning a `claude` process. Three core capabilities:

1. **Observation Recording** — Captures every tool call from OpenClaw agents and sends it to the claude-mem worker for AI-powered compression and storage
2. **MEMORY.md Live Sync** — Writes a continuously-updated memory timeline to each agent's workspace, so agents start every session with full context from previous work
3. **Observation Feed** — Streams new observations to messaging channels (Telegram, Discord, Slack, Signal, WhatsApp, LINE) in real-time via SSE

### Quick Start

Add claude-mem to your OpenClaw gateway config:

```json
{
  "plugins": {
    "claude-mem": {
      "enabled": true,
      "config": {
        "project": "my-project",
        "syncMemoryFile": true,
        "observationFeed": {
          "enabled": true,
          "channel": "telegram",
          "to": "your-chat-id"
        }
      }
    }
  }
}
```

The claude-mem worker service must be running on the same machine (`localhost:37777`).

### Commands

- `/claude-mem-status` — Worker health check, active sessions, feed connection state
- `/claude-mem-feed` — Show/toggle observation feed status
- `/claude-mem-feed on|off` — Enable/disable feed

### How the Event Lifecycle Works

```
OpenClaw Gateway
  ├── session_start ──────────→ Init claude-mem session
  ├── before_agent_start ─────→ Sync MEMORY.md + track workspace
  ├── tool_result_persist ────→ Record observation + re-sync MEMORY.md
  ├── agent_end ──────────────→ Summarize + complete session
  ├── session_end ────────────→ Clean up session tracking
  └── gateway_start ──────────→ Reset all tracking
```

All observation recording and MEMORY.md syncs are fire-and-forget — they never block the agent.

📖 Full documentation: [OpenClaw Integration Guide](https://docs.claude-mem.ai/docs/openclaw-integration)

---

## Windows Platform Improvements

- **ProcessManager**: Migrated daemon spawning from deprecated WMIC to PowerShell `Start-Process` with `-WindowStyle Hidden`
- **ChromaSync**: Re-enabled vector search on Windows (was previously disabled entirely)
- **Worker Service**: Added unified DB-ready gate middleware — all DB-dependent endpoints now wait for initialization instead of returning "Database not initialized" errors
- **EnvManager**: Switched from fragile allowlist to simple blocklist for subprocess env vars (only strips `ANTHROPIC_API_KEY` per Issue #733)

## Session Management Fixes

- Fixed unbounded session tracking map growth — maps are now cleaned up on `session_end`
- Session init moved to `session_start` and `after_compaction` hooks for correct lifecycle handling

## SSE Fixes

- Fixed stream URL consistency across the codebase
- Fixed multi-line SSE data frame parsing (concatenates `data:` lines per SSE spec)

## Issue Triage

Closed 37+ duplicate/stale/invalid issues across multiple triage phases, significantly cleaning up the issue tracker.

## [9.1.1] - 2026-02-07

## Critical Bug Fix: Worker Initialization Failure

**v9.1.0 was unable to initialize its database on existing installations.** This patch fixes the root cause and several related issues.

### Bug Fixes

- **Fix FOREIGN KEY constraint failure during migration** — The `addOnUpdateCascadeToForeignKeys` migration (schema v21) crashed when orphaned observations existed (observations whose `memory_session_id` has no matching row in `sdk_sessions`). Fixed by disabling FK checks (`PRAGMA foreign_keys = OFF`) during table recreation, following SQLite's recommended migration pattern.

- **Remove hardcoded CHECK constraints on observation type column** — Multiple locations enforced `CHECK(type IN ('decision', 'bugfix', ...))` but the mode system (v8.0.0+) allows custom observation types, causing constraint violations. Removed all 5 occurrences across `SessionStore.ts`, `migrations.ts`, and `migrations/runner.ts`.

- **Fix Express middleware ordering for initialization guard** — The `/api/*` guard middleware that waits for DB initialization was registered AFTER routes, so Express matched routes before the guard. Moved guard middleware registration BEFORE route registrations. Added dedicated early handler for `/api/context/inject` to fail-open during init.

### New

- **Restored mem-search skill** — Recreated `plugin/skills/mem-search/SKILL.md` with the 3-layer workflow (search → timeline → batch fetch) updated for the current MCP tool set.

## [9.1.0] - 2026-02-07

100 open PRs reviewed, triaged, and resolved. 157 commits, 123 files changed, +6,104/-721 lines. This release focuses on stability, security, and community contributions.

### Highlights

- **100 PR triage**: Reviewed every open PR — merged 48, cherry-picked 13, closed 39 (stale/duplicate/YAGNI)
- **Fail-open hook architecture**: Hooks no longer block Claude Code prompts when the worker is starting up
- **DB initialization guard**: All API endpoints now wait for database initialization instead of crashing with "Database not initialized"
- **Security hardening**: CORS restricted to localhost, XSS defense-in-depth via DOMPurify
- **3 new features**: Manual memory save, project exclusion, folder exclude setting

---

### Security

- **CORS restricted to localhost** — Worker API no longer accepts cross-origin requests from arbitrary websites. Only localhost/127.0.0.1 origins allowed. (PR #917 by @Spunky84)
- **XSS defense-in-depth** — Added DOMPurify sanitization to TerminalPreview.tsx viewer component (concept from PR #896)

### New Features

- **Manual memory storage** — New \`save_memory\` MCP tool and \`POST /api/memory/save\` endpoint for explicit memory capture (PR #662 by @darconada, closes #645)
- **Project exclusion setting** — \`CLAUDE_MEM_EXCLUDED_PROJECTS\` glob patterns to exclude entire projects from tracking (PR #920 by @Spunky84)
- **Folder exclude setting** — \`CLAUDE_MEM_FOLDER_MD_EXCLUDE\` JSON array to exclude paths from CLAUDE.md generation, fixing Xcode/drizzle build conflicts (PR #699 by @leepokai, closes #620)
- **Folder CLAUDE.md opt-in** — \`CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED\` now defaults to \`false\` (opt-in) instead of always-on (PR #913 by @superbiche)
- **Generate/clean CLI commands** — \`generate\` and \`clean\` commands for CLAUDE.md management with \`--dry-run\` support (PR #657 by @thedotmack)
- **Ragtime email investigation** — Batch processor for email investigation workflows (PR #863 by @thedotmack)

### Hook Resilience (Fail-Open Architecture)

Hooks no longer block Claude Code when the worker is unavailable or slow:

- **Graceful hook failures** — Hooks exit 0 with empty responses instead of crashing with exit 2 (PR #973 by @farikh)
- **Fail-open context injection** — Returns empty context during initialization instead of 503 (PR #959 by @rodboev)
- **Fetch timeouts** — All hook fetch calls have timeouts via \`fetchWithTimeout()\` helper (PR #964 by @rodboev)
- **Removed stale user-message hook** — Eliminated startup error from incorrectly bundled hook (PR #960 by @rodboev)
- **DB initialization middleware** — All \`/api/*\` routes now wait for DB init with 30s timeout instead of crashing

### Windows Stability

- **Path spaces fix** — bun-runner.js no longer fails for Windows usernames with spaces (PR #972 by @farikh)
- **Spawn guard** — 2-minute cooldown prevents repeated worker popup windows on startup failure

### Process & Zombie Management

- **Daemon children cleanup** — Orphan reaper now catches idle daemon child processes (PR #879 by @boaz-robopet)
- **Expanded orphan cleanup** — Startup cleanup now targets mcp-server.cjs and worker-service.cjs processes
- **Session-complete hook** — New Stop phase 2 hook removes sessions from active map, enabling effective orphan reaper cleanup (PR #844 by @thusdigital, fixes #842)

### Session Management

- **Prompt-too-long termination** — Sessions terminate cleanly instead of infinite retry loops (PR #934 by @jayvenn21)
- **Infinite restart prevention** — Max 3 restart attempts with exponential backoff, prevents runaway API costs (PR #693 by @ajbmachon)
- **Orphaned message fallback** — Messages from terminated sessions drain via Gemini/OpenRouter fallback (PR #937 by @jayvenn21, fixes #936)
- **Project field backfill** — Sessions correctly scoped when PostToolUse creates session before UserPromptSubmit (PR #940 by @miclip)
- **Provider-aware recovery** — Startup recovery uses correct provider instead of hardcoding SDKAgent (PR #741 by @licutis)
- **AbortController reset** — Prevents infinite "Generator aborted" loops after session abort (PR #627 by @TranslateMe)
- **Stateless provider IDs** — Synthetic memorySessionId generation for Gemini/OpenRouter (concept from PR #615 by @JiehoonKwak)
- **Duplicate generator prevention** — Legacy init endpoint uses idempotent \`ensureGeneratorRunning()\` (PR #932 by @jayvenn21)
- **DB readiness wait** — Session-init endpoint waits for database initialization (PR #828 by @rajivsinclair)
- **Image-only prompt support** — Empty/media prompts use \`[media prompt]\` placeholder (concept from PR #928 by @iammike)

### CLAUDE.md Path & Generation

- **Race condition fix** — Two-pass detection prevents corruption when Claude Code edits CLAUDE.md (concept from PR #974 by @cheapsteak)
- **Duplicate path prevention** — Detects \`frontend/frontend/\` style nested duplicates (concept from PR #836 by @Glucksberg)
- **Unsafe directory exclusion** — Blocks generation in \`res/\`, \`.git/\`, \`build/\`, \`node_modules/\`, \`__pycache__/\` (concept from PR #929 by @jayvenn21)

### Chroma/Vector Search

- **ID/metadata alignment fix** — Search results no longer misaligned after deduplication (PR #887 by @abkrim)
- **Transport zombie prevention** — Connection error handlers now close transport (PR #769 by @jenyapoyarkov)
- **Zscaler SSL support** — Enterprise environments with SSL inspection now work via combined cert path (PR #884 by @RClark4958)

### Parser & Config

- **Nested XML tag handling** — Parser correctly extracts fields with nested XML content (PR #835 by @Glucksberg)
- **Graceful empty transcripts** — Transcript parser returns empty string instead of crashing (PR #862 by @DennisHartrampf)
- **Gemini model name fix** — Corrected \`gemini-3-flash\` → \`gemini-3-flash-preview\` (PR #831 by @Glucksberg)
- **CLAUDE_CONFIG_DIR support** — Plugin paths respect custom config directory (PR #634 by @Kuroakira, fixes #626)
- **Env var priority** — \`env > file > defaults\` ordering via \`applyEnvOverrides()\` (PR #712 by @cjpeterein)
- **Minimum Bun version check** — smart-install.js enforces Bun 1.1.14+ (PR #524 by @quicktime, fixes #519)
- **Stdin timeout** — JSON self-delimiting detection with 30s safety timeout prevents hook hangs (PR #771 by @rajivsinclair, fixes #727)
- **FK constraint prevention** — \`ensureMemorySessionIdRegistered()\` guard + \`ON UPDATE CASCADE\` schema migration (PR #889 by @Et9797, fixes #846)
- **Cursor bun runtime** — Cursor hooks use bun instead of node, fixing bun:sqlite crashes (PR #721 by @polux0)

### Documentation

- **9 README PRs merged**: formatting fixes, Korean/Japanese/Chinese render fixes, documentation link updates, Traditional Chinese + Urdu translations (PRs #953, #898, #864, #637, #636, #894, #907, #691 by @Leonard013, @youngsu5582, @eltociear, @WuMingDao, @fengluodb, @PeterDaveHello, @yasirali646)
- **Windows setup note** — npm PATH instructions (PR #919 by @kamran-khalid-v9)
- **Issue templates** — Duplicate check checkbox added (PR #970 by @bmccann36)

### Community Contributors

Thank you to the 35+ contributors whose PRs were reviewed in this release:

@Spunky84, @farikh, @rodboev, @boaz-robopet, @jayvenn21, @ajbmachon, @miclip, @licutis, @TranslateMe, @JiehoonKwak, @rajivsinclair, @iammike, @cheapsteak, @Glucksberg, @abkrim, @jenyapoyarkov, @RClark4958, @DennisHartrampf, @Kuroakira, @cjpeterein, @quicktime, @polux0, @Et9797, @thusdigital, @superbiche, @darconada, @leepokai, @Leonard013, @youngsu5582, @eltociear, @WuMingDao, @fengluodb, @PeterDaveHello, @yasirali646, @kamran-khalid-v9, @bmccann36

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v9.0.17...v9.1.0

## [9.0.17] - 2026-02-05

## Bug Fixes

### Fix Fresh Install Bun PATH Resolution (#818)

On fresh installations, hooks would fail because Bun wasn't in PATH until terminal restart. The `smart-install.js` script installs Bun to `~/.bun/bin/bun`, but the current shell session doesn't have it in PATH.

**Fix:** Introduced `bun-runner.js` — a Node.js wrapper that searches common Bun installation locations across all platforms:
- PATH (via `which`/`where`)
- `~/.bun/bin/bun` (default install location)
- `/usr/local/bin/bun`
- `/opt/homebrew/bin/bun` (macOS Homebrew)
- `/home/linuxbrew/.linuxbrew/bin/bun` (Linuxbrew)
- Windows: `%LOCALAPPDATA%\bun` or fallback paths

All 9 hook definitions updated to use `node bun-runner.js` instead of direct `bun` calls.

**Files changed:**
- `plugin/scripts/bun-runner.js` — New 88-line Bun discovery script
- `plugin/hooks/hooks.json` — All hook commands now route through bun-runner

Fixes #818 | PR #827 by @bigphoot

## [9.0.16] - 2026-02-05

## Bug Fixes

### Fix Worker Startup Timeout (#811, #772, #729)

Resolves the "Worker did not become ready within 15 seconds" timeout error that could prevent hooks from communicating with the worker service.

**Root cause:** `isWorkerHealthy()` and `waitForHealth()` were checking `/api/readiness`, which returns 503 until full initialization completes — including MCP connection setup that can take 5+ minutes. Hooks only have a 15-second timeout window.

**Fix:** Switched to `/api/health` (liveness check), which returns 200 as soon as the HTTP server is listening. This is sufficient for hook communication since the worker accepts requests while background initialization continues.

**Files changed:**
- `src/shared/worker-utils.ts` — `isWorkerHealthy()` now checks `/api/health`
- `src/services/infrastructure/HealthMonitor.ts` — `waitForHealth()` now checks `/api/health`
- `tests/infrastructure/health-monitor.test.ts` — Updated test expectations

### PR Merge Tasks
- PR #820 merged with full verification pipeline (rebase, code review, build verification, test, manual verification)

## [9.0.15] - 2026-02-05

## Security Fix

### Isolated Credentials (#745)
- **Prevents API key hijacking** from random project `.env` files
- Credentials now sourced exclusively from `~/.claude-mem/.env`
- Only whitelisted environment variables passed to SDK `query()` calls
- Authentication method logging shows whether using Claude Code CLI subscription billing or explicit API key

This is a security-focused patch release that hardens credential handling to prevent unintended API key usage from project directories.

## [9.0.14] - 2026-02-05

## In-Process Worker Architecture

This release includes the merged in-process worker architecture from PR #722, which fundamentally improves how hooks interact with the worker service.

### Changes

- **In-process worker architecture** - Hook processes now become the worker when port 37777 is available, eliminating Windows spawn issues
- **Hook command improvements** - Added `skipExit` option to `hook-command.ts` for chained command execution
- **Worker health checks** - `worker-utils.ts` now returns boolean status for cleaner health monitoring
- **Massive CLAUDE.md cleanup** - Removed 76 redundant documentation files (4,493 lines removed)
- **Chained hook configuration** - `hooks.json` now supports chained commands for complex workflows

### Technical Details

The in-process architecture means hooks no longer need to spawn separate worker processes. When port 37777 is available, the hook itself becomes the worker, providing:
- Faster startup times
- Better resource utilization
- Elimination of process spawn failures on Windows

Full PR: https://github.com/thedotmack/claude-mem/pull/722

## [9.0.13] - 2026-02-05

## Bug Fixes

### Zombie Observer Prevention (#856)

Fixed a critical issue where observer processes could become "zombies" - lingering indefinitely without activity. This release adds:

- **3-minute idle timeout**: SessionQueueProcessor now automatically terminates after 3 minutes of inactivity
- **Race condition fix**: Resolved spurious wakeup issues by resetting `lastActivityTime` on queue activity
- **Comprehensive test coverage**: Added 11 new tests for the idle timeout mechanism

This fix prevents resource leaks from orphaned observer processes that could accumulate over time.

## [9.0.12] - 2026-01-28

## Fix: Authentication failure from observer session isolation

**Critical bugfix** for users who upgraded to v9.0.11.

### Problem

v9.0.11 introduced observer session isolation using `CLAUDE_CONFIG_DIR` override, which inadvertently broke authentication:

```
Invalid API key · Please run /login
```

This happened because Claude Code stores credentials in the config directory, and overriding it prevented access to existing auth tokens.

### Solution

Observer sessions now use the SDK's `cwd` option instead:
- Sessions stored under `~/.claude-mem/observer-sessions/` project
- Auth credentials in `~/.claude/` remain accessible
- Observer sessions still won't pollute `claude --resume` lists

### Affected Users

Anyone running v9.0.11 who saw "Invalid API key" errors should upgrade immediately.

## [9.0.11] - 2026-01-28

## Bug Fixes

### Observer Session Isolation (#837)
Observer sessions created by claude-mem were polluting the `claude --resume` list, cluttering it with internal plugin sessions that users never intend to resume. In one user's case, 74 observer sessions out of ~220 total (34% noise).

**Solution**: Observer processes now use a dedicated config directory (`~/.claude-mem/observer-config/`) to isolate their session files from user sessions.

Thanks to @Glucksberg for this fix! Fixes #832.

### Stale memory_session_id Crash Prevention (#839)
After a worker restart, stale `memory_session_id` values in the database could cause crashes when attempting to resume SDK conversations. The existing guard didn't protect against this because session data was loaded from the database.

**Solution**: Clear `memory_session_id` when loading sessions from the database (not from cache). The key insight: if a session isn't in memory, any database `memory_session_id` is definitely stale.

Thanks to @bigph00t for this fix! Fixes #817.

---
**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v9.0.10...v9.0.11

## [9.0.10] - 2026-01-26

## Bug Fix

**Fixed path format mismatch causing folder CLAUDE.md files to show "No recent activity" (#794)** - Thanks @bigph00t!

The folder-level CLAUDE.md generation was failing to find observations due to a path format mismatch between how API queries used absolute paths and how the database stored relative paths. The `isDirectChild()` function's simple prefix match always returned false in these cases.

**Root cause:** PR #809 (v9.0.9) only masked this bug by skipping file creation when "no activity" was detected. Since ALL folders were affected, this prevented file creation entirely. This PR provides the actual fix.

**Changes:**
- Added new shared module `src/shared/path-utils.ts` with robust path normalization and matching utilities
- Updated `SessionSearch.ts`, `regenerate-claude-md.ts`, and `claude-md-utils.ts` to use shared path utilities
- Added comprehensive test coverage (61 new tests) for path matching edge cases

## [9.0.9] - 2026-01-26

## Bug Fixes

### Prevent Creation of Empty CLAUDE.md Files (#809)

Previously, claude-mem would create new `CLAUDE.md` files in project directories even when there was no activity to display, cluttering codebases with empty context files showing only "*No recent activity*".

**What changed:** The `updateFolderClaudeMdFiles` function now checks if the formatted content contains no activity before writing. If a `CLAUDE.md` file doesn't already exist and there's nothing to show, it will be skipped entirely. Existing files will still be updated to reflect "No recent activity" if that's the current state.

**Impact:** Cleaner project directories - only folders with actual activity will have `CLAUDE.md` context files created.

Thanks to @maxmillienjr for this contribution!

## [9.0.8] - 2026-01-26

## Fix: Prevent Zombie Process Accumulation (Issue #737)

This release fixes a critical issue where Claude haiku subprocesses spawned by the SDK weren't terminating properly, causing zombie process accumulation. One user reported 155 processes consuming 51GB RAM.

### Root Causes Addressed
- SDK's SpawnedProcess interface hides subprocess PIDs
- `deleteSession()` didn't verify subprocess exit
- `abort()` was fire-and-forget with no confirmation
- No mechanism to track or clean up orphaned processes

### Solution
- **ProcessRegistry module**: Tracks spawned Claude subprocesses via PID
- **Custom spawn**: Uses SDK's `spawnClaudeCodeProcess` option to capture PIDs
- **Signal propagation**: Passes signal parameter to enable AbortController integration
- **Graceful shutdown**: Waits for subprocess exit in `deleteSession()` with 5s timeout
- **SIGKILL escalation**: Force-kills processes that don't exit gracefully
- **Orphan reaper**: Safety net running every 5 minutes to clean up any missed processes
- **Race detection**: Warns about multiple processes per session (race condition indicator)

### Files Changed
- `src/services/worker/ProcessRegistry.ts` (new): PID registry and reaper
- `src/services/worker/SDKAgent.ts`: Use custom spawn to capture PIDs
- `src/services/worker/SessionManager.ts`: Verify subprocess exit on delete
- `src/services/worker-service.ts`: Start/stop orphan reaper

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v9.0.7...v9.0.8

Fixes #737

## [9.0.6] - 2026-01-22

## Windows Console Popup Fix

This release eliminates the annoying console window popups that Windows users experienced when claude-mem spawned background processes.

### Fixed
- **Windows console popups eliminated** - Daemon spawn and Chroma operations no longer create visible console windows (#748, #708, #681, #676)
- **Race condition in PID file writing** - Worker now writes its own PID file after listen() succeeds, ensuring reliable process tracking on all platforms

### Changed
- **Chroma temporarily disabled on Windows** - Vector search is disabled on Windows while we migrate to a popup-free architecture. Keyword search and all other memory features continue to work. A follow-up release will re-enable Chroma.
- **Slash command discoverability** - Added YAML frontmatter to `/do` and `/make-plan` commands

### Technical Details
- Uses WMIC for detached process spawning on Windows
- PID file location unchanged, but now written by worker process
- Cross-platform: Linux/macOS behavior unchanged

### Contributors
- @bigph00t (Alexander Knigge)

## [9.0.5] - 2026-01-14

## Major Worker Service Cleanup

This release contains a significant refactoring of `worker-service.ts`, removing ~216 lines of dead code and simplifying the architecture.

### Refactoring
- **Removed dead code**: Deleted `runInteractiveSetup` function (defined but never called)
- **Cleaned up imports**: Removed unused imports (fs namespace, spawn, homedir, readline, existsSync, writeFileSync, readFileSync, mkdirSync)
- **Removed fallback agent concept**: Users who choose Gemini/OpenRouter now get those providers directly without hidden fallback behavior
- **Eliminated re-export indirection**: ResponseProcessor now imports directly from CursorHooksInstaller instead of through worker-service

### Security Fix
- **Removed dangerous ANTHROPIC_API_KEY check**: Claude Code uses CLI authentication, not direct API calls. The previous check could accidentally use a user's API key (from other projects) which costs 20x more than Claude Code's pricing

### Build Improvements
- **Dynamic MCP version management**: MCP server and client versions now use build-time injected values from package.json instead of hardcoded strings, ensuring version synchronization

### Documentation
- Added Anti-Pattern Czar Generalization Analysis report
- Updated README with $CMEM links and contract address
- Added comprehensive cleanup and validation plans for worker-service.ts

## [9.0.4] - 2026-01-10

## What's New

This release adds the `/do` and `/make-plan` development commands to the plugin distribution, making them available to all users who install the plugin from the marketplace.

### Features

- **Development Commands Now Distributed with Plugin** (#666)
  - `/do` command - Execute tasks with structured workflow
  - `/make-plan` command - Create detailed implementation plans
  - Commands now available at `plugin/commands/` for all users

### Documentation

- Revised Arabic README for clarity and corrections (#661)

### Full Changelog

https://github.com/thedotmack/claude-mem/compare/v9.0.3...v9.0.4

## [9.0.3] - 2026-01-10

## Bug Fixes

### Hook Framework JSON Status Output (#655)

Fixed an issue where the worker service startup wasn't producing proper JSON status output for the Claude Code hook framework. This caused hooks to appear stuck or unresponsive during worker initialization.

**Changes:**
- Added `buildStatusOutput()` function for generating structured JSON status output
- Worker now outputs JSON with `status`, `message`, and `continue` fields on stdout
- Proper exit code 0 ensures Windows Terminal compatibility (no tab accumulation)
- `continue: true` flag ensures Claude Code continues processing after hook execution

**Technical Details:**
- Extracted status output generation into a pure, testable function
- Added comprehensive test coverage in `tests/infrastructure/worker-json-status.test.ts`
- 23 passing tests covering unit, CLI integration, and hook framework compatibility

## Housekeeping

- Removed obsolete error handling baseline file

## [9.0.2] - 2026-01-10

## Bug Fixes

- **Windows Terminal Tab Accumulation (#625, #628)**: Fixed terminal tab accumulation on Windows by implementing graceful exit strategy. All expected failure scenarios (port conflicts, version mismatches, health check timeouts) now exit with code 0 instead of code 1.
- **Windows 11 Compatibility (#625)**: Replaced deprecated WMIC commands with PowerShell `Get-Process` and `Get-CimInstance` for process enumeration. WMIC is being removed from Windows 11.

## Maintenance

- **Removed Obsolete CLAUDE.md Files**: Cleaned up auto-generated CLAUDE.md files from `~/.claude/plans/` and `~/.claude/plugins/marketplaces/` directories.

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v9.0.1...v9.0.2

## [9.0.1] - 2026-01-08

## Bug Fixes

### Claude Code 2.1.1 Compatibility
- Fixed hook architecture for compatibility with Claude Code 2.1.0/2.1.1
- Context is now injected silently via SessionStart hook
- Removed deprecated `user-message-hook` (no longer used in CC 2.1.0+)

### Path Validation for CLAUDE.md Distribution
- Added `isValidPathForClaudeMd()` to reject malformed paths:
  - Tilde paths (`~`) that Node.js doesn't expand
  - URLs (`http://`, `https://`)
  - Paths with spaces (likely command text or PR references)
  - Paths with `#` (GitHub issue/PR references)
  - Relative paths that escape project boundary
- Cleaned up 12 invalid CLAUDE.md files created by bug artifacts
- Updated `.gitignore` to prevent future accidents

### Log-Level Audit
- Promoted 38+ WARN messages to ERROR level for improved debugging:
  - Parser: observation type errors, data contamination
  - SDK/Agents: empty init responses (Gemini, OpenRouter)
  - Worker/Queue: session recovery, auto-recovery failures
  - Chroma: sync failures, search failures
  - SQLite: search failures
  - Session/Generator: failures, missing context
  - Infrastructure: shutdown, process management failures

## Internal Changes
- Removed hardcoded fake token counts from context injection
- Standardized Claude Code 2.1.0 note wording across documentation

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v9.0.0...v9.0.1

## [9.0.0] - 2026-01-06

## 🚀 Live Context System

Version 9.0.0 introduces the **Live Context System** - a major new capability that provides folder-level activity context through auto-generated CLAUDE.md files.

### ✨ New Features

#### Live Context System
- **Folder CLAUDE.md Files**: Each directory now gets an auto-generated CLAUDE.md file containing a chronological timeline of recent development activity
- **Activity Timelines**: Tables show observation ID, time, type, title, and estimated token cost for relevant work in each folder
- **Worktree Support**: Proper detection of git worktrees with project-aware filtering to show only relevant observations per worktree
- **Configurable Limits**: Control observation count via `CLAUDE_MEM_CONTEXT_OBSERVATIONS` setting

#### Modular Architecture Refactor
- **Service Layer Decomposition**: Major refactoring from monolithic worker-service to modular domain services
- **SQLite Module Extraction**: Database operations split into dedicated modules (observations, sessions, summaries, prompts, timeline)
- **Context Builder System**: New modular context generation with TimelineRenderer, FooterRenderer, and ObservationCompiler
- **Error Handler Centralization**: Unified Express error handling via ErrorHandler module

#### SDK Agent Improvements
- **Session Resume**: Memory sessions can now resume across Claude conversations using SDK session IDs
- **Memory Session ID Tracking**: Proper separation of content session IDs from memory session IDs
- **Response Processor Refactor**: Cleaner message handling and observation extraction

### 🔧 Improvements

#### Windows Stability
- Fixed Windows PowerShell variable escaping in hook execution
- Improved IPC detection for Windows managed mode
- Better PATH handling for Bun and uv on Windows

#### Settings & Configuration
- **Auto-Creation**: Settings file automatically created with defaults on first run
- **Worker Host Configuration**: `CLAUDE_MEM_WORKER_HOST` setting for custom worker endpoints
- Settings validation with helpful error messages

#### MCP Tools
- Standardized naming: "MCP tools" terminology instead of "mem-search skill"
- Improved tool descriptions for better Claude integration
- Context injection API now supports worktree parameter

### 📚 Documentation
- New **Folder Context Files** documentation page
- **Worktree Support** section explaining git worktree behavior
- Updated architecture documentation reflecting modular refactor
- v9.0 release notes in introduction page

### 🐛 Bug Fixes
- Fixed stale session resume crash when SDK session is orphaned
- Fixed logger serialization bug causing silent ChromaSync failures
- Fixed CLAUDE.md path resolution in worktree environments
- Fixed date preservation in folder timeline generation
- Fixed foreign key constraint issues in observation storage
- Resolved multiple TypeScript type errors across codebase

### 🗑️ Removed
- Deprecated context-generator.ts (functionality moved to modular system)
- Obsolete queue analysis documents
- Legacy worker wrapper scripts

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.5.10...v9.0.0

## [8.5.10] - 2026-01-06

## Bug Fixes

- **#545**: Fixed `formatTool` crash when parsing non-JSON tool inputs (e.g., raw Bash commands)
- **#544**: Fixed terminology in context hints - changed "mem-search skill" to "MCP tools"
- **#557**: Settings file now auto-creates with defaults on first run (no more "module loader" errors)
- **#543**: Fixed hook execution by switching runtime from `node` to `bun` (resolves `bun:sqlite` issues)

## Code Quality

- Fixed circular dependency between Logger and SettingsDefaultsManager
- Added 72 integration tests for critical coverage gaps
- Cleaned up mock-heavy tests causing module cache pollution

## Full Changelog

See PR #558 for complete details and diagnostic reports.

## [8.5.9] - 2026-01-04

## What's New

### Context Header Timestamp

The context injection header now displays the current date and time, making it easier to understand when context was generated.

**Example:** `[claude-mem] recent context, 2026-01-04 2:46am EST`

This appears in both terminal (colored) output and markdown format, including empty state messages.

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.5.8...v8.5.9

## [8.5.8] - 2026-01-04

## Bug Fixes

- **#511**: Add `gemini-3-flash` model to GeminiAgent with proper rate limits and validation
- **#517**: Fix Windows process management by replacing PowerShell with WMIC (fixes Git Bash/WSL compatibility)
- **#527**: Add Apple Silicon Homebrew paths (`/opt/homebrew/bin`) for `bun` and `uv` detection
- **#531**: Remove duplicate type definitions from `export-memories.ts` using shared bridge file

## Tests

- Added regression tests for PR #542 covering Gemini model support, WMIC parsing, Apple Silicon paths, and export type refactoring

## Documentation

- Added detailed analysis reports for GitHub issues #511, #514, #517, #520, #527, #531, #532

## [8.5.7] - 2026-01-04

## Modular Architecture Refactor

This release refactors the monolithic service architecture into focused, single-responsibility modules with comprehensive test coverage.

### Architecture Improvements

- **SQLite Repositories** (`src/services/sqlite/`) - Modular repositories for sessions, observations, prompts, summaries, and timeline
- **Worker Agents** (`src/services/worker/agents/`) - Extracted response processing, error handling, and session cleanup
- **Search Strategies** (`src/services/worker/search/`) - Modular search with Chroma, SQLite, and Hybrid strategies plus orchestrator
- **Context Generation** (`src/services/context/`) - Separated context building, token calculation, formatters, and renderers
- **Infrastructure** (`src/services/infrastructure/`) - Graceful shutdown, health monitoring, and process management
- **Server** (`src/services/server/`) - Express server setup, middleware, and error handling

### Test Coverage

- **595 tests** across 36 test files
- **1,120 expect() assertions**
- Coverage for SQLite repos, worker agents, search, context, infrastructure, and server modules

### Session ID Refactor

- Aligned tests with NULL-based memory session initialization pattern
- Updated `SESSION_ID_ARCHITECTURE.md` documentation

### Other Improvements

- Added missing logger imports to 34 files for better observability
- Updated esbuild and MCP SDK to latest versions
- Removed `bun.lock` from version control

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.5.6...v8.5.7

## [8.5.6] - 2026-01-04

## Major Architectural Refactoring

Decomposes monolithic services into modular, maintainable components:

### Worker Service
Extracted infrastructure (GracefulShutdown, HealthMonitor, ProcessManager), server layer (ErrorHandler, Middleware, Server), and integrations (CursorHooksInstaller)

### Context Generator
Split into ContextBuilder, ContextConfigLoader, ObservationCompiler, TokenCalculator, formatters (Color/Markdown), and section renderers (Header/Footer/Summary/Timeline)

### Search System
Extracted SearchOrchestrator, ResultFormatter, TimelineBuilder, and strategy pattern (Chroma/SQLite/Hybrid search strategies) with dedicated filters (Date/Project/Type)

### Agent System
Extracted shared logic into ResponseProcessor, ObservationBroadcaster, FallbackErrorHandler, and SessionCleanupHelper

### SQLite Layer
Decomposed SessionStore into domain modules (observations, prompts, sessions, summaries, timeline) with proper type exports

## Bug Fixes
- Fixed duplicate observation storage bug (observations stored multiple times when messages were batched)
- Added duplicate observation cleanup script for production database remediation
- Fixed FOREIGN KEY constraint and missing `failed_at_epoch` column issues

## Coming Next
Comprehensive test suite in a new PR, targeting **v8.6.0**

## [8.5.5] - 2026-01-03

## Improved Error Handling and Logging

This patch release enhances error handling and logging across all worker services for better debugging and reliability.

### Changes
- **Enhanced Error Logging**: Improved error context across SessionStore, SearchManager, SDKAgent, GeminiAgent, and OpenRouterAgent
- **SearchManager**: Restored error handling for Chroma calls with improved logging
- **SessionStore**: Enhanced error logging throughout database operations
- **Bug Fix**: Fixed critical bug where `memory_session_id` could incorrectly equal `content_session_id`
- **Hooks**: Streamlined error handling and loading states for better maintainability

### Investigation Reports
- Added detailed analysis documents for generator failures and observation duplication regressions

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.5.4...v8.5.5

## [8.5.4] - 2026-01-02

## Bug Fixes

### Chroma Connection Error Handling
Fixed a critical bug in ChromaSync where connection-related errors were misinterpreted as missing collections. The `ensureCollection()` method previously caught ALL errors and assumed they meant the collection doesn't exist, which caused connection errors to trigger unnecessary collection creation attempts. Now connection-related errors like "Not connected" are properly distinguished and re-thrown immediately, preventing false error handling paths and inappropriate fallback behavior.

### Removed Dead last_user_message Code
Cleaned up dead code related to `last_user_message` handling in the summary flow. This field was being extracted from transcripts but never used anywhere - in Claude Code transcripts, "user" type messages are mostly tool_results rather than actual user input, and the user's original request is already stored in the user_prompts table. Removing this unused field eliminates confusing warnings like "Missing last_user_message when queueing summary". Changes span summary-hook, SessionRoutes, SessionManager, interface definitions, and all agent implementations.

## Improvements

### Enhanced Error Handling Across Services
Comprehensive improvement to error handling across 8 core services:
- **BranchManager** - Now logs recovery checkout failures
- **PaginationHelper** - Logs when file paths are plain strings instead of valid JSON
- **SDKAgent** - Enhanced logging for Claude executable detection failures
- **SearchManager** - Logs plain string handling for files read and edited
- **paths.ts** - Improved logging for git root detection failures
- **timeline-formatting** - Enhanced JSON parsing errors with input previews
- **transcript-parser** - Logs summary of parse errors after processing
- **ChromaSync** - Logs full error context before attempting collection creation

### Error Handling Documentation & Tooling
- Created `error-handling-baseline.txt` establishing baseline error handling practices
- Documented error handling anti-pattern rules in CLAUDE.md
- Added `detect-error-handling-antipatterns.ts` script to identify empty catch blocks, improper logging practices, and oversized try-catch blocks

## New Features

### Console Filter Bar with Log Parsing
Implemented interactive log filtering in the viewer UI:
- **Structured Log Parsing** - Extracts timestamp, level, component, correlation ID, and message content using regex pattern matching
- **Level Filtering** - Toggle visibility for DEBUG, INFO, WARN, ERROR log levels
- **Component Filtering** - Filter by 9 component types: HOOK, WORKER, SDK, PARSER, DB, SYSTEM, HTTP, SESSION, CHROMA
- **Color-Coded Rendering** - Visual distinction with component-specific icons and log level colors
- **Special Message Detection** - Recognizes markers like → (dataIn), ← (dataOut), ✓ (success), ✗ (failure), ⏱ (timing), [HAPPY-PATH]
- **Smart Auto-Scroll** - Maintains scroll position when reviewing older logs
- **Responsive Design** - Filter bar adapts to smaller screens

## [8.5.3] - 2026-01-02

# 🛡️ Error Handling Hardening & Developer Tools

Version 8.5.3 introduces comprehensive error handling improvements that prevent silent failures and reduce debugging time from hours to minutes. This release also adds new developer tools for queue management and log monitoring.

---

## 🔴 Critical Error Handling Improvements

### The Problem
A single overly-broad try-catch block caused a **10-hour debugging session** by silently swallowing errors. This pattern was pervasive throughout the codebase, creating invisible failure modes.

### The Solution

**Automated Anti-Pattern Detection** (`scripts/detect-error-handling-antipatterns.ts`)
- Detects 7 categories of error handling anti-patterns
- Enforces zero-tolerance policy for empty catch blocks
- Identifies large try-catch blocks (>10 lines) that mask specific errors
- Flags missing error logging that causes silent failures
- Supports approved overrides with justification comments
- Exit code 1 if critical issues detected (enforceable in CI)

**New Error Handling Standards** (Added to `CLAUDE.md`)
- **5-Question Pre-Flight Checklist**: Required before writing any try-catch
  1. What SPECIFIC error am I catching?
  2. Show documentation proving this error can occur
  3. Why can't this error be prevented?
  4. What will the catch block DO?
  5. Why shouldn't this error propagate?
- **Forbidden Patterns**: Empty catch, catch without logging, large try blocks, promise catch without handlers
- **Allowed Patterns**: Specific errors, logged failures, minimal scope, explicit recovery
- **Meta-Rule**: Uncertainty triggers research, NOT try-catch

### Fixes Applied

**Wave 1: Empty Catch Blocks** (5 files)
- `import-xml-observations.ts` - Log skipped invalid JSON
- `bun-path.ts` - Log when bun not in PATH
- `cursor-utils.ts` - Log failed registry reads & corrupt MCP config
- `worker-utils.ts` - Log failed health checks

**Wave 2: Promise Catches on Critical Paths** (8 locations)
- `worker-service.ts` - Background initialization failures
- `SDKAgent.ts` - Session processor errors (2 locations)
- `GeminiAgent.ts` - Finalization failures (2 locations)
- `OpenRouterAgent.ts` - Finalization failures (2 locations)
- `SessionManager.ts` - Generator promise failures

**Wave 3: Comprehensive Audit** (29 catch blocks)
- Added logging to 16 catch blocks (UI, servers, worker, routes, services)
- Documented 13 intentional exceptions with justification comments
- All patterns now follow error handling guidelines with appropriate log levels

### Approved Override System

For justified exceptions (performance-critical paths, expected failures), use:
```typescript
// [APPROVED OVERRIDE]: Brief technical justification
try {
  // code
} catch {
  // allowed exception
}
```

**Progress**: 163 anti-patterns → 26 approved overrides (84% reduction in silent failures)

---

## 🗂️ Queue Management Features

**New Commands**
- `npm run queue:clear` - Interactive removal of failed messages
- `npm run queue:clear -- --all` - Clear all messages (pending, processing, failed)
- `npm run queue:clear -- --force` - Non-interactive mode

**HTTP API Endpoints**
- `DELETE /api/pending-queue/failed` - Remove failed messages
- `DELETE /api/pending-queue/all` - Complete queue reset

Failed messages exceed max retry count and remain for debugging. These commands provide clean queue maintenance.

---

## 🪵 Developer Console (Chrome DevTools Style)

**UI Improvements**
- Bottom drawer console (slides up from bottom-left corner)
- Draggable resize handle for height adjustment
- Auto-refresh toggle (2s interval)
- Clear logs button with confirmation
- Monospace font (SF Mono/Monaco/Consolas)
- Minimum height: 150px, adjustable to window height - 100px

**API Endpoints**
- `GET /api/logs` - Fetch last 1000 lines of current day's log
- `DELETE /api/logs` - Clear current log file

Logs viewer accessible via floating console button in UI.

---

## 📚 Architecture Documentation

**Session ID Architecture** (`docs/SESSION_ID_ARCHITECTURE.md`)
- Comprehensive documentation of 1:1 session mapping guarantees
- 19 validation tests proving UNIQUE constraints and resume consistency
- Documents single-transition vulnerability (application-level enforcement)
- Complete reference for session lifecycle management

---

## 📊 Impact Summary

- **Debugging Time**: 10 hours → minutes (proper error visibility)
- **Test Coverage**: +19 critical architecture validation tests
- **Silent Failures**: 84% reduction (163 → 26 approved exceptions)
- **Protection**: Automated detection prevents regression
- **Developer UX**: Console logs, queue management, comprehensive docs

---

## 🔧 Technical Details

**Files Changed**: 25+ files across error handling, queue management, UI, and documentation

**Critical Path Protection**
These files now have strict error propagation (no catch-and-continue):
- `SDKAgent.ts`
- `GeminiAgent.ts`
- `OpenRouterAgent.ts`
- `SessionStore.ts`
- `worker-service.ts`

**Build Verification**: All changes tested, build successful

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.5.2...v8.5.3

## [8.5.2] - 2025-12-31

## Bug Fixes

### Fixed SDK Agent Memory Leak (#499)

Fixed a critical memory leak where Claude SDK child processes were never terminated after sessions completed. Over extended usage, this caused hundreds of orphaned processes consuming 40GB+ of RAM.

**Root Cause:**
- When the SDK agent generator completed naturally (no more messages to process), the `AbortController` was never aborted
- Child processes spawned by the Agent SDK remained running indefinitely
- Sessions stayed in memory (by design for future events) but underlying processes were never cleaned up

**Fix:**
- Added proper cleanup to SessionRoutes finally block
- Now calls `abortController.abort()` when generator completes with no pending work
- Creates new `AbortController` when crash recovery restarts generators
- Ensures cleanup happens even if recovery logic fails

**Impact:**
- Prevents orphaned `claude` processes from accumulating
- Eliminates multi-gigabyte memory leaks during normal usage
- Maintains crash recovery functionality with proper resource cleanup

Thanks to @yonnock for the detailed bug report and investigation in #499!

## [8.5.1] - 2025-12-30

## Bug Fix

**Fixed**: Migration 17 column rename failing for databases in intermediate states (#481)

### Problem
Migration 17 renamed session ID columns but used a single check to determine if ALL tables were migrated. This caused errors for databases in partial migration states:
- `no such column: sdk_session_id` (when columns already renamed)
- `table observations has no column named memory_session_id` (when not renamed)

### Solution
- Rewrote migration 17 to check **each table individually** before renaming
- Added `safeRenameColumn()` helper that handles all edge cases gracefully
- Handles all database states: fresh, old, and partially migrated

### Who was affected
- Users upgrading from pre-v8.2.6 versions
- Users whose migration was interrupted (crash, restart, etc.)
- Users who restored database from backup

## [8.5.0] - 2025-12-30

# Cursor Support Now Available 🎉

This is a major release introducing **full Cursor IDE support**. Claude-mem now works with Cursor, bringing persistent AI memory to Cursor users with or without a Claude Code subscription.

## Highlights

**Give Cursor persistent memory.** Every Cursor session starts fresh - your AI doesn't remember what it worked on yesterday. Claude-mem changes that. Your agent builds cumulative knowledge about your codebase, decisions, and patterns over time.

### Works Without Claude Code

You can now use claude-mem with Cursor using free AI providers:
- **Gemini** (recommended): 1,500 free requests/day, no credit card required
- **OpenRouter**: Access to 100+ models including free options
- **Claude SDK**: For Claude Code subscribers

### Cross-Platform Support

Full support for all major platforms:
- **macOS**: Bash scripts with `jq` and `curl`
- **Linux**: Same toolchain as macOS
- **Windows**: Native PowerShell scripts, no WSL required

## New Features

### Interactive Setup Wizard (`bun run cursor:setup`)
A guided installer that:
- Detects your environment (Claude Code present or not)
- Helps you choose and configure an AI provider
- Installs Cursor hooks automatically
- Starts the worker service
- Verifies everything is working

### Cursor Lifecycle Hooks
Complete hook integration with Cursor's native hook system:
- `session-init.sh/.ps1` - Session start with context injection
- `user-message.sh/.ps1` - User prompt capture
- `save-observation.sh/.ps1` - Tool usage logging
- `save-file-edit.sh/.ps1` - File edit tracking
- `session-summary.sh/.ps1` - Session end summary
- `context-inject.sh/.ps1` - Load relevant history

### Context Injection via `.cursor/rules`
Relevant past context is automatically injected into Cursor sessions via the `.cursor/rules/claude-mem-context.mdc` file, giving your AI immediate awareness of prior work.

### Project Registry
Multi-project support with automatic project detection:
- Projects registered in `~/.claude-mem/cursor-projects.json`
- Context automatically scoped to current project
- Works across multiple workspaces simultaneously

### MCP Search Tools
Full MCP server integration for Cursor:
- `search` - Find observations by query, date, type
- `timeline` - Get context around specific observations
- `get_observations` - Fetch full details for filtered IDs

## New Commands

| Command | Description |
|---------|-------------|
| `bun run cursor:setup` | Interactive setup wizard |
| `bun run cursor:install` | Install Cursor hooks |
| `bun run cursor:uninstall` | Remove Cursor hooks |
| `bun run cursor:status` | Check hook installation status |

## Documentation

Full documentation available at [docs.claude-mem.ai/cursor](https://docs.claude-mem.ai/cursor):
- Cursor Integration Overview
- Gemini Setup Guide (free tier)
- OpenRouter Setup Guide
- Troubleshooting

## Getting Started

### For Cursor-Only Users (No Claude Code)

```bash
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem && bun install && bun run build
bun run cursor:setup
```

### For Claude Code Users

```bash
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem
claude-mem cursor install
```

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.2.10...v8.5.0

## [8.2.10] - 2025-12-30

## Bug Fixes

- **Auto-restart worker on version mismatch** (#484): When the plugin updates but the worker was already running on the old version, the worker now automatically restarts instead of failing with 400 errors.

### Changes
- `/api/version` endpoint now returns the built-in version (compiled at build time) instead of reading from disk
- `worker-service start` command checks for version mismatch and auto-restarts if needed
- Downgraded hook version mismatch warning to debug logging (now handled by auto-restart)

Thanks @yungweng for the detailed bug report!

## [8.2.9] - 2025-12-29

## Bug Fixes

- **Worker Service**: Remove file-based locking and improve Windows stability
  - Replaced file-based locking with health-check-first approach for cleaner mutual exclusion
  - Removed AbortSignal.timeout() calls to reduce Bun libuv assertion errors on Windows
  - Added 500ms shutdown delays on Windows to prevent zombie ports
  - Reduced hook timeout values for improved responsiveness
  - Increased worker readiness polling duration from 5s to 15s

## Internal Changes

- Updated worker CLI scripts to reference worker-service.cjs directly
- Simplified hook command configurations

## [8.2.8] - 2025-12-29

## Bug Fixes

- Fixed orphaned chroma-mcp processes during shutdown (#489)
  - Added graceful shutdown handling with signal handlers registered early in WorkerService lifecycle
  - Ensures ChromaSync subprocess cleanup even when interrupted during initialization
  - Removes PID file during shutdown to prevent stale process tracking

## Technical Details

This patch release addresses a race condition where SIGTERM/SIGINT signals arriving during ChromaSync initialization could leave orphaned chroma-mcp processes. The fix moves signal handler registration from the start() method to the constructor, ensuring cleanup handlers exist throughout the entire initialization lifecycle.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.2.7...v8.2.8

## [8.2.7] - 2025-12-29

## What's Changed

### Token Optimizations
- Simplified MCP server tool definitions for reduced token usage
- Removed outdated troubleshooting and mem-search skill documentation
- Enhanced search parameter descriptions for better clarity
- Streamlined MCP workflows for improved efficiency

This release significantly reduces the token footprint of the plugin's MCP tools and documentation.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.2.6...v8.2.7

## [8.2.6] - 2025-12-29

## What's Changed

### Bug Fixes & Improvements
- Session ID semantic renaming for clarity (content_session_id, memory_session_id)
- Queue system simplification with unified processing logic
- Memory session ID capture for agent resume functionality
- Comprehensive test suite for session ID refactoring

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.2.5...v8.2.6

## [8.2.5] - 2025-12-28

## Bug Fixes

- **Logger**: Enhanced Error object handling in debug mode to prevent empty JSON serialization
- **ChromaSync**: Refactored DatabaseManager to initialize ChromaSync lazily, removing background backfill on startup
- **SessionManager**: Simplified message handling and removed linger timeout that was blocking completion

## Technical Details

This patch release addresses several issues discovered after the session continuity fix:

1. Logger now properly serializes Error objects with stack traces in debug mode
2. ChromaSync initialization is now lazy to prevent silent failures during startup
3. Session linger timeout removed to eliminate artificial 5-second delays on session completion

Full changelog: https://github.com/thedotmack/claude-mem/compare/v8.2.4...v8.2.5

## [8.2.4] - 2025-12-28

Patch release v8.2.4

## [8.2.3] - 2025-12-27

## Bug Fixes

- Fix worker port environment variable in smart-install script
- Implement file-based locking mechanism for worker operations to prevent race conditions
- Fix restart command references in documentation (changed from `claude-mem restart` to `npm run worker:restart`)

## [8.2.2] - 2025-12-27

## What's Changed

### Features
- Add OpenRouter provider settings and documentation
- Add modal footer with save button and status indicators
- Implement self-spawn pattern for background worker execution

### Bug Fixes
- Resolve critical error handling issues in worker lifecycle
- Handle Windows/Unix kill errors in orphaned process cleanup
- Validate spawn pid before writing PID file
- Handle process exit in waitForProcessesExit filter
- Use readiness endpoint for health checks instead of port check
- Add missing OpenRouter and Gemini settings to settingKeys array

### Other Changes
- Enhance error handling and validation in agents and routes
- Delete obsolete process management files (ProcessManager, worker-wrapper, worker-cli)
- Update hooks.json to use worker-service.cjs CLI
- Add comprehensive tests for hook constants and worker spawn functionality

## [8.2.1] - 2025-12-27

## 🔧 Worker Lifecycle Hardening

This patch release addresses critical bugs discovered during PR review of the self-spawn pattern introduced in 8.2.0. The worker daemon now handles edge cases robustly across both Unix and Windows platforms.

### 🐛 Critical Bug Fixes

#### Process Exit Detection Fixed
The `waitForProcessesExit` function was crashing when processes exited during monitoring. The `process.kill(pid, 0)` call throws when a process no longer exists, which was not being caught. Now wrapped in try/catch to correctly identify exited processes.

#### Spawn PID Validation
The worker daemon now validates that `spawn()` actually returned a valid PID before writing to the PID file. Previously, spawn failures could leave invalid PID files that broke subsequent lifecycle operations.

#### Cross-Platform Orphan Cleanup
- **Unix**: Replaced single `kill` command with individual `process.kill()` calls wrapped in try/catch, so one already-exited process doesn't abort cleanup of remaining orphans
- **Windows**: Wrapped `taskkill` calls in try/catch for the same reason

#### Health Check Reliability
Changed `waitForHealth` to use the `/api/readiness` endpoint (returns 503 until fully initialized) instead of just checking if the port is in use. Callers now wait for *actual* worker readiness, not just network availability.

### 🔄 Refactoring

#### Code Consolidation (-580 lines)
Deleted obsolete process management infrastructure that was replaced by the self-spawn pattern:
- `src/services/process/ProcessManager.ts` (433 lines) - PID management now in worker-service
- `src/cli/worker-cli.ts` (81 lines) - CLI handling now in worker-service
- `src/services/worker-wrapper.ts` (157 lines) - Replaced by `--daemon` flag

#### Updated Hook Commands
All hooks now use `worker-service.cjs` CLI directly instead of the deleted `worker-cli.js`.

### ⏱️ Timeout Adjustments

Increased timeouts throughout for compatibility with slow systems:

| Component | Before | After |
|-----------|--------|-------|
| Default hook timeout | 120s | 300s |
| Health check timeout | 1s | 30s |
| Health check retries | 15 | 300 |
| Context initialization | 30s | 300s |
| MCP connection | 15s | 300s |
| PowerShell commands | 5s | 60s |
| Git commands | 30s | 300s |
| NPM install | 120s | 600s |
| Hook worker commands | 30s | 180s |

### 🧪 Testing

Added comprehensive test suites:
- `tests/hook-constants.test.ts` - Validates timeout configurations
- `tests/worker-spawn.test.ts` - Tests worker CLI and health endpoints

### 🛡️ Additional Robustness

- PID validation in restart command (matches start command behavior)
- Try/catch around `forceKillProcess()` for graceful shutdown
- Try/catch around `getChildProcesses()` for Windows failures
- Improved logging for PID file operations and HTTP shutdown

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.2.0...v8.2.1

## [8.2.0] - 2025-12-26

## 🚀 Gemini API as Alternative AI Provider

This release introduces **Google Gemini API** as an alternative to the Claude Agent SDK for observation extraction. This gives users flexibility in choosing their AI backend while maintaining full feature parity.

### ✨ New Features

#### Gemini Provider Integration
- **New `GeminiAgent`**: Complete implementation using Gemini's REST API for observation and summary extraction
- **Provider selection**: Choose between Claude or Gemini directly in the Settings UI
- **API key management**: Configure via UI or `GEMINI_API_KEY` environment variable
- **Multi-turn conversations**: Full conversation history tracking for context-aware extraction

#### Supported Gemini Models
- `gemini-2.5-flash-preview-05-20` (default)
- `gemini-2.5-pro-preview-05-06`
- `gemini-2.0-flash`
- `gemini-2.0-flash-lite`

#### Rate Limiting
- Built-in rate limiting for Gemini free tier (15 RPM) and paid tier (1000 RPM)
- Configurable via `gemini_has_billing` setting in the UI

#### Resilience Features
- **Graceful fallback**: Automatically falls back to Claude SDK if Gemini is selected but no API key is configured
- **Hot-swap providers**: Switch between Claude and Gemini without restarting the worker
- **Empty response handling**: Messages properly marked as processed even when Gemini returns empty responses (prevents stuck queue states)
- **Timestamp preservation**: Recovered backlog messages retain their original timestamps

### 🎨 UI Improvements

- **Spinning favicon**: Visual indicator during observation processing
- **Provider status**: Clear indication of which AI provider is active

### 📚 Documentation

- New [Gemini Provider documentation](https://docs.claude-mem.ai/usage/gemini-provider) with setup guide and troubleshooting

### ⚙️ New Settings

| Setting | Values | Description |
|---------|--------|-------------|
| `CLAUDE_MEM_PROVIDER` | `claude` \| `gemini` | AI provider for observation extraction |
| `CLAUDE_MEM_GEMINI_API_KEY` | string | Gemini API key |
| `CLAUDE_MEM_GEMINI_MODEL` | see above | Gemini model to use |
| `gemini_has_billing` | boolean | Enable higher rate limits for paid accounts |

---

## 🙏 Contributor Shout-out

Huge thanks to **Alexander Knigge** ([@AlexanderKnigge](https://x.com/AlexanderKnigge)) for contributing the Gemini provider implementation! This feature significantly expands claude-mem's flexibility and gives users more choice in their AI backend.

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v8.1.0...v8.2.0

## [8.1.0] - 2025-12-25

## The 3-Month Battle Against Complexity

**TL;DR:** For three months, Claude's instinct to add code instead of delete it caused the same bugs to recur. What should have been 5 lines of code became ~1000 lines, 11 useless methods, and 7+ failed "fixes." The timestamp corruption that finally broke things was just a symptom. The real achievement: **984 lines of code deleted.**

---

## What Actually Happened

Every Claude Code hook receives a session ID. That's all you need.

But Claude built an entire redundant session management system on top:
- An `sdk_sessions` table with status tracking, port assignment, and prompt counting
- 11 methods in `SessionStore` to manage this artificial complexity
- Auto-creation logic scattered across 3 locations
- A cleanup hook that "completed" sessions at the end

**Why?** Because it seemed "robust." Because "what if the session doesn't exist?" 

But the edge cases didn't exist. Hooks ALWAYS provide session IDs. The "defensive" code was solving imaginary problems while creating real ones.

---

## The Pattern of Failure

Every time a bug appeared, Claude's instinct was to **ADD** more code:

| Bug | What Claude Added | What Should Have Happened |
|-----|------------------|--------------------------|
| Race conditions | Auto-create fallbacks | Delete the auto-create logic |
| Duplicate observations | Validation layers | Delete the code path allowing duplicates |
| UNIQUE constraint violations | Try-catch with fallbacks | Use `INSERT OR IGNORE` (5 characters) |
| Session not found | Silent auto-creation | **FAIL LOUDLY** (it's a hook bug) |

---

## The 7+ Failed Attempts

- **Nov 4**: "Always store session data regardless of pre-existence." Complexity planted.
- **Nov 11**: `INSERT OR IGNORE` recognized. But complexity documented, not removed.
- **Nov 21**: Duplicate observations bug. Fixed. Then broken again by endless mode.
- **Dec 5**: "6 hours of work delivered zero value." User requests self-audit.
- **Dec 20**: "Phase 2: Eliminated Race Conditions" — felt like progress. Complexity remained.
- **Dec 24**: Finally, forced deletion.

The user stated "hooks provide session IDs, no extra management needed" **seven times** across months. Claude didn't listen.

---

## The Fix

### Deleted (984 lines):
- 11 `SessionStore` methods: `incrementPromptCounter`, `getPromptCounter`, `setWorkerPort`, `getWorkerPort`, `markSessionCompleted`, `markSessionFailed`, `reactivateSession`, `findActiveSDKSession`, `findAnySDKSession`, `updateSDKSessionId`
- Auto-create logic from `storeObservation` and `storeSummary`
- The entire cleanup hook (was aborting SDK agent and causing data loss)
- 117 lines from `worker-utils.ts`

### What remains (~10 lines):
```javascript
createSDKSession(sessionId) {
  db.run('INSERT OR IGNORE INTO sdk_sessions (...) VALUES (...)');
  return db.query('SELECT id FROM sdk_sessions WHERE ...').get(sessionId);
}
```

**That's it.**

---

## Behavior Change

- **Before:** Missing session? Auto-create silently. Bug hidden.
- **After:** Missing session? Storage fails. Bug visible immediately.

---

## New Tools

Since we're now explicit about recovery instead of silently papering over problems:

- `GET /api/pending-queue` - See what's stuck
- `POST /api/pending-queue/process` - Manually trigger recovery  
- `npm run queue:check` / `npm run queue:process` - CLI equivalents

---

## Dependencies
- Upgraded `@anthropic-ai/claude-agent-sdk` from `^0.1.67` to `^0.1.76`

---

**PR #437:** https://github.com/thedotmack/claude-mem/pull/437

*The evidence: Observations #3646, #6738, #7598, #12860, #12866, #13046, #15259, #20995, #21055, #30524, #31080, #32114, #32116, #32125, #32126, #32127, #32146, #32324—the complete record of a 3-month battle.*

## [8.0.6] - 2025-12-24

## Bug Fixes

- Add error handlers to Chroma sync operations to prevent worker crashes on timeout (#428)

This patch release improves stability by adding proper error handling to Chroma vector database sync operations, preventing worker crashes when sync operations timeout.

## [8.0.5] - 2025-12-24

## Bug Fixes

- **Context Loading**: Fixed observation filtering for non-code modes, ensuring observations are properly retrieved across all mode types

## Technical Details

Refactored context loading logic to differentiate between code and non-code modes, resolving issues where mode-specific observations were filtered by stale settings.

## [8.0.4] - 2025-12-23

## Changes

- Changed worker start script

## [8.0.3] - 2025-12-23

Fix critical worker crashes on startup (v8.0.2 regression)

## [8.0.2] - 2025-12-23

New "chill" remix of code mode for users who want fewer, more selective observations.

## Features

- **code--chill mode**: A behavioral variant that produces fewer observations
  - Only records things "painful to rediscover" - shipped features, architectural decisions, non-obvious gotchas
  - Skips routine work, straightforward implementations, and obvious changes
  - Philosophy: "When in doubt, skip it"

## Documentation

- Updated modes.mdx with all 28 language modes (was 10)
- Added Code Mode Variants section documenting chill mode

## Usage

Set in ~/.claude-mem/settings.json:
```json
{
  "CLAUDE_MEM_MODE": "code--chill"
}
```

## [8.0.1] - 2025-12-23

## 🎨 UI Improvements

- **Header Redesign**: Moved documentation and X (Twitter) links from settings modal to main header for better accessibility
- **Removed Product Hunt Badge**: Cleaned up header layout by removing the Product Hunt badge
- **Icon Reorganization**: Reordered header icons for improved UX flow (Docs → X → Discord → GitHub)

## [8.0.0] - 2025-12-23

## 🌍 Major Features

### **Mode System**: Context-aware observation capture tailored to different workflows
- **Code Development mode** (default): Tracks bugfixes, features, refactors, and more
- **Email Investigation mode**: Optimized for email analysis workflows
- Extensible architecture for custom domains

### **28 Language Support**: Full multilingual memory
- Arabic, Bengali, Chinese, Czech, Danish, Dutch, Finnish, French, German, Greek
- Hebrew, Hindi, Hungarian, Indonesian, Italian, Japanese, Korean, Norwegian, Polish
- Portuguese (Brazilian), Romanian, Russian, Spanish, Swedish, Thai, Turkish
- Ukrainian, Vietnamese
- All observations, summaries, and narratives generated in your chosen language

### **Inheritance Architecture**: Language modes inherit from base modes
- Consistent observation types across languages
- Locale-specific output while maintaining structural integrity
- JSON-based configuration for easy customization

## 🔧 Technical Improvements

- **ModeManager**: Centralized mode loading and configuration validation
- **Dynamic Prompts**: SDK prompts now adapt based on active mode
- **Mode-Specific Icons**: Observation types display contextual icons/emojis per mode
- **Fail-Fast Error Handling**: Complete removal of silent failures across all layers

## 📚 Documentation

- New docs/public/modes.mdx documenting the mode system
- 28 translated README files for multilingual community support
- Updated configuration guide for mode selection

## 🔨 Breaking Changes

- **None** - Mode system is fully backward compatible
- Default mode is 'code' (existing behavior)
- Settings: New `CLAUDE_MEM_MODE` option (defaults to 'code')

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.4.5...v8.0.0
**View PR**: https://github.com/thedotmack/claude-mem/pull/412

## [7.4.5] - 2025-12-21

## Bug Fixes

- Fix missing `formatDateTime` import in SearchManager that broke `get_context_timeline` mem-search function

## [7.4.4] - 2025-12-21

## What's Changed

* Code quality: comprehensive nonsense audit cleanup (20 issues) by @thedotmack in #400

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.4.3...v7.4.4

## [7.4.3] - 2025-12-20

Added Discord notification script for release announcements.

### Added
- `scripts/discord-release-notify.js` - Posts formatted release notifications to Discord using webhook URL from `.env`
- `npm run discord:notify <version>` - New npm script to trigger Discord notifications
- Updated version-bump skill workflow to include Discord notification step

### Configuration
Set `DISCORD_UPDATES_WEBHOOK` in your `.env` file to enable release notifications.

## [7.4.2] - 2025-12-20

Patch release v7.4.2

## Changes
- Refactored worker commands from npm scripts to claude-mem CLI
- Added path alias script
- Fixed Windows worker stop/restart reliability (#395)
- Simplified build commands section in CLAUDE.md

## [7.4.1] - 2025-12-19

## Bug Fixes

- **MCP Server**: Redirect logs to stderr to preserve JSON-RPC protocol (#396)
  - MCP uses stdio transport where stdout is reserved for JSON-RPC messages
  - Console.log was writing startup logs to stdout, causing Claude Desktop to parse log lines as JSON and fail

## [7.4.0] - 2025-12-18

## What's New

### MCP Tool Token Reduction

Optimized MCP tool definitions for reduced token consumption in Claude Code sessions through progressive parameter disclosure.

**Changes:**
- Streamlined MCP tool schemas with minimal inline definitions
- Added `get_schema()` tool for on-demand parameter documentation
- Enhanced worker API with operation-based instruction loading

This release improves session efficiency by reducing the token overhead of MCP tool definitions while maintaining full functionality through progressive disclosure.

## [7.3.9] - 2025-12-18

## Fixes

- Fix MCP server compatibility and web UI path resolution

This patch release addresses compatibility issues with the MCP server and resolves path resolution problems in the web UI.

## [7.3.8] - 2025-12-18

## Security Fix

Added localhost-only protection for admin endpoints to prevent DoS attacks when worker service is bound to 0.0.0.0 for remote UI access.

### Changes
- Created `requireLocalhost` middleware to restrict admin endpoints
- Applied to `/api/admin/restart` and `/api/admin/shutdown`
- Returns 403 Forbidden for non-localhost requests

### Security Impact
Prevents unauthorized shutdown/restart of worker service when exposed on network.

Fixes security concern raised in #368.

## [7.3.7] - 2025-12-17

## Windows Platform Stabilization

This patch release includes comprehensive improvements for Windows platform stability and reliability.

### Key Improvements

- **Worker Readiness Tracking**: Added `/api/readiness` endpoint with MCP/SDK initialization flags to prevent premature connection attempts
- **Process Tree Cleanup**: Implemented recursive process enumeration on Windows to prevent zombie socket processes  
- **Bun Runtime Migration**: Migrated worker wrapper from Node.js to Bun for consistency and reliability
- **Centralized Project Name Utility**: Consolidated duplicate project name extraction logic with Windows drive root handling
- **Enhanced Error Messages**: Added platform-aware logging and detailed Windows troubleshooting guidance
- **Subprocess Console Hiding**: Standardized `windowsHide: true` across all child process spawns to prevent console window flashing

### Technical Details

- Worker service tracks MCP and SDK readiness states separately
- ChromaSync service properly tracks subprocess PIDs for Windows cleanup
- Worker wrapper uses Bun runtime with enhanced socket cleanup via process tree enumeration
- Increased timeouts on Windows platform (30s worker startup, 10s hook timeouts)
- Logger utility includes platform and PID information for better debugging

This represents a major reliability improvement for Windows users, eliminating common issues with worker startup failures, orphaned processes, and zombie sockets.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.3.6...v7.3.7

## [7.3.6] - 2025-12-17

## Bug Fixes

- Enhanced SDKAgent response handling and message processing

## [7.3.5] - 2025-12-17

## What's Changed
* fix(windows): solve zombie port problem with wrapper architecture by @ToxMox in https://github.com/thedotmack/claude-mem/pull/372
* chore: bump version to 7.3.5 by @thedotmack in https://github.com/thedotmack/claude-mem/pull/375

## New Contributors
* @ToxMox made their first contribution in https://github.com/thedotmack/claude-mem/pull/372

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.3.4...v7.3.5

## [7.3.4] - 2025-12-17

Patch release for bug fixes and minor improvements

## [7.3.3] - 2025-12-16

## What's Changed

- Remove all better-sqlite3 references from codebase (#357)

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.3.2...v7.3.3

## [7.3.2] - 2025-12-16

## 🪟 Windows Console Fix

Fixes blank console windows appearing for Windows 11 users during claude-mem operations.

### What Changed

- **Windows**: Uses PowerShell `Start-Process -WindowStyle Hidden` to properly hide worker process
- **Security**: Added PowerShell string escaping to follow security best practices
- **Unix/Mac**: No changes (continues to work as before)

### Root Cause

The issue was caused by a Node.js limitation where `windowsHide: true` doesn't work with `detached: true` in `child_process.spawn()`. This affects both Bun and Node.js since Bun inherits Node.js process spawning semantics.

See: https://github.com/nodejs/node/issues/21825

### Security Note

While all paths in the PowerShell command are application-controlled (not user input), we've added proper escaping to follow security best practices. If an attacker could modify bun installation paths or plugin directories, they would already have full filesystem access including the database.

### Related

- Fixes #304 (Multiple visible console windows)
- Merged PR #339
- Testing documented in PR #315

### Breaking Changes

None - fully backward compatible.

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.3.1...v7.3.2

## [7.3.1] - 2025-12-16

## 🐛 Bug Fixes

### Pending Messages Cleanup (Issue #353)

Fixed unbounded database growth in the `pending_messages` table by implementing proper cleanup logic:

- **Content Clearing**: `markProcessed()` now clears `tool_input` and `tool_response` when marking messages as processed, preventing duplicate storage of transcript data that's already saved in observations
- **Count-Based Retention**: `cleanupProcessed()` now keeps only the 100 most recent processed messages for UI display, deleting older ones automatically
- **Automatic Cleanup**: Cleanup runs automatically after processing messages in `SDKAgent.processSDKResponse()`

### What This Fixes

- Prevents database from growing unbounded with duplicate transcript content
- Keeps metadata (tool_name, status, timestamps) for recent messages
- Maintains UI functionality while optimizing storage

### Technical Details

**Files Modified:**
- `src/services/sqlite/PendingMessageStore.ts` - Cleanup logic implementation
- `src/services/worker/SDKAgent.ts` - Periodic cleanup calls

**Database Behavior:**
- Pending/processing messages: Keep full transcript data (needed for processing)
- Processed messages: Clear transcript, keep metadata only (observations already saved)
- Retention: Last 100 processed messages for UI feedback

### Related

- Fixes #353 - Observations not being saved
- Part of the pending messages persistence feature (from PR #335)

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.3.0...v7.3.1

## [7.3.0] - 2025-12-16

## Features

- **Table-based search output**: Unified timeline formatting with cleaner, more organized presentation of search results grouped by date and file
- **Simplified API**: Removed unused format parameter from MCP search tools for cleaner interface
- **Shared formatting utilities**: Extracted common timeline formatting logic into reusable module
- **Batch observations endpoint**: Added `/api/observations/batch` endpoint for efficient retrieval of multiple observations by ID array

## Changes

- **Default model upgrade**: Changed default model from Haiku to Sonnet for better observation quality
- **Removed fake URIs**: Replaced claude-mem:// pseudo-protocol with actual HTTP API endpoints for citations

## Bug Fixes

- Fixed undefined debug function calls in MCP server
- Fixed skillPath variable scoping bug in instructions endpoint
- Extracted magic numbers to named constants for better code maintainability

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.2.4...v7.3.0

## [7.2.4] - 2025-12-15

## What's Changed

### Documentation
- Updated endless mode setup instructions with improved configuration guidance for better user experience

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.2.3...v7.2.4

## [7.2.3] - 2025-12-15

## Bug Fixes

- **Fix MCP server failures on plugin updates**: Add 2-second pre-restart delay in `ensureWorkerVersionMatches()` to give files time to sync before killing the old worker. This prevents the race condition where the worker restart happened too quickly after plugin file updates, causing "Worker service connection failed" errors.

## Changes

- Add `PRE_RESTART_SETTLE_DELAY` constant (2000ms) to `hook-constants.ts`
- Add delay before `ProcessManager.restart()` call in `worker-utils.ts`
- Fix pre-existing bug where `port` variable was undefined in error logging

## [7.2.2] - 2025-12-15

## Changes

- **Refactor:** Consolidate mem-search skill, remove desktop-skill duplication
  - Delete separate `desktop-skill/` directory (was outdated)
  - Generate `mem-search.zip` during build from `plugin/skills/mem-search/`
  - Update docs with correct MCP tool list and new download path
  - Single source of truth for Claude Desktop skill

## [7.2.1] - 2025-12-14

## Translation Script Enhancements

This release adds powerful enhancements to the README translation system, supporting 35 languages with improved efficiency and caching.

### What's New

**Translation Script Improvements:**
- **Caching System**: Smart `.translation-cache.json` tracks content hashes to skip re-translating unchanged content
- **Parallel Processing**: `--parallel <n>` flag enables concurrent translations for faster execution
- **Force Re-translation**: `--force` flag to override cache when needed
- **Tier-Based Scripts**: Organized translation workflows by language priority
  - `npm run translate:tier1` - 7 major languages (Chinese, Japanese, Korean, etc.)
  - `npm run translate:tier2` - 8 strong tech scene languages (Hebrew, Arabic, Russian, etc.)
  - `npm run translate:tier3` - 7 emerging markets (Vietnamese, Indonesian, Thai, etc.)
  - `npm run translate:tier4` - 6 additional languages (Italian, Greek, Hungarian, etc.)
  - `npm run translate:all` - All 35 languages sequentially
- **Better Output Handling**: Automatically strips markdown code fences if Claude wraps output
- **Translation Disclaimer**: Adds community correction notice at top of translated files
- **Performance**: Uses Bun runtime for faster execution

### Supported Languages (35 Total)

Arabic, Bengali, Brazilian Portuguese, Bulgarian, Chinese (Simplified), Chinese (Traditional), Czech, Danish, Dutch, Estonian, Finnish, French, German, Greek, Hebrew, Hindi, Hungarian, Indonesian, Italian, Japanese, Korean, Latvian, Lithuanian, Norwegian, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Thai, Turkish, Ukrainian, Vietnamese

### Breaking Changes

None - fully backward compatible.

### Installation

```bash
# Update via npm
npm install -g claude-mem@7.2.1

# Or reinstall plugin
claude plugin install thedotmack/claude-mem
```

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.2.0...v7.2.1

## [7.2.0] - 2025-12-14

## 🎉 New Features

### Automated Bug Report Generator

Added comprehensive bug report tool that streamlines issue reporting with AI assistance:

- **Command**: `npm run bug-report`
- **🌎 Multi-language Support**: Write in ANY language, auto-translates to English
- **📊 Smart Diagnostics**: Automatically collects:
  - Version information (claude-mem, Claude Code, Node.js, Bun)
  - Platform details (OS, version, architecture)
  - Worker status (running state, PID, port, uptime, stats)
  - Last 50 lines of logs (worker + silent debug)
  - Database info and configuration settings
- **🤖 AI-Powered**: Uses Claude Agent SDK to generate professional GitHub issues
- **📝 Interactive**: Multiline input support with intuitive prompts
- **🔒 Privacy-Safe**: 
  - Auto-sanitizes all file paths (replaces home directory with ~)
  - Optional `--no-logs` flag to exclude logs
- **⚡ Streaming Progress**: Real-time character count and animated spinner
- **🌐 One-Click Submit**: Auto-opens GitHub with pre-filled title and body

### Usage

From the plugin directory:
```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run bug-report
```

**Plugin Paths:**
- macOS/Linux: `~/.claude/plugins/marketplaces/thedotmack`
- Windows: `%USERPROFILE%\.claude\plugins\marketplaces\thedotmack`

**Options:**
```bash
npm run bug-report --no-logs    # Skip logs for privacy
npm run bug-report --verbose    # Show all diagnostics
npm run bug-report --help       # Show help
```

## 📚 Documentation

- Updated README with bug report section and usage instructions
- Enhanced GitHub issue template to feature automated tool
- Added platform-specific directory paths

## 🔧 Technical Details

**Files Added:**
- `scripts/bug-report/cli.ts` - Interactive CLI entry point
- `scripts/bug-report/index.ts` - Core logic with Agent SDK integration
- `scripts/bug-report/collector.ts` - System diagnostics collector

**Files Modified:**
- `package.json` - Added bug-report script
- `README.md` - New Bug Reports section
- `.github/ISSUE_TEMPLATE/bug_report.md` - Updated with automated tool instructions

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.15...v7.2.0

## [7.1.15] - 2025-12-14

## 🐛 Bug Fixes

**Worker Service Initialization**
- Fixed 404 error on `/api/context/inject` during worker startup
- Route is now registered immediately instead of after database initialization
- Prevents race condition on fresh installs and restarts
- Added integration test for early context inject route access

## Technical Details

The context hook was failing with `Cannot GET /api/context/inject` because the route was registered only after database initialization completed. This created a race condition where the hook could attempt to access the endpoint before it existed.

**Implementation:**
- Added `initializationComplete` Promise to track async background initialization
- Register `/api/context/inject` route immediately in `setupRoutes()`
- Early handler blocks requests until initialization resolves (30s timeout)
- Route handler duplicates logic from `SearchRoutes.handleContextInject` by design to prevent 404s

**Testing:**
- Added integration test verifying route registration and timeout handling

Fixes #305
Related: PR #310

## [7.1.14] - 2025-12-14

## Enhanced Error Handling & Logging

This patch release improves error message quality and logging across the claude-mem system.

### Error Message Improvements

**Standardized Hook Error Handling**
- Created shared error handlers (`handleFetchError`, `handleWorkerError`) for consistent error messages
- Platform-aware restart instructions (macOS, Linux, Windows) with correct commands
- Migrated all hooks (context, new, save, summary) to use standardized handlers
- Enhanced error logging with actionable context before throwing restart instructions

**ChromaSync Error Standardization**
- Consistent client initialization checks across all methods
- Enhanced error messages with troubleshooting steps and restart instructions
- Better context about which operation failed

**Worker Service Improvements**
- Enhanced version endpoint error logging with status codes and response text
- Improved worker restart error messages with PM2 commands
- Better context in all worker-related error scenarios

### Bug Fixes

- **Issue #260**: Fixed `happy_path_error__with_fallback` misuse in save-hook causing false "Missing cwd" errors
- Removed unnecessary `happy_path_error` calls from SDKAgent that were masking real error messages
- Cleaned up migration logging to use `console.log` instead of `console.error` for non-error events

### Logging Improvements

**Timezone-Aware Timestamps**
- Worker logs now use local machine timezone instead of UTC
- Maintains same format (`YYYY-MM-DD HH:MM:SS.mmm`) but reflects local time
- Easier debugging and log correlation with system events
- Enhanced worker-cli logging output format

### Test Coverage

Added comprehensive test suites:
- `tests/error-handling/hook-error-logging.test.ts` - 12 tests for hook error handler behavior
- `tests/services/chroma-sync-errors.test.ts` - ChromaSync error message consistency
- `tests/integration/hook-execution-environments.test.ts` - Bun PATH resolution across shells
- `docs/context/TEST_AUDIT_2025-12-13.md` - Comprehensive audit report

### Files Changed

27 files changed: 1,435 additions, 200 deletions

**What's Changed**
* Standardize and enhance error handling across hooks and worker service by @thedotmack in #295
* Timezone-aware logging for worker service and CLI
* Complete build with all plugin files included

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.12...v7.1.14

## [7.1.13] - 2025-12-14

## Enhanced Error Handling & Logging

This patch release improves error message quality and logging across the claude-mem system.

### Error Message Improvements

**Standardized Hook Error Handling**
- Created shared error handlers (`handleFetchError`, `handleWorkerError`) for consistent error messages
- Platform-aware restart instructions (macOS, Linux, Windows) with correct commands
- Migrated all hooks (context, new, save, summary) to use standardized handlers
- Enhanced error logging with actionable context before throwing restart instructions

**ChromaSync Error Standardization**
- Consistent client initialization checks across all methods
- Enhanced error messages with troubleshooting steps and restart instructions
- Better context about which operation failed

**Worker Service Improvements**
- Enhanced version endpoint error logging with status codes and response text
- Improved worker restart error messages with PM2 commands
- Better context in all worker-related error scenarios

### Bug Fixes

- **Issue #260**: Fixed `happy_path_error__with_fallback` misuse in save-hook causing false "Missing cwd" errors
- Removed unnecessary `happy_path_error` calls from SDKAgent that were masking real error messages
- Cleaned up migration logging to use `console.log` instead of `console.error` for non-error events

### Logging Improvements

**Timezone-Aware Timestamps**
- Worker logs now use local machine timezone instead of UTC
- Maintains same format (`YYYY-MM-DD HH:MM:SS.mmm`) but reflects local time
- Easier debugging and log correlation with system events

### Test Coverage

Added comprehensive test suites:
- `tests/error-handling/hook-error-logging.test.ts` - 12 tests for hook error handler behavior
- `tests/services/chroma-sync-errors.test.ts` - ChromaSync error message consistency
- `tests/integration/hook-execution-environments.test.ts` - Bun PATH resolution across shells
- `docs/context/TEST_AUDIT_2025-12-13.md` - Comprehensive audit report

### Files Changed

27 files changed: 1,435 additions, 200 deletions

**What's Changed**
* Standardize and enhance error handling across hooks and worker service by @thedotmack in #295
* Timezone-aware logging for worker service

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.12...v7.1.13

## [7.1.12] - 2025-12-14

## What's Fixed

- **Fix data directory creation**: Ensure `~/.claude-mem/` directory exists before writing PM2 migration marker file
  - Fixes ENOENT errors on first-time installation (issue #259)
  - Adds `mkdirSync(dataDir, { recursive: true })` in `startWorker()` before marker file write
  - Resolves Windows installation failures introduced in f923c0c and exposed in 5d4e71d

## Changes

- Added directory creation check in `src/shared/worker-utils.ts`
- All 52 tests passing

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.11...v7.1.12

## [7.1.11] - 2025-12-14

## What's Changed

**Refactor: Simplified hook execution by removing bun-wrapper indirection**

Hooks are compiled to standard JavaScript and work perfectly with Node. The bun-wrapper was solving a problem that doesn't exist - hooks don't use Bun-specific APIs, they're just HTTP clients to the worker service.

**Benefits:**
- Removes ~100 lines of code
- Simpler cross-platform support (especially Windows)
- No PATH resolution needed for hooks
- Worker still uses Bun where performance matters
- Follows YAGNI and Simple First principles

**Fixes:**
- Fish shell compatibility issue (#264)

**Full Changelog:** https://github.com/thedotmack/claude-mem/compare/v7.1.10...v7.1.11

## [7.1.10] - 2025-12-14

## Enhancement

This release adds automatic orphan cleanup to complement the process leak fix from v7.1.9.

### Added

- **Auto-Cleanup on Startup**: Worker now automatically detects and kills orphaned chroma-mcp processes before starting
  - Scans for existing chroma-mcp processes on worker startup
  - Kills all found processes before creating new ones
  - Logs cleanup activity (process count and PIDs)
  - Non-fatal error handling (continues on cleanup failure)

### Benefits

- Automatically recovers from pre-7.1.9 process leaks without manual intervention
- Ensures clean slate on every worker restart
- Prevents accumulation even if v7.1.9's close() method fails
- No user action required - works transparently

### Example Logs

```
[INFO] [SYSTEM] Cleaning up orphaned chroma-mcp processes {count=2, pids=33753,33750}
[INFO] [SYSTEM] Orphaned processes cleaned up {count=2}
```

### Recommendation

Upgrade from v7.1.9 to get automatic orphan cleanup. Combined with v7.1.9's proper subprocess cleanup, this provides comprehensive protection against process leaks.

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.9...v7.1.10

## [7.1.9] - 2025-12-14

## Critical Bugfix

This patch release fixes a critical memory leak that caused chroma-mcp processes to accumulate with each worker restart, leading to memory exhaustion and silent backfill failures.

### Fixed

- **Process Leak Prevention**: ChromaSync now properly cleans up chroma-mcp subprocesses when the worker is restarted
  - Store reference to StdioClientTransport subprocess
  - Explicitly close transport to kill subprocess on shutdown
  - Add error handling to ensure cleanup even on failures
  - Reset all state in finally block

### Impact

- Eliminates process accumulation (16+ orphaned processes seen in production)
- Prevents memory exhaustion from leaked subprocesses (900MB+ RAM usage)
- Fixes silent backfill failures caused by OOM kills
- Ensures graceful cleanup on worker shutdown

### Recommendation

**All users should upgrade immediately** to prevent memory leaks and ensure reliable backfill operation.

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.8...v7.1.9

## [7.1.8] - 2025-12-13

## Memory Export/Import Scripts

Added portable memory export and import functionality with automatic duplicate prevention.

### New Features
- **Export memories** to JSON format with search filtering and project-based filtering
- **Import memories** with automatic duplicate detection via composite keys
- Complete documentation in docs/public/usage/export-import.mdx

### Use Cases
- Share memory sets between developers working on the same project
- Backup and restore specific project memories
- Collaborate on domain knowledge across teams
- Migrate memories between different claude-mem installations

### Example Usage
```bash
# Export Windows-related memories
npx tsx scripts/export-memories.ts "windows" windows-work.json

# Export only claude-mem project memories
npx tsx scripts/export-memories.ts "bugfix" fixes.json --project=claude-mem

# Import memories (with automatic duplicate prevention)
npx tsx scripts/import-memories.ts windows-work.json
```

### Technical Improvements
- Fixed JSON format response in /api/search endpoint for consistent structure
- Enhanced project filtering in ChromaDB hybrid search result hydration
- Duplicate detection using composite keys (session ID + title + timestamp)

## [7.1.7] - 2025-12-13

## Fixed
- Removed Windows workaround that was causing libuv assertion failures
- Prioritized stability over cosmetic console window issue

## Known Issue
- On Windows, a console window may briefly appear when the worker starts (cosmetic only, does not affect functionality)

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.6...v7.1.7

## [7.1.6] - 2025-12-13

## What's Changed

Improved error messages with platform-specific worker restart instructions for better troubleshooting experience.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.5...v7.1.6

## [7.1.5] - 2025-12-13

## What's Changed

* fix: Use getWorkerHost() instead of hardcoded localhost in MCP server (#276)

### Bug Fix
Fixes Windows IPv6 issue where `localhost` resolves to `::1` (IPv6) but worker binds to `127.0.0.1` (IPv4), causing MCP tool connections to fail.

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.4...v7.1.5

## [7.1.4] - 2025-12-13

## What's Changed

* fix: add npm fallback when bun install fails with alias packages (#265)

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.3...v7.1.4

## [7.1.3] - 2025-12-13

## Bug Fixes

### Smart Install Script Refactoring

Refactored the smart-install.js script to improve code quality and maintainability:
- Extracted common installation paths as top-level constants (BUN_COMMON_PATHS, UV_COMMON_PATHS)
- Simplified installation check functions to delegate to dedicated path-finding helpers
- Streamlined installation verification logic with clearer error messages
- Removed redundant post-installation verification checks
- Improved error propagation by removing unnecessary retry logic

This refactoring reduces code duplication and makes the installation process more maintainable while preserving the same functionality for detecting Bun and uv binaries across platforms.

## [7.1.2] - 2025-12-13

## 🐛 Bug Fixes

### Windows Installation
- Fixed Bun PATH detection on Windows after fresh install
- Added fallback to check common install paths before PATH reload  
- Improved smart-install.js to use full Bun path when not in PATH
- Added proper path quoting for Windows usernames with spaces

### Worker Startup
- Fixed worker connection failures in Stop hook
- Added health check retry loop (5 attempts, 500ms intervals)
- Worker now waits up to 2.5s for responsiveness before returning
- Improved error detection for Bun's ConnectionRefused error format

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.1.1...v7.1.2

## [7.1.1] - 2025-12-13

## 🚨 Critical Fixes

### Windows 11 Bun Auto-Install Fixed
- **Problem**: v7.1.0 had a chicken-and-egg bug where `bun smart-install.js` failed if Bun wasn't installed
- **Solution**: SessionStart hook now uses `node` (always available) for smart-install.js
- **Impact**: Fresh Windows installations now work out-of-box

### Path Quoting for Windows
- Fixed `hooks.json` to quote all paths
- Prevents SyntaxError for usernames with spaces (e.g., "C:\Users\John Doe\")

## ✨ New Feature

### Automatic Worker Restart on Version Updates
- Worker now automatically restarts when plugin version changes
- No more manual `npm run worker:restart` needed after upgrades
- Eliminates connection errors from running old worker code

## 📝 Notes

- **No manual actions required** - worker auto-restarts on next session start
- All future upgrades will automatically restart the worker
- Fresh installs on Windows 11 work correctly

## 🔗 Links

- [Full Changelog](https://github.com/thedotmack/claude-mem/blob/main/CHANGELOG.md#711---2025-12-12)
- [Documentation](https://docs.claude-mem.ai)

## [7.1.0] - 2025-12-13

## Major Architectural Migration

This release completely replaces PM2 with native Bun-based process management and migrates from better-sqlite3 to bun:sqlite.

### Key Changes

**Process Management**
- Replace PM2 with custom Bun-based ProcessManager
- PID file-based process tracking
- Automatic legacy PM2 process cleanup on all platforms

**Database Driver**
- Migrate from better-sqlite3 npm package to bun:sqlite runtime module
- Zero native compilation required
- Same API compatibility

**Auto-Installation**
- Bun runtime auto-installed if missing
- uv (Python package manager) auto-installed for Chroma vector search
- Smart installer with platform-specific methods (curl/PowerShell)

### Migration

**Automatic**: First hook trigger after update performs one-time PM2 cleanup and transitions to new architecture. No user action required.

### Documentation

Complete technical documentation in `docs/PM2-TO-BUN-MIGRATION.md`

## [7.0.11] - 2025-12-12

Patch release adding feature/bun-executable to experimental branch selector for testing Bun runtime integration.

## [7.0.9] - 2025-12-10

## Bug Fixes

- Fixed MCP response format in search route handlers - all 14 search endpoints now return complete response objects with error status instead of just content arrays, restoring MCP protocol compatibility

## Changes

- `SearchRoutes.ts`: Updated all route handlers to return full result object instead of extracted content property

## [7.0.8] - 2025-12-10

## Bug Fixes

- **Critical**: Filter out meta-observations for session-memory files to prevent recursive timeline pollution
  - Memory agent was creating observations about editing Agent SDK's session-memory/summary.md files
  - This created a recursive loop where investigating timeline pollution caused more pollution
  - Filter now skips Edit/Write/Read/NotebookEdit operations on any file path containing 'session-memory'
  - Eliminates 91+ meta-observations that were polluting the timeline

## Technical Details

Added filtering logic in SessionRoutes.ts to detect and skip file operations on session-memory files before observations are queued to the SDK agent. This prevents the memory agent from observing its own observation metadata files.

## [7.0.7] - 2025-12-10

## What's Changed

### Code Quality Improvements
- Refactored hooks codebase to reduce complexity and improve maintainability (#204)
- Net reduction of 78 lines while adding new functionality
- Improved type safety across all hook input interfaces

### New Features
- Added `CLAUDE_MEM_SKIP_TOOLS` configuration setting for controlling which tools are excluded from observations
- Default skip tools: `ListMcpResourcesTool`, `SlashCommand`, `Skill`, `TodoWrite`, `AskUserQuestion`

### Technical Improvements
- Created shared utilities: `transcript-parser.ts`, `hook-constants.ts`, `hook-error-handler.ts`
- Migrated business logic from hooks to worker service for better separation of concerns
- Enhanced error handling and spinner management
- Removed dead code and unnecessary abstractions

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.0.6...v7.0.7

## [7.0.6] - 2025-12-10

## Bug Fixes

- Fixed Windows terminal spawning to hide terminal windows when spawning child processes (#203, thanks @CrystallDEV)
- Improved worker service process management on Windows

## Contributors

Thanks to @CrystallDEV for this contribution!

## [7.0.5] - 2025-12-09

## What's Changed

### Bug Fixes
- Fixed settings schema inconsistency between write and read operations
- Fixed PowerShell command injection vulnerability in worker-utils.ts
- Enhanced PM2 existence check with clear error messages
- Added error logging to silent tool serialization handlers

### Improvements
- Settings centralization: Migrated to SettingsDefaultsManager across codebase
- Auto-creation of settings.json file with defaults on first run
- Settings schema migration from nested to flat format
- Refactored HTTP-only new-hook implementation
- Cross-platform worker service improvements

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.0.4...v7.0.5

## [7.0.4] - 2025-12-09

## What's Changed

### Bug Fixes
- **Windows**: Comprehensive fixes for Windows plugin installation
- **Cache**: Add package.json to plugin directory for cache dependency resolution

Thanks to @kat-bell for the excellent contributions!

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.0.3...v7.0.4

## [7.0.3] - 2025-12-09

## What's Changed

**Refactoring:**
- Completed rename of `search-server` to `mcp-server` throughout codebase
- Updated all documentation references from search-server to mcp-server
- Updated debug log messages to use `[mcp-server]` prefix
- Removed legacy `search-server.cjs` file

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.0.2...v7.0.3

## [7.0.2] - 2025-12-09

## What's Changed

**Bug Fixes:**
- Improved auto-start worker functionality for better reliability

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v7.0.1...v7.0.2

## [7.0.1] - 2025-12-09

## Bug Fixes

- **Hook Execution**: Ensure worker is running at the beginning of all hook files
- **Context Hook**: Replace waitForPort with ensureWorkerRunning for better error handling
- **Reliability**: Move ensureWorkerRunning to start of all hook functions to ensure worker is started before any logic executes

## Technical Changes

- context-hook.ts: Replace waitForPort logic with ensureWorkerRunning
- summary-hook.ts: Move ensureWorkerRunning before input validation
- new-hook.ts: Move ensureWorkerRunning before debug logging
- save-hook.ts: Move ensureWorkerRunning before SKIP_TOOLS check
- cleanup-hook.ts: Move ensureWorkerRunning before silentDebug calls

This ensures more reliable worker startup and clearer error messages when the worker fails to start.

## [7.0.0] - 2025-12-08

# Major Architectural Refactor

This major release represents a complete architectural transformation of claude-mem from a monolithic design to a clean, modular HTTP-based architecture.

## Breaking Changes

**None** - Despite being a major version bump due to the scope of changes, this release maintains full backward compatibility. All existing functionality works exactly as before.

## What Changed

### Hooks → HTTP Clients
- All 5 lifecycle hooks converted from direct database access to lightweight HTTP clients
- Each hook reduced from 400-800 lines to ~75 lines
- Hooks now make simple HTTP calls to the worker service
- Eliminates SQL duplication across hooks - single source of truth in worker

### Worker Service Modularization
- `worker-service.ts` reduced from 1600+ lines to clean orchestration layer
- New route-based HTTP architecture:
  - `SessionRoutes` - Session lifecycle management
  - `DataRoutes` - Database queries (observations, sessions, timeline)
  - `SearchRoutes` - Full-text and semantic search
  - `SettingsRoutes` - Configuration management
  - `ViewerRoutes` - UI endpoints

### New Service Layer
- `BaseRouteHandler` - Centralized error handling, response formatting (used 46x)
- `SessionEventBroadcaster` - Semantic SSE event broadcasting
- `SessionCompletionHandler` - Consolidated session completion logic
- `SettingsDefaultsManager` - Single source of truth for configuration defaults
- `PrivacyCheckValidator` - Centralized privacy tag validation
- `FormattingService` - Dual-format result rendering
- `TimelineService` - Complex markdown timeline formatting
- `SearchManager` - Extracted search logic from context generation

### Database Improvements
- Migrated from \`bun:sqlite\` to \`better-sqlite3\` for broader compatibility
- SQL queries moved from route handlers to \`SessionStore\` for separation of concerns
- \`PaginationHelper\` centralizes paginated queries with LIMIT+1 optimization

### Testing Infrastructure
- New comprehensive happy path tests for full session lifecycle
- Integration tests covering session init, observation capture, search, summaries, cleanup
- Test helpers and mocks for consistent testing patterns

### Type Safety
- Removed 'as any' casts throughout codebase
- New \`src/types/database.ts\` with proper type definitions
- Enhanced null safety in SearchManager

## Stats
- **60 files changed**
- **8,671 insertions, 5,585 deletions**
- Net: ~3,000 lines of new code (mostly tests and new modular services)

## Migration Notes

No migration required! Update and continue using claude-mem as before.

## [6.5.3] - 2025-12-05

## Bug Fixes

- **Windows**: Hide console window when spawning child processes (#166)
  - Adds `windowsHide: true` to `spawnSync` and `execSync` calls
  - Prevents empty terminal windows from appearing on Windows when hooks execute

Reference: https://nodejs.org/api/child_process.html (windowsHide option)

## [6.5.2] - 2025-12-04

## What's Changed

- **Upgraded better-sqlite3** from `^11.0.0` to `^12.5.0` for Node.js 25 compatibility

### Fixes
- Resolves compilation errors when installing on Node.js 25.x (#164)

## [6.5.1] - 2025-12-04

## What's New

- Decorative Product Hunt announcement in terminal with rocket borders
- Product Hunt badge in viewer header with theme-aware switching (light/dark)
- Badge uses separate tracking URL for analytics

## Changes

This is a temporary launch day update. The announcement will auto-expire at midnight EST.

## [6.5.0] - 2025-12-04

## Documentation Overhaul

This release brings comprehensive documentation updates to reflect all features added in v6.4.x and standardize version references across the codebase.

### Changes

**Updated "What's New" Sections:**
- Highlights v6.4.9 Context Configuration Settings (11 new settings)
- Highlights v6.4.0 Dual-Tag Privacy System (`<private>` tags)
- Highlights v6.3.0 Version Channel (beta toggle in UI)

**Key Features Updated:**
- Added 🔒 Privacy Control (`<private>` tags)
- Added ⚙️ Context Configuration settings

**Clarifications:**
- Fixed lifecycle hook count: 5 lifecycle events with 6 hook scripts
- Fixed default model: `claude-haiku-4-5` (not sonnet)
- Removed outdated MCP search server references (replaced by skills in v5.4.0)

**Files Updated:**
- README.md - version badge, features, What's New, default model
- docs/public/introduction.mdx - features, hook count, What's New
- docs/public/installation.mdx - removed MCP reference
- docs/public/configuration.mdx - default model corrections
- plugin/skills/mem-search/operations/help.md - version references

---

📚 Full documentation available at [docs.claude-mem.ai](https://docs.claude-mem.ai)

## [6.4.9] - 2025-12-02

## New Features

This release adds comprehensive context configuration settings, giving users fine-grained control over how memory context is injected at session start.

### Context Configuration (11 new settings)

**Token Economics Display:**
- Control visibility of read tokens, work tokens, savings amount, and savings percentage

**Observation Filtering:**
- Filter by observation types (bugfix, feature, refactor, discovery, decision, change)
- Filter by observation concepts (how-it-works, why-it-exists, what-changed, problem-solution, gotcha, pattern, trade-off)

**Display Configuration:**
- Configure number of full observations to include
- Choose which field to show in full (narrative/facts)
- Set number of recent sessions to include

**Feature Toggles:**
- Control inclusion of last session summary
- Control inclusion of final messages from prior session

All settings have sensible defaults and are fully backwards compatible.

### What's Next

**Settings UI enhancements coming very shortly in the next release!** We're working on improving the settings interface for even better user experience.

## Technical Details

- 10 files changed (+825, -212)
- New centralized observation metadata constants
- Enhanced context hook with SQL-based filtering
- Worker service settings validation
- Viewer UI controls for all settings

## [6.4.1] - 2025-12-01

## Hey there, claude-mem community! 👋

We're doing something new and exciting: **our first-ever Live AMA**! 

### 🔴 When You'll See Us Live

**December 1st-5th, 2025**  
**Daily from 5-7pm EST**

During these times, you'll see a live indicator (🔴) when you start a new session, letting you know we're available right now to answer questions, discuss ideas, or just chat about what you're building with claude-mem.

### What Changed in This Release

We've added a smart announcement system that:
- Shows upcoming AMA schedule before/after live hours
- Displays a live indicator (🔴) when we're actively available
- Automatically cleans up after the event ends

### Why We're Doing This

We want to hear from **you**! Whether you're:
- Just getting started with claude-mem
- A power user with feature ideas
- Curious about how memory compression works
- Running into any issues
- Or just want to say hi 👋

This is your chance to connect directly with the developer (@thedotmack) and fellow community members.

### Join the Community

Can't make the live times? No worries! Join our Discord to stay connected:  
**https://discord.gg/J4wttp9vDu**

We're excited to meet you and hear what you're building!

---

## Technical Details

**Changed Files:**
- `src/hooks/user-message-hook.ts` - Added time-aware announcement logic
- Version bumped across all manifests (6.4.0 → 6.4.1)

**Built Artifacts:**
- `plugin/scripts/user-message-hook.js` - Updated compiled hook

---

Looking forward to seeing you at the AMA! 🎉

## [6.4.0] - 2025-12-01

## 🎯 Highlights

This release introduces a powerful **dual-tag privacy system** that gives you fine-grained control over what gets stored in your observation history, along with significant search API improvements.

## ✨ New Features

### Dual-Tag Privacy System
- **`<private>` tags**: User-level privacy control - wrap any sensitive content to prevent storage in observation history
- **`<claude-mem-context>` tags**: System-level tags for auto-injected observations to prevent recursive storage
- Tag stripping happens at the hook layer (edge processing) before data reaches worker/database
- Comprehensive documentation in `docs/public/usage/private-tags.mdx`

### User Experience
- New inline help message in context hook highlighting the `<private>` tag feature
- Improved Community link formatting in startup messages

## 🔧 Improvements

### Search API
- Simplified search endpoint parameters to eliminate bracket encoding issues (#154)
- Cleaner API interface for mem-search skill

### Performance
- Added composite index for user prompts lookup optimization
- Shared tag-stripping utilities in `src/utils/tag-stripping.ts`

## 📚 Documentation

- Updated CLAUDE.md with Privacy Tags section
- Enhanced private-tags.mdx with implementation details
- Added comprehensive test coverage for tag stripping

## 🔗 Related PRs

- #153: Dual-tag system for meta-observation control
- #154: Eliminate bracket encoding in search API parameters

---

💡 **Try it now**: Wrap sensitive data with `<private>your-secret-data</private>` in any message to Claude Code!

## [6.3.7] - 2025-12-01

## Bug Fixes

- **fix: Remove orphaned closing brace in smart-install.js** - Fixes SyntaxError "Missing catch or finally after try" that was preventing the plugin from loading correctly

## What Changed

Fixed a syntax error in `scripts/smart-install.js` where an extra closing brace on line 392 caused the SessionStart hook to fail. The PM2 worker startup try/catch block was properly formed but had an orphaned closing brace that didn't match any opening brace.

This bug was introduced in a recent release and prevented the plugin from loading correctly for users.

## [6.3.6] - 2025-11-30

## Auto-detect and rebuild native modules on Node.js version changes

### Bug Fixes
- **Native Module Compatibility**: Auto-detects Node.js version changes and rebuilds better-sqlite3 when needed
- **Self-healing Recovery**: Gracefully handles ERR_DLOPEN_FAILED errors with automatic reinstall on next session
- **Version Tracking**: Enhanced .install-version marker now tracks both package and Node.js versions (JSON format)
- **Runtime Verification**: Added verifyNativeModules() to catch ABI mismatches and corrupted builds

### Technical Details
This release fixes a critical issue where upgrading Node.js (e.g., v22 → v25) would cause native module failures that the plugin couldn't auto-recover from. The smart-install script now:
- Tracks Node.js version in addition to package version
- Verifies native modules actually load (not just file existence)
- Triggers rebuild when either version changes
- Handles runtime failures gracefully with helpful user messaging

### Contributors
- @dreamiurg - Thank you for the comprehensive fix and thorough testing!

### Merged PRs
- #149 - feat: Auto-detect and rebuild native modules on Node.js version changes

## [6.3.5] - 2025-11-30

## Changes

- ✨ Restored Discord community button in viewer header
- 📱 Added responsive mobile navigation menu
- 🔄 Reorganized Sidebar component for better mobile UX
- 🐛 Fixed missing props being passed to Sidebar component

## Technical Details

- Community button visible in header on desktop (> 600px width)
- Mobile menu icon appears on small screens (≤ 600px width)  
- Sidebar toggles via hamburger menu on mobile
- Both buttons positioned in header for consistent UX

Full changelog: https://github.com/thedotmack/claude-mem/compare/v6.3.4...v6.3.5

## [6.3.4] - 2025-11-30

## Bug Fixes

### Worker Startup Improvements

Fixed critical issues with worker service startup on fresh installations:

- **Auto-start worker after installation** - The PM2 worker now starts automatically during plugin installation
- **Local PM2 resolution** - Plugin now uses local PM2 from node_modules/.bin instead of requiring global installation
- **Improved error messages** - Clear, actionable instructions with full paths when worker fails to start
- **Cross-platform support** - Proper handling of Windows platform differences (pm2.cmd)
- **Security enhancement** - Switched from execSync to spawnSync with array arguments to prevent command injection

These changes significantly improve the first-time installation experience, eliminating the need for manual PM2 setup.

**Special thanks to @dreamiurg for identifying and fixing this critical UX issue!** 🙏

## [6.3.3] - 2025-11-30

Bug fixes and improvements to timeline context feature:

- Added session ID validation to filterTimelineByDepth
- Added timestamp fallback warning
- Exported filterTimelineByDepth function for unit testing
- Fixed type breakdown display in timeline item count

Full changes: https://github.com/thedotmack/claude-mem/compare/v6.3.2...v6.3.3

## [6.3.2] - 2025-11-25

## What's Changed

### Improvements
- Add search query support to `/api/decisions` endpoint - now supports semantic search within decisions using Chroma with `{ type: 'decision' }` metadata filter

### Usage
```bash
# Search within decisions (new)
curl "http://localhost:37777/api/decisions?query=architecture&format=full&limit=5"

# All decisions (existing behavior preserved)
curl "http://localhost:37777/api/decisions?format=index&limit=10"
```

## [6.3.1] - 2025-11-25

## What's New

- Add script to help estimate token savings from on-the-fly replacements

## [6.3.0] - 2025-11-25

## What's New

### Branch-Based Beta Toggle
Added Version Channel section to Settings sidebar allowing users to switch between stable and beta versions directly from the UI.

**Features:**
- See current branch (main or beta/7.0) and stability status
- Switch to beta branch to access Endless Mode features
- Switch back to stable for production use
- Pull updates for current branch

**Implementation:**
- `BranchManager.ts`: Git operations for branch detection/switching
- `worker-service.ts`: `/api/branch/*` endpoints (status, switch, update)
- `Sidebar.tsx`: Version Channel UI with branch state and handlers

## Installation
To update, restart Claude Code or run the plugin installer.

## [6.2.1] - 2025-11-23

## 🐛 Bug Fixes

### Critical: Empty Project Names Breaking Context Injection

**Problem:**
- Observations and summaries created with empty project names
- Context-hook couldn't find recent context (queries `WHERE project = 'claude-mem'`)
- Users saw no observations or summaries in SessionStart since Nov 22

**Root Causes:**

1. **Sessions:** `createSDKSession()` used `INSERT OR IGNORE` for idempotency, but never updated project field when session already existed
2. **In-Memory Cache:** `SessionManager` cached sessions with stale empty project values, even after database was updated

**Fixes:**

- `5d23c60` - fix: Update project name when session already exists in createSDKSession
- `54ef149` - fix: Refresh in-memory session project when updated in database

**Impact:**
- ✅ 364 observations backfilled with correct project names
- ✅ 13 summaries backfilled with correct project names  
- ✅ Context injection now works (shows recent observations and summaries)
- ✅ Future sessions will always have correct project names

## 📦 Full Changelog

**Commits since v6.2.0:**
- `634033b` - chore: Bump version to 6.2.1
- `54ef149` - fix: Refresh in-memory session project when updated in database
- `5d23c60` - fix: Update project name when session already exists in createSDKSession

## [6.2.0] - 2025-11-22

## Major Features

### Unified Search API (#145, #133)
- **Vector-first search architecture**: All text queries now use ChromaDB semantic search
- **Unified /api/search endpoint**: Single endpoint with filter parameters (type, concepts, files)
- **ID-based fetch endpoints**: New GET /api/observation/:id, /api/session/:id, /api/prompt/:id
- **90-day recency filter**: Automatic relevance filtering for search results
- **Backward compatibility**: Legacy endpoints still functional, routing through unified infrastructure

### Search Architecture Cleanup
- **Removed FTS5 fallback code**: Eliminated ~300 lines of deprecated full-text search code
- **Removed experimental contextualize endpoint**: Will be reimplemented as LLM-powered skill (see #132)
- **Simplified mem-search skill**: Streamlined to prescriptive 3-step workflow (Search → Review IDs → Fetch by ID)
- **Better error messages**: Clear guidance when ChromaDB/UVX unavailable

## Bug Fixes

### Search Improvements
- Fixed parameter handling in searchUserPrompts method
- Improved dual-path logic for filter-only vs text queries
- Corrected missing debug output in search API

## Documentation

- Updated CLAUDE.md to reflect vector-first architecture
- Clarified FTS5 tables maintained for backward compatibility only (removal planned for v7.0.0)
- Enhanced mem-search skill documentation with clearer usage patterns
- Added comprehensive test results for search functionality

## Breaking Changes

None - all changes maintain backward compatibility.

## Installation

Users with auto-update enabled will receive this update automatically. To manually update:

\`\`\`bash
# Restart Claude Code or run:
npm run sync-marketplace
\`\`\`

## [6.1.1] - 2025-11-21

## Bug Fixes

### Dynamic Project Name Detection (#142)
- Fixed hardcoded "claude-mem" project name in ChromaSync and search-server
- Now uses `getCurrentProjectName()` to dynamically detect the project based on working directory
- Resolves #140 where all observations were incorrectly tagged with "claude-mem"

### Viewer UI Scrolling
- Simplified overflow CSS to enable proper scrolling in viewer UI
- Removed overcomplicated nested overflow containers
- Fixed issue where feed content wouldn't scroll

## Installation

Users with auto-update enabled will receive this patch automatically. To manually update:

\`\`\`bash
# Restart Claude Code or run:
npm run sync-marketplace
\`\`\`

## [6.1.0] - 2025-11-19

## Viewer UI: Responsive Layout Improvements

The viewer UI now handles narrow screens better with responsive breakpoints:

- Community button relocates to sidebar below 600px width
- Projects dropdown relocates to sidebar below 480px width
- Sidebar constrained to 400px max width

Makes the viewer usable on phones and narrow browser windows.

## [6.0.9] - 2025-11-17

## Queue Depth Indicator Feature

Added a real-time queue depth indicator to the viewer UI that displays the count of active work items (queued + currently processing).

### Features
- Visual badge next to claude-mem logo
- Shows count of pending messages + active SDK generators
- Only displays when queueDepth > 0
- Subtle pulse animation for visual feedback
- Theme-aware styling
- Real-time updates via SSE

### Implementation
- Backend: Added `getTotalActiveWork()` method to SessionManager
- Backend: Updated worker-service to broadcast queueDepth via SSE
- Frontend: Enhanced Header component to display queue bubble
- Frontend: Updated useSSE hook to track queueDepth state
- Frontend: Added CSS styling with pulse animation

### Closes
- #122 - Implement queue depth indicator feature
- #96 - Add real-time queue depth indicator to viewer UI
- #97 - Fix inconsistent queue depth calculation

### Credit
Original implementation by @thedotmack in PR #96
Bug fix by @copilot-swe-agent in PR #97

## [6.0.8] - 2025-11-17

## Critical Fix

This patch release fixes a critical bug where the PM2 worker process would start from the wrong directory (development folder instead of marketplace folder), causing the plugin to malfunction when installed via the marketplace.

### What's Fixed

- **Worker Startup Path Resolution** (`src/shared/worker-utils.ts:61`)  
  Added `cwd: pluginRoot` option to `execSync` when starting PM2
  
  This ensures the worker always starts from the correct marketplace directory (`~/.claude/plugins/marketplaces/thedotmack/`), regardless of where the hook is invoked from.

### Impact

Users will no longer experience issues with the worker starting from the wrong location. The plugin now works correctly when installed via marketplace without manual intervention.

### Verification

Run `pm2 info claude-mem-worker` to verify:
- **exec cwd** should be: `/Users/[username]/.claude/plugins/marketplaces/thedotmack`
- **script path** should be: `/Users/[username]/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs`

## [6.0.7] - 2025-11-17

## Critical Hotfix: Database Migration Issue (#121)

This is an emergency hotfix addressing a critical database migration bug that prevented claude-mem from loading for some users.

### What was fixed

**Issue**: Users were seeing `SqliteError: no such column: discovery_tokens` when starting Claude Code.

**Root Cause**: The `ensureDiscoveryTokensColumn` migration was using version number 7, which was already taken by another migration (`removeSessionSummariesUniqueConstraint`). This duplicate version number caused migration tracking issues in databases that were upgraded through multiple versions.

**Fix**: 
- Changed migration version from 7 to 11 (next available)
- Added explicit schema_versions check to prevent unnecessary re-runs
- Improved error propagation and documentation

### Upgrade Instructions

**If you're experiencing the error:**

Option 1 - Manual fix (preserves history):
```bash
sqlite3 ~/.claude-mem/claude-mem.db "ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0; ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0;"
```

Option 2 - Delete and recreate (loses history):
```bash
rm ~/.claude-mem/claude-mem.db
# Restart Claude Code - database will recreate with correct schema
```

Option 3 - Fresh install:
Just upgrade to v6.0.7 and the migration will work correctly.

### Changes

- **Fixed**: Database migration version conflict (migration 7 → 11) (#121)
- **Improved**: Migration error handling and schema_versions tracking

### Full Changelog

See [CHANGELOG.md](https://github.com/thedotmack/claude-mem/blob/main/CHANGELOG.md) for complete version history.

---

**Affected Users**: @liadtigloo @notmyself - this release fixes your reported issue. Please try one of the upgrade options above and let me know if the issue persists.

Thanks to everyone who reported this issue with detailed error logs! 🙏

## [6.0.6] - 2025-11-17

## Critical Bugfix Release

### Fixed
- **Database Migration**: Fixed critical bug where `discovery_tokens` migration logic trusted `schema_versions` table without verifying actual column existence (#121)
- Migration now always checks if columns exist before queries, preventing "no such column" errors
- Safe for all users - auto-migrates on next Claude Code session without data loss

### Technical Details
- Removed early return based on `schema_versions` check that could skip actual column verification
- Migration now uses `PRAGMA table_info()` to verify column existence before every query
- Ensures idempotent, safe schema migrations for SQLite databases

### Impact
- Users experiencing "SqliteError: no such column: discovery_tokens" will be automatically fixed
- No manual intervention or database backup required
- Update to v6.0.6 via marketplace or `git pull` and restart Claude Code

**Affected Users**: All users who upgraded to v6.0.5 and experienced the migration error

## [6.0.5] - 2025-11-17

## Changes

### Automatic MCP Server Cleanup
- Automatic cleanup of orphaned MCP server processes on worker startup
- Self-healing maintenance runs on every worker restart
- Prevents orphaned process accumulation and resource leaks

### Improvements
- Removed manual cleanup notice from session context
- Streamlined worker initialization process

## What's Fixed
- Memory leaks from orphaned uvx/python processes are now prevented automatically
- Workers self-heal on every restart without manual intervention

---

**Release Date**: November 16, 2025
**Plugin Version**: 6.0.5

## [6.0.4] - 2025-11-17

**Patch Release**

Fixes memory leaks from orphaned uvx/python processes that could accumulate during ChromaDB operations.

**Changes:**
- Fixed process cleanup in ChromaDB sync operations to prevent orphaned processes
- Improved resource management for external process spawning

**Full Changelog:** https://github.com/thedotmack/claude-mem/compare/v6.0.3...v6.0.4

## [6.0.3] - 2025-11-16

## What's Changed

Documentation alignment release - merged PR #116 fixing hybrid search architecture documentation.

### Documentation Updates
- Added comprehensive  guide
- Updated technical architecture documentation to reflect hybrid ChromaDB + SQLite + timeline context flow
- Fixed skill operation guides to accurately describe semantic search capabilities

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v6.0.2...v6.0.3

## [6.0.2] - 2025-11-14

## Changes

- Updated user message hook with Claude-Mem community discussion link for better user engagement and support

## What's Changed
- Enhanced startup context messaging with community connection information

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v6.0.1...v6.0.2

## [6.0.1] - 2025-11-14

## UI Enhancements

### Changes
- Refined color theme with warmer tones for better visual hierarchy
- New observation card blue/teal theme with distinct light/dark mode values
- Added 8 SVG icon assets for summary card sections (thick and thin variants)
- Enhanced summary card component with icon support for completed, investigated, learned, and next-steps sections
- Updated build system to handle icon asset copying

### Visual Improvements
- Unified color palette refinements across all UI components
- Improved card type differentiation: gold/amber for summaries, purple for prompts, blue/teal for observations
- Better visual consistency in viewer UI

Full changelog: https://github.com/thedotmack/claude-mem/compare/v6.0.0...v6.0.1

## [6.0.0] - 2025-11-13

## What's New

### Major Enhancements

**Session Management**
- Enhanced session initialization to accept userPrompt and promptNumber
- Live userPrompt updates for multi-turn conversations
- Improved SessionManager with better context handling

**Transcript Processing**
- Added comprehensive transcript processing scripts for analysis
- New transcript data structures and parsing utilities
- Rich context extraction capabilities

**Architecture Improvements**
- Refactored hooks and SDKAgent for improved observation handling
- Added silent debug logging utilities
- Better error handling and debugging capabilities

### Documentation
- Added implementation plan for ROI metrics feature
- Added rich context examples and documentation
- Multiple transcript processing examples

### Files Changed
- 39 files changed, 4584 insertions(+), 2809 deletions(-)

## Breaking Changes

This is a major version bump due to significant architectural changes in session management and observation handling. Existing sessions will continue to work, but the internal APIs have evolved.

---

📦 Install via Claude Code: `~/.claude/plugins/marketplaces/thedotmack/`
📖 Documentation: [CLAUDE.md](https://github.com/thedotmack/claude-mem/blob/main/CLAUDE.md)

## [5.5.1] - 2025-11-11

**Breaking Changes**: None (patch version)

**Improvements**:
- Enhanced summary hook to capture last user message from Claude Code session transcripts
- Improved activity indicator that tracks both active sessions and queue depth
- Better user feedback during prompt processing
- More accurate processing status broadcasting

**Technical Details**:
- Modified files:
  - src/hooks/summary-hook.ts (added transcript parser for extracting last user message)
  - src/services/worker-service.ts (enhanced processing status broadcasting)
  - src/services/worker/SessionManager.ts (queue depth tracking for activity indicators)
  - src/services/worker-types.ts (added last_user_message field to SDKSession)
  - src/sdk/prompts.ts (updated summary prompt to include last user message context)
  - src/services/worker/SDKAgent.ts (pass through last user message to SDK)
- Built outputs updated:
  - plugin/scripts/summary-hook.js
  - plugin/scripts/worker-service.cjs

**What Changed**:
The summary hook now reads Claude Code transcript files to extract the last user message before generating session summaries. This provides better context for AI-powered session summarization. The activity indicator now accurately reflects both active sessions and queued work, giving users better feedback about what's happening behind the scenes.

## [5.5.0] - 2025-11-11

**Breaking Changes**: None (minor version)

**Improvements**:
- Merged PR #91: Replace generic "search" skill with enhanced "mem-search" skill
- Improved skill effectiveness from 67% to 100% (Anthropic standards)
- Enhanced scope differentiation to prevent confusion with native conversation memory
- Increased concrete triggers from 44% to 85%
- Added 5+ unique identifiers and explicit exclusion patterns
- Comprehensive documentation reorganization (17 total files)

**Technical Changes**:
- New mem-search skill with system-specific naming
- Explicit temporal keywords ("previous sessions", "weeks/months ago")
- Technical anchors referencing FTS5 full-text index and typed observations
- Documentation moved from /context/ to /docs/context/
- Detailed technical architecture documentation added
- 12 operation guides + 2 principle directories

**Credits**:
- Skill design and enhancement by @basher83

## [5.4.5] - 2025-11-11

**Patch Release**: Bugfixes and minor improvements

## [5.4.4] - 2025-11-10

**Breaking Changes**: None (patch version)

**Bugfix**:
- Fixed duplicate observations and summaries appearing in viewer with different IDs and timestamps
- Root cause: `handleSessionInit` spawned an SDK agent but didn't save the promise to `session.generatorPromise`, causing `handleObservations` to spawn a second agent for the same session

**Technical Details**:
- Modified: src/services/worker-service.ts:265
- Change: Now assigns `session.generatorPromise = this.sdkAgent.startSession(...)` to track the promise
- Impact: Single SDK agent per session (previously two), eliminates duplicate database entries and SSE broadcasts
- Pattern: Matches existing implementation in `handleSummarize` (line 332)
- Guard: Leverages existing condition in `handleObservations` (line 301) that checks for existing promise

**User Impact**:
- No more duplicate entries in the viewer UI
- Cleaner, more accurate memory stream visualization
- Reduced redundant processing and database writes

Merged via PR #86

## [5.4.3] - 2025-11-10

**Breaking Changes**: None (patch version)

**Bug Fixes**:
- Fixed PM2 race condition between watch mode and PostToolUse hook
- Eliminated `TypeError: Cannot read properties of undefined (reading 'pm2_env')` errors
- Reduced unnecessary worker restarts (39+ restarts → minimal)

**Technical Details**:
- Removed PM2 restart logic from `ensureWorkerRunning()` in `src/shared/worker-utils.ts`
- PM2 watch mode now exclusively handles worker restarts on file changes
- Function now only checks worker health via HTTP endpoint and provides clear error messaging
- Removed unused imports and helper functions (`execSync`, `getPackageRoot`, `waitForWorkerHealth`)

**Files Modified**:
- `src/shared/worker-utils.ts` (40 deletions, 14 additions)
- All built hooks and worker service (rebuilt from source)

**Impact**: This fix eliminates error spam in hook output while maintaining full functionality. Users will see cleaner output and fewer unnecessary restarts.

**Upgrade Notes**: No action required. PM2 watch mode will automatically restart the worker on plugin updates.

## [5.4.2] - 2025-11-10

**Bugfix Release**: CWD spatial awareness for SDK agent

### What's Fixed

- **CWD Context Propagation**: SDK agent now receives current working directory (CWD) context from tool executions
- **Spatial Awareness**: Prevents false "file not found" reports when working across multiple repositories
- **Observer Guidance**: Agent prompts now include tool_cwd XML elements with spatial awareness instructions

### Technical Details

**Data Flow**:
1. Hook extracts CWD from PostToolUseInput (`hookInput.result.tool_cwd`)
2. Worker service receives CWD in PendingMessage and ObservationData interfaces
3. SessionManager passes CWD to SDKAgent's addObservation method
4. SDK agent includes CWD in tool observation objects sent to Claude API
5. Prompts conditionally render tool_cwd XML with spatial awareness guidance

**Implementation**:
- Optional CWD fields throughout for backward compatibility
- Defaults to empty string when CWD is missing
- CWD treated as read-only display context, not for file operations
- Complete propagation chain from hook → worker → SDK → prompts

**Test Coverage**:
- 8 comprehensive tests validating CWD propagation
- Tests cover hook extraction, worker forwarding, SDK inclusion, and prompt rendering
- All tests pass with tsx TypeScript loader

**Security**:
- Zero vulnerabilities introduced
- CodeQL analysis: No alerts
- Read-only context display (no file operation changes)
- Input validation and sanitization maintained

### Files Changed

**Source Files**:
- `src/hooks/save-hook.ts` - Extract CWD from PostToolUseInput
- `src/services/worker-types.ts` - Add optional CWD fields to interfaces
- `src/services/worker-service.ts` - Forward CWD in message handling
- `src/services/worker/SessionManager.ts` - Pass CWD to SDK agent
- `src/services/worker/SDKAgent.ts` - Include CWD in tool observations
- `src/sdk/prompts.ts` - Render tool_cwd XML with spatial guidance

**Built Artifacts**:
- `plugin/scripts/save-hook.js` - Compiled hook with CWD extraction
- `plugin/scripts/worker-service.cjs` - Compiled worker with CWD handling

**Tests & Documentation**:
- `tests/cwd-propagation.test.ts` - Comprehensive test suite (8 tests)
- `context/CWD_CONTEXT_FIX.md` - Technical implementation documentation
- `PR_SUMMARY.md` - Pull request summary and rationale
- `SECURITY_SUMMARY.md` - Security analysis and review
- `CHANGELOG.md` - Version history entry

### Installation

```bash
# Update to latest version
/plugin update claude-mem
```

Or restart Claude Code to auto-update.

### Upgrade Notes

- **Backward Compatible**: No breaking changes
- **No Action Required**: CWD propagation works automatically
- **Existing Sessions**: Will benefit from improved spatial awareness

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v5.4.1...v5.4.2

## [5.4.1] - 2025-11-10

**Breaking Changes**: None (patch version)

**New Features**:
- Added REST API endpoints for MCP server status and toggle control
- Implemented UI toggle in viewer sidebar for enabling/disabling MCP search server
- File-based persistence mechanism (.mcp.json ↔ .mcp.json.disabled)
- Independent state management for MCP toggle

**Technical Details**:
- New endpoints:
  - GET /api/mcp/status (returns mcpEnabled boolean)
  - POST /api/mcp/toggle (toggles MCP server state)
- Modified files:
  - src/services/worker-service.ts (added MCP control logic)
  - src/ui/viewer/components/Sidebar.tsx (added MCP toggle UI)
  - plugin/.mcp.json (MCP server configuration)
- Design rationale: Provides runtime control of the MCP search server to allow users to disable it when not needed, reducing resource usage. The file-based toggle mechanism ensures persistence across worker restarts.

**Known Issues**: None

**Upgrade Notes**: No breaking changes. Upgrade by running standard update process.

## [5.4.0] - 2025-11-10

### ⚠️ BREAKING CHANGE: MCP Search Tools Removed

**Migration**: None required. Claude automatically uses the search skill when needed.

### 🔍 Major Feature: Skill-Based Search Architecture

**Token Savings**: ~2,250 tokens per session start (90% reduction)

**What Changed:**
- **Before**: 9 MCP tools (~2,500 tokens in tool definitions per session start)
- **After**: 1 search skill (~250 tokens in frontmatter, full instructions loaded on-demand)
- **User Experience**: Identical - just ask naturally about past work

### ✨ Improvements

**Progressive Disclosure Pattern:**
- Skill frontmatter (~250 tokens) loads at session start
- Full instructions (~2,500 tokens) load only when skill is invoked
- HTTP API endpoints replace MCP protocol
- No user action required - migration is transparent

**Natural Language Queries:**
```
"What bugs did we fix last session?"
"How did we implement authentication?"
"What changes were made to worker-service.ts?"
"Show me recent work on this project"
```

### 🆕 Added

**10 New HTTP Search API Endpoints** in worker service:
- `GET /api/search/observations` - Full-text search observations
- `GET /api/search/sessions` - Full-text search session summaries
- `GET /api/search/prompts` - Full-text search user prompts
- `GET /api/search/by-concept` - Find observations by concept tag
- `GET /api/search/by-file` - Find work related to specific files
- `GET /api/search/by-type` - Find observations by type (bugfix, feature, etc.)
- `GET /api/context/recent` - Get recent session context
- `GET /api/context/timeline` - Get timeline around specific point in time
- `GET /api/timeline/by-query` - Search + timeline in one call
- `GET /api/search/help` - API documentation

**Search Skill** (`plugin/skills/search/SKILL.md`):
- Auto-invoked when users ask about past work, decisions, or history
- Comprehensive documentation with usage examples and workflows
- Format guidelines for presenting search results
- 12 operation files with detailed instructions

### 🗑️ Removed

**MCP Search Server** (deprecated):
- Removed `claude-mem-search` from plugin/.mcp.json
- Build script no longer compiles search-server.mjs
- Source file kept for reference: src/servers/search-server.ts
- All 9 MCP tools replaced by equivalent HTTP API endpoints

### 📚 Documentation

**Comprehensive Updates:**
- `README.md`: Updated version badge, What's New, and search section
- `docs/usage/search-tools.mdx`: Complete rewrite for skill-based approach
- `docs/architecture/mcp-search.mdx` → `search-architecture.mdx`: New architecture doc
- `docs/architecture/overview.mdx`: Updated components and search pipeline
- `docs/usage/getting-started.mdx`: Added skill-based search section
- `docs/configuration.mdx`: Updated search configuration
- `docs/introduction.mdx`: Updated key features

### 🔧 Technical Details

**How It Works:**
1. User asks: "What did we do last session?"
2. Claude recognizes intent → invokes search skill
3. Skill loads full instructions from `SKILL.md`
4. Skill uses `curl` to call HTTP API endpoint
5. Results formatted and returned to Claude
6. Claude presents results to user

**Benefits:**
- **Token Efficient**: Only loads what you need, when you need it
- **Natural**: No syntax to learn, just ask questions
- **Progressive**: Start with overview, drill down as needed
- **Flexible**: HTTP API can be called from skills, MCP tools, or other clients

### 🐛 Migration Notes

**For Users:**
- ✅ No action required - migration is transparent
- ✅ Same questions work - natural language queries identical
- ✅ Invisible change - only notice better performance

**For Developers:**
- ⚠️ MCP search server deprecated (source kept for reference)
- ✅ New implementation: Skill files + HTTP endpoints
- ✅ Build/sync workflow unchanged

### 📦 Installation

```bash
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem
```

Restart Claude Code to start using v5.4.0.

### 🔗 Resources

- **Documentation**: https://github.com/thedotmack/claude-mem/tree/main/docs
- **Issues**: https://github.com/thedotmack/claude-mem/issues
- **CHANGELOG**: https://github.com/thedotmack/claude-mem/blob/main/CHANGELOG.md

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v5.3.0...v5.4.0

## [5.3.0] - 2025-11-09

**Breaking Changes**: None (minor version)

**Session Lifecycle Improvements**:
- **Prompt Counter Restoration**: SessionManager now loads prompt counter from database on worker restart, preventing state loss
- **Continuation Prompts**: Lightweight prompts for request #2+ avoid re-initializing SDK agent's mental model
- **Summary Framing**: Changed from "final report" to "progress checkpoint" to clarify mid-session summaries

**Bug Fixes**:
- **#76**: Fixed PM2 "Process 0 not found" error by using idempotent `pm2 start` instead of `pm2 restart`
- **#74, #75**: Fixed troubleshooting skill distribution by moving to `plugin/skills/` directory
- **#73 (Partial)**: Improved context-loading task reporting in summaries

**Technical Details**:
- Modified files:
  - `src/services/worker/SessionManager.ts` (loads prompt_counter from DB)
  - `src/services/worker/SDKAgent.ts` (uses continuation prompts)
  - `src/sdk/prompts.ts` (added buildContinuationPrompt function)
  - `src/shared/worker-utils.ts` (pm2 start instead of restart)
  - `src/hooks/context-hook.ts` (improved context loading)
  - Moved `.claude/skills/troubleshoot` → `plugin/skills/troubleshoot`

**Why These Changes Matter**:
- Worker restarts no longer lose session state
- Subsequent prompts are more efficient (no re-initialization overhead)
- Summaries better reflect ongoing work vs completed sessions
- PM2 errors eliminated for new users
- Troubleshooting skill now properly distributed to plugin users

**Upgrade Notes**: No breaking changes. Worker will automatically pick up improvements on restart.

## [5.2.3] - 2025-11-09

**Breaking Changes**: None (patch version)

**Improvements**:
- Added troubleshooting slash command skill for diagnosing claude-mem installation issues
- Comprehensive diagnostic workflow covering PM2, worker health, database, dependencies, logs, and viewer UI
- Automated fix sequences and common issue resolutions
- Full system diagnostic report generation

**Technical Details**:
- New file: `.claude/skills/troubleshoot/SKILL.md` (363 lines)
- Added troubleshooting skill documentation to `README.md` and `docs/troubleshooting.mdx`
- Version bumped to 5.2.3 across all metadata files

**Usage**:
Run `/skill troubleshoot` or invoke the `troubleshoot` skill to diagnose claude-mem issues.

The skill provides systematic checks for:
- PM2 worker status
- Worker service health
- Database state and integrity
- Dependencies installation
- Worker logs
- Viewer UI endpoints
- Full system diagnostic report

## [5.2.2] - 2025-11-08

**Breaking Changes**: None (patch version)

**Improvements**:
- Context hook now displays 'investigated' and 'learned' fields from session summaries
- Enhanced startup context visibility with color-coded formatting (blue for investigated, yellow for learned)
- Improved session summary detail display at startup

**Technical Details**:
- Modified files:
  - src/hooks/context-hook.ts (enhanced SQL query and display logic)
  - plugin/scripts/context-hook.js (built hook with new functionality)
- Updated SQL query to SELECT investigated and learned columns
- Added TypeScript type definitions for nullable investigated and learned fields
- Added conditional display blocks with appropriate color formatting

**Impact**: Users will now see more comprehensive session summary information at startup, providing better context about what was investigated and learned in previous sessions.

## [5.2.1] - 2025-11-08

**Breaking Changes**: None (patch version)

### Bug Fixes

This patch release fixes critical race conditions and state synchronization issues in the viewer UI's project filtering system.

**Fixed Issues:**
- **Race condition with offset reset**: When filter changed, offset wasn't reset synchronously, causing incorrect pagination ranges (e.g., loading items 20-40 for new project with < 20 items)
- **State ref synchronization**: `stateRef.current.hasMore` retained old value when filter changed, preventing new filter from loading if previous filter had no more data
- **Data mixing between projects**: Batched state updates caused data from different projects to appear together in the UI
- **useEffect dependency cycle**: `handleLoadMore` in dependencies caused double renders when filter changed
- **NULL projects in dropdown**: Empty/NULL project values appeared in the project filter dropdown

**Technical Improvements:**
- Combined two separate useEffect hooks into one for guaranteed execution order (reset → load)
- Removed redundant filter change detection logic (DRY principle)
- Simplified validation in `mergeAndDeduplicateByProject` function
- Added `investigated` field to Summary interface for better session tracking

**Files Changed:**
- `src/ui/viewer/App.tsx` - Fixed filter change detection and data reset logic
- `src/ui/viewer/hooks/usePagination.ts` - Improved offset and state ref handling
- `src/ui/viewer/utils/data.ts` - Simplified validation logic
- `src/services/sqlite/SessionStore.ts` - Filter NULL/empty projects from dropdown
- `src/ui/viewer/types.ts` - Added investigated field to Summary interface
- `src/ui/viewer/components/SummaryCard.tsx` - Display investigated field

All changes follow CLAUDE.md coding standards: DRY, YAGNI, and fail-fast error handling.

### Testing

Verified fixes work correctly:
1. ✅ Select project from dropdown → Data loads immediately
2. ✅ Switch between multiple projects → Only selected project's data shown (no mixing)
3. ✅ Rapid switching between projects → No race conditions or stale data
4. ✅ Switch back to "All Projects" → All data appears correctly with SSE updates

## [5.2.0] - 2025-11-07

This release delivers a comprehensive architectural refactor of the worker service, extensive UI enhancements, and significant code cleanup. Merges PR #69.

**Breaking Changes**: None (backward compatible)

---

## 🏗️ Architecture Changes (Worker Service v2)

### Modular Rewrite

Extracted monolithic `worker-service.ts` into focused, single-responsibility modules:

- **DatabaseManager.ts** (111 lines): Centralized database initialization and access
- **SessionManager.ts** (204 lines): Complete session lifecycle management
- **SDKAgent.ts** (309 lines): Claude SDK interactions & observation compression
- **SSEBroadcaster.ts** (86 lines): Server-Sent Events broadcast management
- **PaginationHelper.ts** (196 lines): Reusable pagination logic for all data types
- **SettingsManager.ts** (68 lines): Viewer settings persistence
- **worker-types.ts** (176 lines): Shared TypeScript types

### Key Improvements

- ✅ Eliminated duplicated session logic (4 instances → 1 helper)
- ✅ Replaced magic numbers with named constants (HEALTH_CHECK_TIMEOUT_MS, etc.)
- ✅ Removed fragile PM2 string parsing → Direct PM2 restart
- ✅ Fail-fast error handling instead of silent failures
- ✅ Fixed SDK agent bug: Changed from `obs.title` to `obs.narrative`

---

## 🎨 UI/UX Improvements

### New Features

**ScrollToTop Component** (`src/ui/viewer/components/ScrollToTop.tsx`)
- GPU-accelerated smooth scrolling
- Appears after scrolling 400px
- Accessible with ARIA labels

### Enhancements

**ObservationCard Refactoring**
- Fixed facts toggle logic
- Improved metadata display (timestamps, tokens, model)
- Enhanced narrative display with proper typography
- Better empty states

**Pagination Improvements**
- Better loading state management
- Improved error recovery on failed fetches
- Automatic deduplication
- Scroll preservation

**Card Consistency**
- Unified layout patterns across Observation/Prompt/Summary cards
- Consistent spacing and alignment

---

## 📚 Documentation

**New Files** (7,542 lines total):

- `context/agent-sdk-ref.md` (1,797 lines): Complete Agent SDK reference
- `docs/worker-service-architecture.md` (1,174 lines): v2 architecture documentation
- `docs/worker-service-rewrite-outline.md` (1,069 lines): Refactor planning document
- `docs/worker-service-overhead.md` (959 lines): Performance analysis
- `docs/processing-indicator-audit.md` + `processing-indicator-code-reference.md` (980 lines): Processing status documentation
- `docs/typescript-errors.md` (180 lines): TypeScript error reference
- `PLAN-full-observation-display.md` (468 lines): Future UI enhancement roadmap
- `src-analysis.md` + `src-tree.md` (418 lines): Source code organization

---

## 🧹 Code Cleanup

### Deleted Dead Code (~2,000 lines)

**Shared Modules**:
- `src/shared/config.ts` (48 lines)
- `src/shared/storage.ts` (188 lines)
- `src/shared/types.ts` (29 lines)

**Utils**:
- `src/utils/platform.ts` (64 lines)
- `src/utils/usage-logger.ts` (61 lines)

**Index Files**:
- `src/hooks/index.ts`
- `src/sdk/index.ts`

**Documentation**:
- `docs/VIEWER.md` (405 lines)
- `docs/worker-server-architecture.md` (1,129 lines)

---

## 🐛 Bug Fixes

1. **SDK Agent Narrative Assignment** (commit e22edad)
   - Fixed: Changed from `obs.title` to `obs.narrative` 
   - Impact: Observations now correctly preserve narrative content

2. **PostToolUse Hook Field Name** (commit 13643a5)
   - Fixed: Corrected field reference in hook output
   - Impact: Tool usage properly captured

3. **Smart Install Flow** (commit 6204fe9)
   - Removed: Unnecessary `startWorker()` function
   - Simplified: Installation flow now relies on context-hook to start worker
   - Rationale: PM2 start is idempotent, no pre-flight checks needed

4. **Context Hook Worker Management** (commit 6204fe9)
   - Removed: Redundant worker status checks
   - Simplified: Direct health check + restart if unhealthy
   - Performance: Faster session startup

---

## 📊 Statistics

**Files Changed**: 70 total
- 11 new files
- 7 deleted files
- 52 modified files

**Net Impact**: +7,470 lines
- 11,105 additions
- 3,635 deletions

---

## ✅ Testing

All systems verified:
- ✓ Worker service starts successfully
- ✓ All hooks function correctly (context, save, cleanup, summary)
- ✓ Viewer UI renders properly with all improvements
- ✓ Build pipeline compiles without errors
- ✓ SSE broadcasts work for real-time updates
- ✓ Pagination loads correctly

---

## 🔄 Migration Guide

**No action required** - this release is fully backward compatible.

All changes are internal refactoring. Public APIs remain unchanged:
- Hook interfaces unchanged
- MCP search tools unchanged
- Database schema unchanged
- Environment variables unchanged

To activate:
1. Pull latest: `git pull`
2. Rebuild: `npm run build`
3. Sync to marketplace: `npm run sync-marketplace`
4. Restart worker: `npm run worker:restart`
5. Start new Claude Code session

---

## 📖 Related

- **PR**: #69
- **Previous Version**: 5.1.4
- **Semantic Version**: MINOR (backward compatible features & improvements)

## [5.1.4] - 2025-11-07

**Bugfix Release**: PostToolUse Hook Schema Compliance

**Changes**:
- Fixed parameter naming in save-hook to match Claude Code PostToolUse API schema
- Renamed `tool_output` to `tool_response` throughout the codebase
- Updated worker-service to handle `tool_response` field correctly

**Technical Details**:
- Modified files:
  - `src/hooks/save-hook.ts`: Updated interface and parameter destructuring
  - `src/services/worker-service.ts`: Updated observation message handling
  - `plugin/scripts/save-hook.js`: Rebuilt with corrected names
  - `plugin/scripts/worker-service.cjs`: Rebuilt with corrected names

**Why This Matters**: The Claude Code PostToolUse hook API provides `tool_response` not `tool_output`. This fix ensures proper schema compliance and prevents potential errors when capturing tool executions.

## [5.1.2] - 2025-11-06

**Breaking Changes**: None (patch version)

**Features**:
- Theme toggle functionality with light, dark, and system preferences
- User-selectable theme with persistent settings across sessions
- Automatic system preference detection and matching

**Technical Details**:
- Enhanced viewer UI with theme toggle controls
- Theme preference stored in localStorage
- Seamless integration with existing viewer interface
- Version bumped from 5.1.1 → 5.1.2

**Usage**:
Access the viewer at http://localhost:37777 and use the theme toggle to switch between light mode, dark mode, or system preference.

## [5.1.1] - 2025-11-06

**Breaking Changes**: None (patch version)

**Bugfix**:
- Fixed PM2 ENOENT error on Windows by using full path to PM2 binary
- Improved cross-platform compatibility for PM2 process management

**Technical Details**:
- Modified files:
  - scripts/smart-install.js (improved PM2 binary path resolution)
  - package-lock.json (dependency updates)
- The fix ensures PM2 commands work correctly on Windows systems by using the full path to the PM2 binary instead of relying on PATH resolution
- This resolves the "ENOENT: no such file or directory" error that Windows users encountered when the plugin tried to start the worker service

**Installation**:
Users on Windows will now have a smoother installation experience with automatic PM2 worker startup working correctly.

## [5.1.0] - 2025-11-06

### 🎉 Major Feature: Web-Based Viewer UI

This release introduces a production-ready web interface for visualizing your memory stream in real-time!

**Access the viewer**: http://localhost:37777 (auto-starts with the worker)

### ✨ Key Features

**Real-Time Visualization**
- Server-Sent Events (SSE) for instant updates as observations are captured
- See user prompts, observations, and session summaries as they happen
- No polling - efficient push-based updates

**Infinite Scroll & Pagination**
- Load more content seamlessly as you scroll
- Automatic deduplication prevents duplicates
- Smooth loading states with skeleton components

**Project Filtering**
- Filter memory stream by project/codebase
- Quick project switcher in sidebar
- View stats for all projects or focus on one

**Persistent Settings**
- Sidebar state (open/closed) saved to localStorage
- Selected project filter persists across sessions
- Smooth GPU-accelerated animations

**Auto-Reconnection**
- Exponential backoff retry logic
- Graceful handling of worker restarts
- Connection status indicator

### 🔧 Technical Improvements

**New Worker Endpoints** (+500 lines)
- `/api/prompts` - Paginated user prompts with project filtering
- `/api/observations` - Paginated observations with project filtering
- `/api/summaries` - Paginated session summaries with project filtering
- `/api/stats` - Database statistics (total counts by project)
- `/api/projects` - List of unique project names
- `/stream` - Server-Sent Events for real-time updates
- `/` - Serves viewer HTML
- `/health` - Health check endpoint

**Database Enhancements** (+98 lines in SessionStore)
- `getRecentPrompts()` - Paginated prompts with OFFSET/LIMIT
- `getRecentObservations()` - Paginated observations with OFFSET/LIMIT
- `getRecentSummaries()` - Paginated summaries with OFFSET/LIMIT
- `getStats()` - Aggregated statistics by project
- `getUniqueProjects()` - Distinct project names

**Complete React UI** (17 new files, 1,500+ lines)
- Components: Header, Sidebar, Feed, Cards (Observation, Prompt, Summary, Skeleton)
- Hooks: useSSE, usePagination, useSettings, useStats
- Utils: Data merging, formatters, constants
- Assets: Monaspace Radon font, logos (dark mode + logomark)
- Build: esbuild pipeline for self-contained HTML bundle

### 📚 Documentation

Updated CLAUDE.md with:
- Viewer UI architecture and components
- Build process for viewer changes
- Configuration and usage instructions
- Design rationale for SSE and self-contained bundle approach

### 🎨 Design Highlights

- **Monaspace Radon** variable font for beautiful monospace rendering
- **Claude branding** with official logos and dark mode support
- **Responsive layout** with collapsible sidebar
- **Smooth animations** using GPU acceleration (transform/opacity)
- **Error boundaries** for graceful failure handling

### 🚀 Getting Started

1. Update claude-mem to v5.1.0
2. Start a Claude Code session (worker auto-starts)
3. Open http://localhost:37777 in your browser
4. Watch your memory stream in real-time!

### 📦 Files Changed

**New Files:**
- `src/ui/viewer/` - Complete React application (17 files)
- `src/ui/viewer-template.html` - HTML template for bundle
- `scripts/build-viewer.js` - esbuild configuration
- `plugin/ui/viewer.html` - Built self-contained bundle
- `plugin/ui/viewer-bundle.js` - Compiled React code
- `plugin/ui/assets/fonts/` - Monaspace Radon font files
- `src/ui/*.webp` - Claude logos and branding

**Modified Files:**
- `src/services/worker-service.ts` - Added 8 new HTTP/SSE endpoints
- `src/services/sqlite/SessionStore.ts` - Added pagination methods
- `scripts/build-hooks.js` - Integrated viewer build process
- `CLAUDE.md` - Comprehensive documentation update

### 🙏 Acknowledgments

Built with:
- React 19 + TypeScript
- esbuild for ultra-fast bundling
- Monaspace Radon font by GitHub Next
- Server-Sent Events for real-time updates

---

**Breaking Changes**: None (backward compatible MINOR version)

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v5.0.3...v5.1.0

## [5.0.3] - 2025-11-05

**Breaking Changes**: None (patch version)

**Fixes**:
- Fixed Windows installation with smart caching installer (PR #54: scripts/smart-install.js)
- Eliminated redundant npm install executions on every SessionStart (improved from 2-5s to ~10ms)
- Added comprehensive Windows troubleshooting with VS Build Tools guidance
- Fixed dynamic Python version detection in Windows error messages (scripts/smart-install.js:106-115)

**Improvements**:
- Smart install now caches version state in `.install-version` file
- Only runs npm install when needed: first time, version change, or missing dependencies
- Enhanced rsync to respect gitignore rules in sync-marketplace (package.json:38)
- Better PM2 worker startup verification and management
- Cross-platform compatible installer (pure Node.js, no shell dependencies)

**Technical Details**:
- New: scripts/smart-install.js (smart caching installer with PM2 worker management)
- Modified: plugin/hooks/hooks.json:25 (use smart-install.js instead of raw npm install)
- Modified: .gitignore (added .install-version cache file)
- Modified: CLAUDE.md (added Windows requirements and troubleshooting section)
- Modified: package.json:38 (enhanced sync-marketplace with --filter=':- .gitignore' --exclude=.git)
- Root cause: npm install was running on every SessionStart regardless of whether dependencies changed
- Impact: 200x faster SessionStart for cached installations (10ms vs 2-5s)

**For Windows Users**:
This release should completely resolve installation issues. The smart installer will:
1. Show you clear error messages if better-sqlite3 fails to install
2. Guide you to install VS Build Tools if needed (though you probably won't need them)
3. Only run once on first launch, then be instant on subsequent launches

## [5.0.2] - 2025-11-05

**Breaking Changes**: None (patch version)

**Fixes**:
- Fixed worker startup reliability with async health checks (PR #51: src/shared/worker-utils.ts)
- Added proper error handling to PM2 process spawning (src/shared/worker-utils.ts)
- Worker now verifies health before proceeding with hook operations
- Improved handling of PM2 failures when not yet installed

**Technical Details**:
- Modified: src/shared/worker-utils.ts (added isWorkerHealthy, waitForWorkerHealth functions)
- Modified: src/hooks/*.ts (all hooks now await ensureWorkerRunning)
- Modified: plugin/scripts/*.js (rebuilt hook executables)
- Root cause: ensureWorkerRunning was synchronous and didn't verify worker was actually responsive before proceeding
- Impact: More reliable worker startup with proper health verification

## Installation

Install via Claude Code marketplace:
```bash
/plugin marketplace add https://raw.githubusercontent.com/thedotmack/claude-mem/main/.claude-plugin/marketplace.json
/plugin install claude-mem
```

## Full Changelog
[View all changes](https://github.com/thedotmack/claude-mem/compare/v5.0.1...v5.0.2)

## [5.0.1] - 2025-11-04

**Breaking Changes**: None (patch version)

**Fixes**:
- Fixed worker service stability issues (PR #47: src/services/worker-service.ts, src/shared/worker-utils.ts)
- Improved worker process management and restart reliability (src/hooks/*-hook.ts)
- Enhanced session management and logging across all hooks
- Removed error/output file redirection from PM2 ecosystem config for better debugging (ecosystem.config.cjs)

**Improvements**:
- Added GitHub Actions workflows for automated code review (PR #48)
  - Claude Code Review workflow (.github/workflows/claude-code-review.yml)
  - Claude PR Assistant workflow (.github/workflows/claude.yml)
- Better worker health checks and startup sequence
- Improved error handling and logging throughout hook lifecycle
- Cleaned up documentation files and consolidated project context

**Technical Details**:
- Modified: src/services/worker-service.ts (stability improvements)
- Modified: src/shared/worker-utils.ts (consistent formatting and readability)
- Modified: ecosystem.config.cjs (removed error/output redirection)
- Modified: src/hooks/*-hook.ts (ensure worker running before processing)
- New: .github/workflows/claude-code-review.yml
- New: .github/workflows/claude.yml
- Rebuilt: plugin/scripts/*.js (all hook executables)
- Impact: More reliable worker service with better error visibility and automated PR assistance

---

**Installation**: See [README](https://github.com/thedotmack/claude-mem#readme) for installation instructions.

## [5.0.0] - 2025-11-04

### BREAKING CHANGES
- **Python dependency for optimal performance**: While the plugin works without Python, installing Python 3.8+ and the Chroma MCP server unlocks semantic search capabilities. Without Python, the system falls back to SQLite FTS5 keyword search.
- **Search behavior changes**: Search queries now prioritize semantic relevance when Chroma is available, then apply temporal ordering. Keyword-only queries may return different results than v4.x.
- **Worker service changes**: Worker now initializes ChromaSync on startup. If Chroma MCP is unavailable, worker continues with FTS5-only mode but logs a warning.

### Added
- **Hybrid Search Architecture**: Combines ChromaDB semantic search with SQLite temporal/metadata filtering
  - Chroma vector database for semantic similarity (top 100 matches)
  - 90-day temporal recency window for relevant results
  - SQLite hydration in chronological order
  - Graceful fallback to FTS5 when Chroma unavailable
- **ChromaSync Service**: Automatic vector database synchronization
  - Syncs observations, session summaries, and user prompts to Chroma
  - Splits large text fields into multiple vectors for better granularity
  - Maintains metadata for filtering (project, type, concepts, files)
  - Background sync process via worker service
- **get_timeline_by_query Tool**: Natural language timeline search with dual modes
  - Auto mode: Automatically uses top search result as timeline anchor
  - Interactive mode: Shows top N results for manual anchor selection
  - Combines semantic search discovery with timeline context retrieval
- **User Prompt Semantic Search**: Raw user prompts now indexed in Chroma for semantic discovery
- **Enhanced MCP Tools**: All 8 existing search tools now support hybrid search
  - search_observations - Now uses semantic + temporal hybrid algorithm
  - search_sessions - Semantic search across session summaries
  - search_user_prompts - Semantic search across raw prompts
  - find_by_concept, find_by_file, find_by_type - Enhanced with semantic capabilities
  - get_recent_context - Unchanged (temporal only)
  - get_context_timeline - Unchanged (anchor-based temporal)

### Changed
- **Search Server**: Expanded from ~500 to ~1,500 lines with hybrid search implementation
- **Worker Service**: Now initializes ChromaSync and handles Chroma MCP lifecycle
- **Search Pipeline**: Now follows semantic-first strategy with temporal ordering
  ```
  Query → Chroma Semantic Search (top 100) → 90-day Filter → SQLite Hydration (temporal order) → Results
  ```
- **Worker Resilience**: Worker no longer crashes when Chroma MCP unavailable; gracefully falls back to FTS5

### Fixed
- **Critical temporal filtering bug**: Fixed deduplication and date range filtering in search results
- **User prompt formatting bug**: Corrected field reference in search result formatting
- **Worker crash prevention**: Worker now handles missing Chroma MCP gracefully instead of crashing

### Technical Details
- New files:
  - src/services/sync/ChromaSync.ts (738 lines) - Vector database sync service
  - experiment/chroma-search-test.ts - Comprehensive hybrid search testing
  - experiment/chroma-sync-experiment.ts - Vector sync validation
  - docs/chroma-search-completion-plan.md - Implementation planning
  - FEATURE_PLAN_HYBRID_SEARCH.md - Feature specification
  - IMPLEMENTATION_STATUS.md - Testing and validation results
- Modified files:
  - src/servers/search-server.ts (+995 lines) - Hybrid search algorithm implementation
  - src/services/worker-service.ts (+136 lines) - ChromaSync integration
  - src/services/sqlite/SessionStore.ts (+276 lines) - Enhanced timeline queries
  - src/hooks/context-hook.ts - Type legend improvements
- Validation: 1,390 observations synced to 8,279 vector documents
- Performance: Semantic search with 90-day window returns results in <200ms

## [4.3.4] - 2025-11-02

**Breaking Changes**: None (patch version)

**Fixes**:
- Fixed SessionStart hooks running on session resume (plugin/hooks/hooks.json:4)
- Added matcher configuration to only run SessionStart hooks on startup, clear, or compact events
- Prevents unnecessary hook execution and improves performance on session resume

**Technical Details**:
- Modified: plugin/hooks/hooks.json:4 (added `"matcher": "startup|clear|compact"`)
- Impact: Hooks now skip execution when resuming existing sessions

## [4.3.3] - 2025-10-27

**Breaking Changes**: None (patch version)

**Improvements**:
- Made session display count configurable via constant (DISPLAY_SESSION_COUNT = 8) in src/hooks/context-hook.ts:11
- Added first-time setup detection with helpful user messaging in src/hooks/user-message-hook.ts:12-39
- Improved user experience: First install message clarifies why it appears under "Plugin Hook Error"

**Fixes**:
- Cleaned up profanity in code comments (src/hooks/context-hook.ts:3)
- Fixed first-time setup UX by detecting missing node_modules and showing informative message

**Technical Details**:
- Modified: src/hooks/context-hook.ts:11 (configurable DISPLAY_SESSION_COUNT constant)
- Modified: src/hooks/user-message-hook.ts:12-39 (first-time setup detection and messaging)
- Modified: plugin/scripts/context-hook.js (rebuilt)
- Modified: plugin/scripts/user-message-hook.js (rebuilt)

## [4.3.2] - 2025-10-27

**Breaking Changes**: None (patch version)

**Improvements**:
- Added user-message-hook for displaying context to users via stderr mechanism
- Enhanced context visibility: Hook fires simultaneously with context injection, sending duplicate message as "error" so Claude Code displays it to users
- Added comprehensive documentation (4 new MDX files covering architecture evolution, context engineering, hooks architecture, and progressive disclosure)
- Improved cross-platform path handling in context-hook

**Technical Details**:
- New files:
  - src/hooks/user-message-hook.ts (stderr-based user-facing context display)
  - plugin/scripts/user-message-hook.js (built hook executable)
  - docs/architecture-evolution.mdx (801 lines)
  - docs/context-engineering.mdx (222 lines)
  - docs/hooks-architecture.mdx (784 lines)
  - docs/progressive-disclosure.mdx (655 lines)
- Modified:
  - plugin/hooks/hooks.json (added user-message-hook configuration)
  - src/hooks/context-hook.ts (improved path handling)
  - scripts/build-hooks.js (build support for new hook)
- Design rationale: Error messages don't get added to context, so we intentionally duplicate context output via stderr for user visibility. This is a temporary workaround until Claude Code potentially adds ability to share messages with both user and context simultaneously.

## [4.3.1] - 2025-10-26

## Fixes

- **Fixed SessionStart hook context injection** by silencing npm install output (`plugin/hooks/hooks.json:25`)
- Changed npm loglevel from `--loglevel=error` to `--loglevel=silent` to ensure clean JSON output
- **Consolidated hooks architecture** by removing bin/hooks wrapper layer (`src/hooks/*-hook.ts`)
- Fixed double shebang issues in hook executables (esbuild now adds shebang during build)

## Technical Details

- **Modified**: `plugin/hooks/hooks.json` (npm install verbosity)
- **Removed**: `src/bin/hooks/*` (wrapper layer no longer needed)
- **Consolidated**: Hook logic moved directly into `src/hooks/*-hook.ts` files
- **Root cause**: npm install stderr/stdout was polluting hook JSON output, preventing context injection

## Breaking Changes

None (patch version)

---

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v4.3.0...v4.3.1

## [4.3.0] - 2025-10-25

## What's Changed
* feat: Enhanced context hook with session observations and cross-platform improvements by @thedotmack in https://github.com/thedotmack/claude-mem/pull/25

## New Contributors
* @thedotmack made their first contribution in https://github.com/thedotmack/claude-mem/pull/25

**Full Changelog**: https://github.com/thedotmack/claude-mem/compare/v4.2.11...v4.3.0

## [4.2.10] - 2025-10-25

## Fixed
- **Windows compatibility**: Removed hardcoded macOS-specific Claude executable path that prevented worker service from running on Windows

## Changes
- Removed hardcoded path: `/Users/alexnewman/.nvm/versions/node/v24.5.0/bin/claude`
- Removed `pathToClaudeCodeExecutable` parameter from SDK query() calls  
- SDK now automatically detects Claude Code executable path on all platforms
- Improved cross-platform compatibility (Windows, macOS, Linux)

## Technical Details
- Updated `src/sdk/worker.ts` to remove hardcoded Claude path and `pathToClaudeCodeExecutable` parameter
- Updated `src/services/worker-service.ts` to remove hardcoded Claude path and parameter
- Built `plugin/scripts/worker-service.cjs` reflects changes
- Affects all SDK agent initialization in worker service

## Impact
- **Before**: Worker service failed on Windows due to hardcoded macOS path
- **After**: Worker service works correctly on all platforms

## Files Changed
- `src/sdk/worker.ts`
- `src/services/worker-service.ts`
- `plugin/scripts/worker-service.cjs` (rebuilt)

## [4.2.3] - 2025-10-24

## [4.2.1] - 2025-10-23

## [3.9.16] - 2025-10-07

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.9.16
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.9.14] - 2025-10-04

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.9.14
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.9.13] - 2025-10-04

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.9.13
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.9.12] - 2025-10-04

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.9.12
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.9.11] - 2025-10-04

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.9.11
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.9.10] - 2025-10-03

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.9.10
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.9.9] - 2025-10-03

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.9.9
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.7.2] - 2025-09-22

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.7.2
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.7.1] - 2025-09-18

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.7.1
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.7.0] - 2025-09-18

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.7.0
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.10] - 2025-09-17

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.10
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.9] - 2025-09-15

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.9
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.8] - 2025-09-14

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.8
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.6] - 2025-09-14

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.6
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.5] - 2025-09-14

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.5
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.4] - 2025-09-14

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.4
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.3] - 2025-09-11

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.3
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.2] - 2025-09-11

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.2
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.1] - 2025-09-10

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.1
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.6.0] - 2025-09-10

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.6.0
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.5.9] - 2025-09-10

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.5.9
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.5.8] - 2025-09-10

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.5.8
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.5.7] - 2025-09-10

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.5.7
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.5.6] - 2025-09-09

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.5.6
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.5.5] - 2025-09-09

## What's New

This release includes the latest updates from the npm package.

### Installation
```bash
npm install -g claude-mem@3.5.5
```

### Quick Start
```bash
claude-mem install
```

For full documentation, visit the [README](https://github.com/thedotmack/claude-mem#readme).

## [3.5.4] - 2025-09-09

## 🎉 claude-mem v3.5.4

### Installation
```bash
npm install -g claude-mem
claude-mem install
```

### What's New
- Enhanced memory compression and loading
- Improved hook system reliability  
- Better error handling and logging
- Updated dependencies
- Bug fixes and performance improvements

### Key Features
- 🧠 **Intelligent Memory Compression** - Automatically extracts key learnings from Claude Code conversations
- 🔄 **Seamless Integration** - Works invisibly in the background with /compact and /clear commands
- 🎯 **Smart Context Loading** - Loads relevant memories when starting new sessions
- 📚 **Comprehensive Knowledge Base** - Stores solutions, patterns, and decisions
- 🔍 **Powerful Search** - Vector-based semantic search across all memories

### Files Included
- `dist/claude-mem.min.js` - Minified CLI executable
- `hooks/` - Claude Code integration hooks
- `commands/` - Claude Code custom commands
- `package.json` - Package configuration

### Requirements
- Node.js 18+
- Claude Code CLI
- uv (automatically installed if missing)

For documentation and support, visit the [GitHub repository](https://github.com/thedotmack/claude-mem).
