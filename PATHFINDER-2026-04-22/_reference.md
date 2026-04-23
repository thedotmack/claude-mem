# PATHFINDER-2026-04-22 Reference

Verified API signatures, current-code anchors, and canonical snippets. Every plan in this corpus cites this document for exact file:line anchors and verified APIs.

**Verification date**: 2026-04-22. Anchors verified by direct file read. External APIs verified against documentation and usage patterns.

---

## Correction to prior conversation assumptions

1. **Bun.spawn does NOT support `detached` option.** `detached: true` is a Node `child_process.spawn` option, not a Bun one.
2. **claude-mem uses Node's `child_process`, not `Bun.spawn`.** Every subprocess spawn in the codebase uses `node:child_process.spawn`/`spawnSync` (verified by cross-check with Deno migration audit). So `detached: true` + `setsid` IS available to us — through the Node API, not through Bun.
3. **`respawn` npm package is NOT currently a dependency.** Adding it is a new-dep decision.
4. **`fs.watch(dir, { recursive: true })` on Linux requires Node 20+.** `package.json` currently pins `>=18.0.0`. Preflight: bump to `>=20.0.0`.

---

## Part 1: Current-code anchors

### Data layer

**`src/services/sqlite/PendingMessageStore.ts:99-145` — `claimNextMessage`**

Transaction-wrapped claim. Resets stale rows (`status='processing'` older than `STALE_PROCESSING_THRESHOLD_MS=60_000`) INSIDE the claim transaction. The self-heal block (lines 107-115) is the target of Plan `01-data-integrity` Phase 4.

**`src/services/sqlite/PendingMessageStore.ts:486-495` — `clearFailedOlderThan`**

`DELETE FROM pending_messages WHERE status='failed' AND COALESCE(failed_at_epoch,…) < ?`. Currently called from 2-minute interval at `worker-service.ts:567`. Moves to boot-once OR gets deleted entirely (Plan 02 principles: if nothing needs purge, don't purge).

**`src/services/sqlite/PendingMessageStore.ts:349-374` — `markFailed`**

Retry ladder: reads `retry_count`, bumps to `pending` if `< maxRetries`, marks `failed` otherwise. Principle decision for Plan 01: retry exists for a reason (transient SDK failures); KEEP the ladder but verify `maxRetries` is reasonable (currently 3).

**`src/services/sqlite/Database.ts:37-130` — `repairMalformedSchema`**

Python subprocess fallback when SQLite reports `malformed database schema`. Writes script to tempfile, execFileSync. Closes connection first to avoid lock conflicts. Target for Plan `07-dead-code` deletion — this is cross-machine WAL corruption that should be root-caused, not repaired.

**`src/services/sqlite/migrations/runner.ts:621-628` — Migration 19 (DEPRECATED)**

No-op after migration 17 made renames idempotent. Records itself as applied, does nothing. Dead code. Plan `07-dead-code` deletes with next schema.sql regeneration.

**`src/services/sqlite/migrations/runner.ts:658-837` — Migration 21 (FK cascade fix)**

Recreates `observations` + `session_summaries` tables to add `ON UPDATE CASCADE`. Exists because an earlier design allowed `memory_session_id` mutations. Plan `01-data-integrity` §Invariants: `memory_session_id` must be immutable post-creation; if this holds, migration 21 is a one-time historical fix, safe to absorb into `schema.sql`.

**`src/services/sqlite/observations/store.ts:13-46` — `DEDUP_WINDOW_MS` + `findDuplicateObservation`**

30-second content-hash dedup window. Plan `01-data-integrity` Phase 2 replaces with DB `UNIQUE(memory_session_id, content_hash)` constraint + `ON CONFLICT DO NOTHING`.

**`src/services/sqlite/SessionStore.ts:52-70` — Duplicated migration logic**

Re-calls every `ensure*` / `add*` migration method already owned by `MigrationRunner`. Plan `07-dead-code`: SessionStore delegates to a single `new MigrationRunner(db).runAllMigrations()`.

**`src/services/sync/ChromaSync.ts:290-318` — Delete-then-add reconciliation**

Chroma MCP has no upsert. On `already exist` error, the code deletes the IDs then re-adds. Plan `01-data-integrity` §Chroma: document the brittle error-text match; consider guarding behind a flag until Chroma exposes upsert natively.

### Worker / lifecycle

**`src/services/worker/ProcessRegistry.ts:244-309` — `killIdleDaemonChildren`**

Walks `ps -eo` output, filters by `ppid == daemonPid`, kills any child idle > 1 minute. Used by 30s-interval `startOrphanReaper`. Plan `02-process-lifecycle` DELETES (function body) — replaced by process-group teardown.

**`src/services/worker/ProcessRegistry.ts:315-344` — `killSystemOrphans`**

ppid=1 sweep matching `claude.*haiku|claude.*output-format`. Plan `02-process-lifecycle` DELETES — orphans are prevented by process-group spawning, not swept.

**`src/services/worker/ProcessRegistry.ts:349-382` — `reapOrphanedProcesses`**

Three-layer cleanup (registry-tracked, ppid=1, idle daemon children). DELETES wholesale.

**`src/services/worker/ProcessRegistry.ts:452-465` — spawn site for Claude SDK children**

Currently uses `spawn(command, args, { stdio: 'pipe', … })` with NO `detached` and NO process group. Plan `02-process-lifecycle` Phase 2: change to `spawn(cmd, args, { detached: true, stdio: ['ignore','pipe','pipe'] })` and track via `pgid`.

**`src/services/worker/worker-service.ts:537, 547, 567, 581, 1094-1120`**

- `:537` — `startOrphanReaper` call
- `:547` — `staleSessionReaperInterval = setInterval(…)`
- `:567` — `clearFailedOlderThan` interval
- `:581` — explicit `PRAGMA wal_checkpoint(PASSIVE)` interval
- `:1094-1120` — shutdown sequence (clears intervals, calls `performGracefulShutdown`)

Plan `02-process-lifecycle` deletes all interval setup and collapses shutdown.

**`src/supervisor/process-registry.ts:85-173` — `captureProcessStartToken`**

Reads `/proc/<pid>/stat` field 22 on Linux, `ps -o lstart=` on macOS, returns `null` on Windows. Used for PID-reuse detection (commit 99060bac). Plan `02-process-lifecycle` KEEPS — legitimate primary-path correctness.

**`src/supervisor/shutdown.ts:22-99, 116, 163` — `runShutdownCascade`**

5-phase: SIGTERM all → wait 5s → SIGKILL survivors → wait 1s → unregister + rm PID file. Uses `process.kill(pid, signal)` — SINGLE-PID, not process group. Plan `02-process-lifecycle` Phase 3: change to `process.kill(-pgid, signal)` where children have their own process groups.

**`src/services/worker/SessionManager.ts:397, 477, 516-568, 573-579, 631-670`**

- `:397` — `deleteSession(sessionDbId)` — awaits generator + subprocess exit
- `:477-506` — `evictIdlestSession` (pool-eviction, candidate for DELETE per Tier 1 #11)
- `:516-568` — `reapStaleSessions` (DELETE per Plan 02)
- `:573-579` — `shutdownAll`
- `:631-670` — `getMessageIterator` (idle-timer callback is second-system per earlier audit)

**`src/services/worker/SessionQueueProcessor.ts:6, 51-52, 62-63, 130, 145`**

Per-iterator idle `setTimeout` (3-min). Plan `02-process-lifecycle` §Invariants: this is per-session not global-scanner. KEEP as the only runtime defense against hung SDK generators.

**`src/services/infrastructure/GracefulShutdown.ts:52-86` — `performGracefulShutdown`**

6-step canonical shutdown (HTTP server close → sessions → MCP → Chroma → DB → supervisor). Plan `06-api-surface` CONSOLIDATES — currently four shutdown functions (`WorkerService.shutdown`, `performGracefulShutdown`, `runShutdownCascade`, `stopSupervisor`) collapse to this one.

**`src/services/infrastructure/ProcessManager.ts:1013-1032, 1053-1075`**

Daemon spawn + liveness. `:1013` uses `setsid` on Unix, `:1028` falls back to `detached: true` on macOS. Liveness at `:1053-1075` is plain `process.kill(pid, 0)`. Plan `02-process-lifecycle` KEEPS daemon spawn pattern; extends to SDK children.

### Ingestion

**`src/sdk/parser.ts:33-111` — `parseObservations`**

Parses `<observation>` blocks. Fallback type logic (line 54-69) is legitimate (type field is optional per schema). KEEP.

**`src/sdk/parser.ts:122-259` — `parseSummary` + `coerceObservationToSummary`**

`coerceObservationToSummary` at lines 222-259 is a second-system effect (maps `<observation>` fields to `<summary>` when LLM violates contract). Plan `03-ingestion-path` DELETES the coerce function. Contract violations must fail-fast to `markFailed`, not coerce.

**`src/services/worker/agents/ResponseProcessor.ts:96-200` — Circuit breaker**

`consecutiveSummaryFailures` + `MAX_CONSECUTIVE_SUMMARY_FAILURES`. Plan `03-ingestion-path` DELETES field, constant, guard.

**`src/services/transcripts/processor.ts:23, 202, 232-236, 252, 275-285, 317`**

- `:23` — `pendingTools` Map (per-session toolId → toolInput)
- `:202, :232-236` — dispatcher pairing `tool_use` with `tool_result`
- `:252` — HTTP loopback (`observationHandler.execute()` → `workerHttpRequest` → same worker)
- `:275-285` — `maybeParseJson` silent passthrough

Plan `03-ingestion-path` Phase 1 deletes the Map; Phase 2 routes through direct function call `ingestObservation(payload)` (no HTTP loopback); Phase 3 changes `maybeParseJson` to fail-fast.

**`src/services/transcripts/watcher.ts:124-132, 156-159, 183-188`**

- `:124-132` — 5-second `setInterval` rescan
- `:156-159` — `resolveWatchFiles` silent empty-return on stat() failure
- `:183-188` — `startAtEnd` offset fallback (benign, KEEP)

Plan `03-ingestion-path` replaces rescan with `fs.watch(dir, { recursive: true })`.

**`src/utils/tag-stripping.ts:37-44, 63-69` — `countTags`, `stripTagsInternal`**

Six separate `.replace()` / `.match()` calls for six tag types. Plan `03-ingestion-path` §Tag stripping: one regex with alternation, single-pass.

**`src/utils/transcript-parser.ts:28-90` — DEAD CLASS**

`TranscriptParser` class exists but has no active imports. Plan `07-dead-code` DELETES.

**`src/shared/transcript-parser.ts:41-144` — Active function**

`extractLastMessage(path, role, opts)` — the active parser. KEEP.

### Search / read path

**`src/services/worker/search/SearchOrchestrator.ts:85-110` — Silent fallback**

Three paths: (1) filter-only → SQLite, (2) query + Chroma → try Chroma, on `usedChroma=false` strip query and re-query SQLite, (3) no Chroma → empty silent. Plan `04-read-path` Phase 1: DELETE the stripping branch. On Chroma failure, throw 503.

**`src/services/worker/search/strategies/ChromaSearchStrategy.ts:76-86`**

`try { … } catch { return usedChroma: false }` swallows real errors. Plan `04-read-path` Phase 1: only return `usedChroma: false` when Chroma is explicitly not initialized; propagate real errors.

**`src/services/worker/search/strategies/HybridSearchStrategy.ts:64-185`**

Three near-identical methods (`findByConcept`, `findByType`, `findByFile`) each with its own try/catch fallback to metadata-only. Plan `04-read-path` Phase 2: propagate errors, don't silently degrade to metadata-only.

**`src/services/worker/SearchManager.ts:230, 247-259, 488, 978-985, 1064-1071, 1150-1157, 1209-1310, 1277, 1399, 1840-1847`**

- Seven duplicated recency-filter call sites
- `findByConcept/File/Type` implementations that duplicate `HybridSearchStrategy`

Plan `04-read-path` Phase 3: import `RECENCY_WINDOW_MS` from `types.ts:16`, delete the seven copies; delete `SearchManager.findBy*` methods and route through `SearchOrchestrator`.

**`src/services/worker/search/ResultFormatter.ts:264` vs `src/services/worker/knowledge/CorpusRenderer.ts:90`**

Two different token estimates. Plan `04-read-path` §Utilities: one shared `estimateTokens(obs)` in `src/shared/`.

**`src/services/context/formatters/`** — four formatters (AgentFormatter, HumanFormatter, ResultFormatter, CorpusRenderer) share a common walk with four strategy knobs (header, grouping, row density, colors). Plan `04-read-path` Phase 4: single `renderObservations(obs, strategy: RenderStrategy)`.

### Hooks / CLI

**`src/shared/worker-utils.ts:221-239` — `ensureWorkerRunning`**

Single health check, returns false on failure. Caller decides whether to proceed. Plan `05-hook-surface` §Primary path: KEEP the check; REPLACE "proceed gracefully" with consecutive-failure counter that exits code 2 after N failures (surface worker death instead of hiding it).

**`src/cli/handlers/summarize.ts:117-150` — 120s polling loop**

Polls every 1s for 120s waiting for summary completion, logs `timeout` on failure but exits 0. Plan `05-hook-surface` Phase 2: replace with blocking `/api/session/end` endpoint (server-side wait, single HTTP POST with server-side timeout). Delete the polling loop.

**`src/cli/handlers/session-init.ts:57-60, 120-129`**

Settings loaded per-handler. Agent init conditional on `initResult.contextInjected` → skips agent spawn when context already present. Plan `05-hook-surface` Phase 1: settings cached once per hook process. Phase 3: agent init is idempotent (always call).

**`src/cli/handlers/observation.ts:17, 53-54, 58-61`**

HTTP loopback + cwd validation after adapter normalization + project exclusion. Plan `05-hook-surface` §DRY: `executeWithWorkerFallback()` helper; cwd validation moves to adapter boundary.

**`plugin/hooks/hooks.json:27, 32, 43` — Shell retry loops**

20-iteration `curl` health-check retries across three hook entries. Plan `05-hook-surface` Phase 1: delete shell retries; `ensureWorkerRunning()` does the one check.

### API surface

**`src/services/worker/http/routes/DataRoutes.ts:305, 475, 510, 529, 548`**

- `:305` — `/api/processing-status` (KEEP)
- `:475` — `/api/pending-queue` GET inspection (DELETE)
- `:510` — `/api/pending-queue/process` POST (convert to internal startup call or DELETE)
- `:529` — `/api/pending-queue/failed` DELETE (DELETE)
- `:548` — `/api/pending-queue/all` DELETE (DELETE)

Plan `06-api-surface` Phase 1: delete diagnostic endpoints.

**`src/services/worker/http/routes/SessionRoutes.ts:148, 256`** — threshold check + markSessionMessagesFailed. Plan `06-api-surface` consolidates failure-marking paths.

---

## Part 2: External API verification

| API | Verified | Signature | Canonical use | Source |
|---|---|---|---|---|
| **Node `child_process.spawn({ detached: true })`** | ✅ yes | `spawn(cmd, args, { detached: true, stdio: ['ignore','pipe','pipe'] })` | Creates new process group on Unix (`setpgid`). Child survives parent death unless parent signals group. | Node docs: https://nodejs.org/api/child_process.html#optionsdetached |
| **Node `process.kill(-pgid, signal)`** | ✅ yes | Negative PID signals the whole process group on Unix. Works in Bun (uses libuv). | `process.kill(-pgid, 'SIGTERM')` tears down the whole child subtree. | POSIX kill(2); Node docs. |
| **Bun.spawn `detached`** | ❌ NOT SUPPORTED | No `detached` option. Use `proc.unref()` for detach-from-parent-exit behavior only. | Not applicable to claude-mem — claude-mem uses Node API. | Bun docs: https://bun.com/docs/runtime/child-process |
| **SQLite `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`** | ✅ yes | `INSERT INTO t (a,b) VALUES (?,?) ON CONFLICT(a,b) DO NOTHING` | Idempotent insert; silently skips row on UNIQUE violation. | SQLite core docs. |
| **SQLite UNIQUE on added column** | ✅ yes with caveat | `ALTER TABLE t ADD COLUMN c TEXT` then `CREATE UNIQUE INDEX ux_t_c ON t(c)` | Must backfill `c` before creating unique index, or backfill with unique random values. See migration 22 precedent in runner.ts. | SQLite ALTER TABLE limitations doc. |
| **`fs.watch(dir, { recursive: true })` on Linux** | ✅ Node 20+ only | Recursive mode works on Linux in Node 20+ (was macOS/Windows-only earlier). | `fs.watch(transcriptsRoot, { recursive: true }, (eventType, filename) => {…})` | Node 20 release notes. **Preflight: bump `engines.node` to `>=20.0.0`.** |
| **Claude Code hook exit codes** | ✅ per claude-mem CLAUDE.md | 0 = success / graceful shutdown; 1 = non-blocking error (stderr to user); 2 = blocking error (stderr fed back to Claude) | `process.exit(0)` default; `process.exit(2)` to surface consecutive failures. | `CLAUDE.md` §Exit Code Strategy. |
| **launchd user LaunchAgent plist** | ✅ (not currently used) | `<key>KeepAlive</key><true/>` + `<key>ProgramArguments</key>…` in `~/Library/LaunchAgents/ai.cmem.worker.plist` | Documented for future installer if/when we adopt OS-supervised fallback. | Apple: launchd.plist(5). |
| **systemd user unit** | ✅ (not currently used) | `[Service]\nType=simple\nExecStart=/path/to/bun worker.js\nRestart=on-failure\nKillMode=control-group` | Documented for future installer. | systemd.service(5), systemd.kill(5). |
| **`respawn` npm package** | ✅ exists, NOT currently a dep | `respawn(command, opts).start()` with `maxRestarts`, `sleep`, `kill`. ~200 LOC pure JS. | Optional — only needed in the lazy-spawn wrapper for startup-crash retries. | https://github.com/mafintosh/respawn |

---

## Part 3: Plugin conventions

| Concern | File | Pattern |
|---|---|---|
| Hook manifest | `plugin/hooks/hooks.json` | Setup, SessionStart, UserPromptSubmit, PreToolUse (Read matcher), PostToolUse, Stop, SessionEnd. Each shell-wraps `bun-runner.js` → `worker-service.cjs`. |
| Hook build targets | `plugin/scripts/*-hook.js` | TS source in `src/hooks/` and `src/cli/handlers/` → esbuild → `plugin/scripts/*-hook.js` (ESM). |
| Settings schema | `src/services/domain/SettingsDefaultsManager.ts` | `loadFromFile(USER_SETTINGS_PATH)`. Flat key-value schema. Accepts `'true'` string OR boolean `true`. |
| Privacy tags | `src/utils/tag-stripping.ts` | Six tag types: `<private>`, `<claude-mem-context>`, `<system-reminder>`, etc. Single-pass strip at every ingress (after Plan 03). |
| HTTP loopback replacement | (future) `src/services/worker/http/shared.ts` | `ingestObservation(payload)` → direct function call. Hooks still use HTTP (cross-process); worker→worker uses function call. |
| Observation XML | `src/sdk/parser.ts` | `<observation type="…"><title/><narrative/><facts><fact/>…</facts>…</observation>`. |
| Summary XML | `src/sdk/parser.ts` | `<summary><request/><investigated/><learned/><completed/><next_steps/><notes/></summary>`. Optional `<skip_summary reason="…"/>` bypass. |
| Project scoping | `src/utils/project-name.ts` | `getProjectContext(cwd)` → `{ primary, allProjects, excluded }`. Excluded list from settings. |

---

## Part 4: Confidence + gaps

**Confidence: HIGH (95%)** — all anchors verified by direct read, all external APIs verified against docs.

**Known gaps to flag in plans**:

1. **Chroma upsert fallback is brittle** — error-text match for "already exist". Plan 01 must guard behind a flag until Chroma exposes upsert natively.
2. **Prompt-caching TTL assumption** — Plan 04 depends on SDK cache TTL ≈ 5 min. Run a cost smoke test before Plan 10 lands.
3. **Node 20+ requirement** — Plan 03 Phase 1 requires `fs.watch` recursive on Linux. Preflight: `engines.node` bump.
4. **Zod is not currently a dep** — Plan 06 Phase 1 is `npm install zod@^3.x`.
5. **`respawn` dep is optional** — Plan 02 §Lazy-spawn wrapper: decide in that plan whether to add `respawn` or hand-roll a 3-attempt startup retry.
6. **Two registries today** — `src/services/worker/ProcessRegistry.ts` + `src/supervisor/process-registry.ts`. Plan 02 consolidates to supervisor-only.

---

**Status: READY FOR CORPUS AUTHORING.** All plans in `PATHFINDER-2026-04-22/` may cite this file directly.
