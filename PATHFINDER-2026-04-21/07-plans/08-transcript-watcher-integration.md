# Plan 08 — transcript-watcher-integration (clean)

**Feature scope**: `src/services/transcripts/*` + `src/cli/handlers/observation.ts` HTTP loopback.
**Source of truth (design)**: `PATHFINDER-2026-04-21/05-clean-flowcharts.md` § 3.12; Part 1 items #17, #18, #19.
**Phase-7 counterpart in 06**: `PATHFINDER-2026-04-21/06-implementation-plan.md` Phase 7 (Transcript watcher cleanup).
**Before-state**: `PATHFINDER-2026-04-21/01-flowcharts/transcript-watcher-integration.md`.

## Dependencies (must land first)

| Plan | Dependency | What this plan consumes |
|---|---|---|
| `07-plans/01-privacy-tag-filtering.md` | `stripMemoryTags(text)` (06 Phase 1) | Single call used inside `ingestObservation`. We never strip in the watcher. |
| `07-plans/07-session-lifecycle-management.md` | `ingestObservation(payload)` helper (06 Phase 2) + `SessionManager.initializeSession` / `endSession` direct API (06 § 3.8) | Watcher calls the helper **directly** (no `workerHttpRequest`, no `observationHandler.execute`). Session lifecycle routes `session_init` / `session_end` to `SessionManager` without HTTP. |

Downstream dependents: **none**.

## Dependency-verified facts (live-code citations)

- **V18 confirmed** (`06-implementation-plan.md:45`). All three artifacts still present:
  - 5-s rescan timer — `src/services/transcripts/watcher.ts:124` (`rescanIntervalMs ?? 5000`) + `setInterval(...)` at `:125`.
  - `pendingTools` map — `src/services/transcripts/processor.ts:23` (in `SessionState` interface) + `.set` at `:202`, `.get/.delete` at `:232-236`, `.clear` at `:317`.
  - HTTP loopback — `src/cli/handlers/observation.ts:17` loops through `workerHttpRequest('/api/sessions/observations', ...)`. Chain: watcher.ts:221 → processor.ts:252 `observationHandler.execute` → observation.ts:17 `workerHttpRequest` back to the same worker. This is the "call the CLI handler from inside the worker, which HTTP-loops back to the worker" anti-pattern.
- **Schema list (exhaustive)**: only **one** JSONL transcript schema ships today: **Codex**, defined in `src/services/transcripts/config.ts:9` as `CODEX_SAMPLE_SCHEMA` (confirming `63472 — CODEX_SAMPLE_SCHEMA in config.ts is the source of truth`). The live config file is `transcript-watch.example.json` (line 1-95) which registers only `codex` under `schemas.codex`. The `CodexCliInstaller.ts` is the only installer that merges JSONL schemas into `~/.claude-mem/transcript-watch.json` (`src/services/integrations/CodexCliInstaller.ts:97-99`).
  - `CursorHooksInstaller.ts`, `OpenCodeInstaller.ts`, `GeminiCliHooksInstaller.ts` do **not** register JSONL transcript schemas — they install **PostToolUse hooks** that feed the CLI observation handler directly (same path as Claude Code's own hooks). They do not touch the transcript watcher.
  - **The audit's "Cursor, OpenCode, Gemini-CLI" for transcript ingestion is accurate only at the user-facing-feature level (these agents' activity is captured), but the capture path for those three is the hook handler chain, not the JSONL watcher.** The watcher's only current JSONL client is Codex.
- **tool_use_id availability in Codex schema** (`src/services/transcripts/config.ts:47-77`):
  - `tool-use` event: `toolId: 'payload.call_id'` — present on `function_call`, `custom_tool_call`, `web_search_call`, `exec_command`.
  - `tool-result` event: `toolId: 'payload.call_id'` — present on `function_call_output`, `custom_tool_call_output`, `exec_command_output`.
  - **Both sides always carry `call_id`** in the Codex schema. No fallback needed for Codex.
  - **Schema-driven, not hard-coded**: the `toolId` field is part of the `SchemaEvent.fields` contract (`src/services/transcripts/types.ts:34`). Any future schema that wants to use the transcript watcher must set `fields.toolId` on both its tool_use and tool_result events, or pair them some other way. Phase 2 below documents this contract explicitly.
- **Watched parent dir per schema**: `~/.codex/sessions/**/*.jsonl` (`config.ts:95`, `transcript-watch.example.json:83`). The glob matches files recursively under `~/.codex/sessions/`. The parent dir to pass to `fs.watch(..., { recursive: true })` is the **glob-root**: `expandHomePath('~/.codex/sessions')` (everything before the first glob metachar). `resolveWatchFiles()` at `watcher.ts:143-163` already understands glob vs plain-dir vs plain-file — the new watch code will derive the root the same way.
- **fs.watch recursive support**: supported on macOS, Linux (kernel >= 2.6.36 via `inotify`, but Node's recursive option landed with macOS + Windows in 0.x and Linux in Node 20 via libuv). CI target: `package.json:58` declares `"node": ">=18.0.0"`. **Recursive fs.watch on Linux requires Node 20+**; we must bump the engines floor (see Gaps). Bun supports `fs.watch` recursive on all three platforms.
- **FileTailer location**: `src/services/transcripts/watcher.ts:15-81` (unchanged by this plan — lines already do the byte-offset-tail correctly; only the file-discovery layer changes).

## Phase contract (applies to every phase below)

- **(a) Copy from** `05-clean-flowcharts.md` § 3.12 (canonical flowchart).
- **(b) Docs** at the top of each phase: 05 section ref + 06 verified finding (V-number) + live file:line.
- **(c) Verification** is mechanical: a `grep` count, a runtime test, or a file existence check.
- **(d) Anti-pattern guards** — every phase cites (from `06:59-66`):
  - **A** — no invented APIs. Grep for the method before using it.
  - **B** — no polling; `fs.watch` events only (no rescan `setInterval`).
  - **E** — one code path for observation ingest; watcher + CLI hook both call `ingestObservation`, never a second path.

---

## Phase 1 — Parent-directory recursive watch replaces per-file `fs.watch` + 5 s rescan

**Goal**: `fs.watch(parentDir, { recursive: true }, onFileEvent)` supplants both the per-file `fsWatch(filePath, ...)` in `FileTailer` and the `setInterval(..., rescanIntervalMs)` rescan in `TranscriptWatcher`.

### (a) What to implement — Copy from § 3.12

From the clean flowchart (`05-clean-flowcharts.md:484-500`):

```
Boot["Worker startup"] --> LoadCfg["loadTranscriptWatchConfig"]
LoadCfg --> ParentWatch["fs.watch(parent_dir, {recursive})
              watches existing files AND new files"]
ParentWatch --> OnChange([File event])
OnChange --> ReadDelta["FileTailer.readNewBytes"]
```

**Code change (watcher.ts)**:

1. Delete the per-file watcher inside `FileTailer` (`src/services/transcripts/watcher.ts:16`, `:28-33`, `:35-38`). `FileTailer` becomes a pure byte-offset reader — no internal `fs.watch` subscription. Rename its `start()` to `readAvailable()` (one-shot tail) and drop the `close()` method (nothing to close now).
2. In `TranscriptWatcher.setupWatch` (`:110`), derive `glob-root` from `watch.path`:
   - If `watch.path` has no glob metachars and is a file: watch `dirname(resolved)` non-recursively.
   - Otherwise: walk the path tokens, stop at the first token containing a glob metachar, join the prefix — that's the root dir (e.g. `~/.codex/sessions/**/*.jsonl` → `~/.codex/sessions`). Use the new helper `getGlobRoot(inputPath): string`.
3. Replace `setInterval(async () => { ... }, rescanIntervalMs)` (`:124-132`) with:

   ```ts
   fs.watch(globRoot, { recursive: true, persistent: true }, (eventType, filename) => {
     if (!filename) return;
     const absPath = path.resolve(globRoot, filename);
     if (!globMatches(absPath, resolvedPath)) return;
     // rename event fires when a new file is created (or renamed/deleted)
     if (!this.tailers.has(absPath) && existsSync(absPath)) {
       this.addTailer(absPath, watch, schema, false).catch(err =>
         logger.warn('TRANSCRIPT', 'addTailer failed on fs.watch event',
           { file: absPath, error: err instanceof Error ? err.message : String(err) }));
     }
     const tailer = this.tailers.get(absPath);
     tailer?.readAvailable().catch(() => undefined);
   });
   ```

4. Update `TranscriptWatcher.stop()` (`:99-108`) to close the single parent watcher per target instead of iterating per-tailer `.close()` + `clearInterval` on the timer array. Delete the `rescanTimers: NodeJS.Timeout[]` field (`:87`).
5. Delete the `rescanIntervalMs?: number` field from `WatchTarget` (`src/services/transcripts/types.ts:61`). Update `CodexCliInstaller.ts` and `transcript-watch.example.json` if either still sets it (grep).

### (b) Docs cited

- 05 § 3.12 lines 482-500 (clean flowchart).
- Part 1 item #19 (`05-clean-flowcharts.md:37`) — "5-s rescan timer for new transcript files".
- V18 (`06-implementation-plan.md:45`) — `rescanIntervalMs ?? 5000` at `watcher.ts:124`.
- Live: `src/services/transcripts/watcher.ts:28` (per-file `fsWatch`), `:124-133` (rescan interval + `setInterval`).

### (c) Verification

- `grep -n "setInterval" src/services/transcripts/` → **zero** matches.
- `grep -n "rescanIntervalMs" src/ transcript-watch.example.json` → **zero** matches.
- Runtime test: start worker against an empty temp dir `T`; wait 1 s; `touch T/new-session.jsonl` then `echo '{"type":"session_meta","payload":{"id":"test","cwd":"/tmp"}}' >> T/new-session.jsonl`; assert a `TRANSCRIPT Watching transcript file` log line appears within **100 ms** of the write (not within the old 5 s window). Follow up with a tool_use line and assert `pending_messages` row appears within another 100 ms.
- `grep -n "new FileTailer.*filePath.*offset.*onLine" src/services/transcripts/` → still exactly one call site in `addTailer` (signature preserved for byte-offset state).

### (d) Anti-pattern guards

- **A**: do not invent a "glob walker" class. A single `getGlobRoot(path: string): string` top-level function is enough.
- **B**: **no** fallback `setInterval` "in case fs.watch misses events". The parent-recursive watch is the contract; missed-event scenarios fall under the Gaps section (Node-version requirement).

### Blast radius

Single file rewrite: `src/services/transcripts/watcher.ts`. Small touch: `types.ts` (drop `rescanIntervalMs`). One touch to `CodexCliInstaller.ts` or `transcript-watch.example.json` only if they reference that deleted option.

---

## Phase 2 — Delete `pendingTools` map; match `tool_use` + `tool_result` by `tool_use_id` at parse time

**Goal**: `SessionState.pendingTools: Map<string, …>` is gone. Tool pairing happens locally inside each log file's tail buffer keyed by `tool_use_id`; the per-session map disappears.

### (a) What to implement — Copy from § 3.12

```
Route -->|tool_use + tool_result paired by tool_use_id| Ingest["ingestObservation({sessionDbId, tool_use_id, name, input, output})"]
```

**Code change (processor.ts)**:

1. Remove `pendingTools: Map<string, {name?, input?}>` from `SessionState` (`src/services/transcripts/processor.ts:23`).
2. Remove `pendingTools: new Map()` from `getOrCreateSession` (`:59`).
3. Rewrite `handleToolUse` (`:193-222`):
   - Move the per-file pairing buffer **out of** the session and **into** `TranscriptWatcher` as a **per-file** map: `private pendingToolUses = new Map<string /* filePath */, Map<string /* tool_use_id */, { name: string; input: unknown; ts: number }>>()`. Inject it as a callback arg, or move the pairing into the processor keyed by file.
   - Simpler option (preferred): keep the short-lived pairing **in the processor keyed by `${watch.name}:${sessionId}:${tool_use_id}`** — it still clears on `tool_result`, but it's keyed by ID, not by session-state entry. Upper bound size with an LRU (`max=10_000`, drop-oldest) to avoid unbounded growth if a tool_use has no matching tool_result.
4. Rewrite `handleToolResult` (`:224-246`) to read from that keyed map; on hit, emit **one** `ingestObservation({sessionDbId, tool_use_id, name, input, output})` call (Phase 3 wires the helper). On miss, log debug + drop (don't synthesize).
5. Drop the `apply_patch` auto-file-edit branch at `:205-213` only if Codex stops sending `tool_use` with `toolResponse` inline — inspecting `handleToolUse` today, there's a legacy branch at `:215-221` that fires `sendObservation` from inside `handleToolUse` when `toolResponse !== undefined`. That branch is the **first half of the duplicated ingest** and must be deleted in Phase 3. Keep the `apply_patch` file-edit branch (`:205-213`); file edits are a separate path not in scope here.
6. Session state retains `lastUserMessage`, `lastAssistantMessage`, `cwd`, `project` — untouched.

### (b) Docs cited

- 05 § 3.12 line 494 ("paired by tool_use_id").
- Part 1 item #17 (`05-clean-flowcharts.md:35`) — "pendingTools map in TranscriptEventProcessor ... match by ID, no state map."
- V18 — pendingTools presence confirmed.
- Live: `src/services/transcripts/processor.ts:23` (interface field), `:59` (init), `:202` (`.set`), `:232-236` (lookup/delete), `:317` (clear on session_end).
- Contract source: Codex schema in `src/services/transcripts/config.ts:47-77` — `toolId: 'payload.call_id'` on both tool_use and tool_result.

### (c) Verification

- `grep -rn "pendingTools" src/` → **zero** matches (interface field, initializer, and three call sites all gone).
- `grep -n "SessionState" src/services/transcripts/processor.ts` — interface still exists, but with `pendingTools` field removed (assert via a small diff check in a test).
- Runtime: replay a recorded Codex JSONL (fixture). Assert the stream of `pending_messages` rows matches byte-for-byte with the pre-refactor run for the same fixture (the pairing semantics are unchanged; we only moved where the map lives).
- Memory test: feed 50 sessions with 1000 tool_use each but **no** tool_result. The LRU bounds at 10k — not unbounded.

### (d) Anti-pattern guards

- **A**: the pairing map is a private field of `TranscriptEventProcessor`, not a new `ToolPairingService` class.
- **E**: only **one** observation ingest call per paired event — delete the `handleToolUse`-inline `sendObservation` branch at `:215-221` in Phase 3.

### Blast radius

`src/services/transcripts/processor.ts` only. No schema contract change (Codex already populates `call_id` on both sides).

---

## Phase 3 — Replace `observationHandler.execute()` HTTP loopback with direct `ingestObservation(payload)`

**Goal**: `sendObservation` no longer calls the CLI handler, which no longer does `workerHttpRequest`. The worker process calls its own helper in-memory.

### (a) What to implement — Copy from § 3.12 + D1

From 05 Part 2 Decision D1 (`:69-70`):

> **D1. One observation ingest path.** Hook, transcript-watcher, and manual-save all call `ingestObservation(payload)`. That function does: strip tags → validate privacy → INSERT `pending_messages`. **No HTTP loopback inside the worker process.**

From § 3.12 line 494 — `ingestObservation({sessionDbId, tool_use_id, name, input, output})`.

**Code change**:

1. In `src/services/transcripts/processor.ts`:
   - Replace `sendObservation` body (`:248-260`) so it builds the `IngestObservationPayload` (matching the shape owned by `07-plans/07-session-lifecycle-management.md`) and calls `await ingestObservation(payload)` directly. No `observationHandler` import.
   - Remove the import of `observationHandler` (`:3`).
   - Remove the import of `workerHttpRequest` and `ensureWorkerRunning` from `../../shared/worker-utils.js` (`:6`) **from the observation path only** — `queueSummary` still hits `/api/sessions/summarize` today and `updateContext` still hits `/api/context/inject`; those two are untouched by Phase 3. Phase 4 deletes both.
2. In `src/services/transcripts/watcher.ts`: no change — the watcher already delegates to `processor.processEntry`; the processor is what imports the helper.
3. `IngestObservationPayload` shape reused from Plan 07 (definition lives in `src/services/worker/ingest/index.ts`):
   ```ts
   { contentSessionId, platformSource, cwd, tool_name, tool_use_id,
     tool_input, tool_response, agentId?, agentType? }
   ```
   Plan 07 additionally adds `tool_use_id` as a required field when the caller is the transcript watcher (already present in hook-path flows via the UNIQUE constraint added in Phase 9 of `06-implementation-plan.md`). Synthesize `tool_use_id = payload.call_id` from the schema's `toolId` field.

### (b) Docs cited

- 05 § 3.12 line 494, Part 2 D1 lines 69-70.
- Part 1 item #18 (`05-clean-flowcharts.md:36`) — "observationHandler.execute() HTTP loopback from transcript-watcher ... Extract ingestObservation helper; both call it directly."
- V18 — `observation.ts:17` HTTP loopback confirmed.
- Live: `src/cli/handlers/observation.ts:17` (`workerHttpRequest('/api/sessions/observations', …)`), `src/services/transcripts/processor.ts:252` (`observationHandler.execute` call site).
- Dependency contract: `07-plans/07-session-lifecycle-management.md` exports `ingestObservation` at `src/services/worker/ingest/index.ts` per `06-implementation-plan.md:126-132`.

### (c) Verification

- `grep -n "observationHandler" src/services/transcripts/` → **zero** matches.
- `grep -n "workerHttpRequest.*observations" src/services/transcripts/` → **zero** matches.
- `grep -n "workerHttpRequest" src/services/transcripts/` → count ≤ 2 (temporarily: `queueSummary` + `updateContext`, deleted in Phase 4).
- `grep -n "workerHttpRequest" src/cli/handlers/observation.ts` → still exactly one (CLI hook path still uses HTTP when the CLI is a separate process from the worker; that's **not** a loopback, it's the hook-to-worker boundary).
- Unit test: seed a single Codex JSONL line with a tool_use + tool_result pair; assert (1) exactly one `pending_messages` INSERT, (2) zero outbound HTTP requests recorded against the worker's own `/api/sessions/observations` endpoint (use an HTTP spy).

### (d) Anti-pattern guards

- **B**: no polling — direct function call, not an event bus, not a retry loop.
- **E**: the hook path and the transcript path **both** call `ingestObservation(payload)`. Only ingress shape conversion differs; the helper is the single code path (matches `06-implementation-plan.md:146` — "One helper, both handlers call it.").

### Blast radius

`src/services/transcripts/processor.ts` only. The watcher chain inside the worker process no longer crosses the HTTP boundary. The CLI hook (`observation.ts`) remains unchanged for this phase — it runs in the hook subprocess and must HTTP the worker.

---

## Phase 4 — Route `session_init` / `session_end` directly to `SessionManager` (drop `/api/sessions/summarize` + `/api/context/inject` loopbacks)

**Goal**: `handleSessionInit` calls `SessionManager.initializeSession` directly. `handleSessionEnd` calls `SessionManager.endSession` (which internally queues the summary the same way the hook-side does). The last two in-process HTTP loopbacks disappear from the transcript path.

### (a) What to implement — Copy from § 3.12

```
Route -->|session_init| Init["sessionManager.initializeSession(sessionDbId)
                              (direct, no HTTP loopback)"]
Route -->|session_end| EndFlow["sessionManager.endSession(sessionDbId)
                                 → queueSummarize (same as hook path)"]
EndFlow --> WriteCtx["Optional: writeAgentsMd (Cursor flag)"]
```

**Code change (processor.ts)**:

1. Replace `handleSessionInit` (`:178-191`) with a direct call to `SessionManager.initializeSession(sessionDbId, userPrompt=fields.prompt, promptNumber)`. The worker-process `SessionManager` instance is injected via constructor (plan 07 already plumbs this; the watcher receives it in `TranscriptWatcher` constructor).
2. Replace `queueSummary` (`:322-344`): call the same helper that `07-plans/07-session-lifecycle-management.md` exposes as `endSession({contentSessionId, platformSource, last_assistant_message})` → internally it calls `ingestSummary(payload)` (from `06-implementation-plan.md:130`). No `workerHttpRequest('/api/sessions/summarize', …)`.
3. Replace `updateContext` (`:346-392`): keep the **path-traversal guard** (`:363-373` — real security check, not patch cruft), but replace the HTTP call at `:377` with a direct `generateContext(allProjects)` call from `ContextBuilder` (the same function `/api/context/inject` handler wraps). `writeAgentsMd` unchanged.
4. Remove import of `ensureWorkerRunning` and `workerHttpRequest` (both already freed by this point).
5. `sessionCompleteHandler.execute` at `processor.ts:311-315` — delete; `endSession` subsumes it.

### (b) Docs cited

- 05 § 3.12 lines 493, 495, 497 — direct `initializeSession` / `endSession`, `writeAgentsMd` kept.
- 05 Part 2 D1 line 70 — "no HTTP loopback inside the worker process."
- Dependency: plan 07 `06-implementation-plan.md:114-152` (Phase 2 helpers: `ingestObservation`, `ingestPrompt`, `ingestSummary`) and `:321-326` (§ 3.8 `endSession` blocks until summary).
- Live: `src/services/transcripts/processor.ts:185` (`sessionInitHandler.execute`), `:334` (`workerHttpRequest('/api/sessions/summarize', …)`), `:377` (`workerHttpRequest(contextUrl)`), `:363-373` (security guard — **preserve**).

### (c) Verification

- `grep -n "workerHttpRequest\|ensureWorkerRunning" src/services/transcripts/` → **zero** matches.
- `grep -n "sessionInitHandler\|sessionCompleteHandler\|observationHandler" src/services/transcripts/` → **zero** matches.
- `grep -n "writeAgentsMd\|isPathSafe" src/services/transcripts/processor.ts` → still present (security guard kept).
- Integration: drive a full Codex JSONL run through the watcher; assert the AGENTS.md file is written with the same content as the pre-refactor path.

### (d) Anti-pattern guards

- **D**: no facade — the processor talks to `SessionManager` **directly**, not via a `TranscriptSessionBridge`.
- **E**: `ingestSummary` is the one code path — transcript `session_end` and hook `Stop` both call it.

### Blast radius

`src/services/transcripts/processor.ts` — large internal rewrite. No external shape changes: the eventual `pending_messages` rows are byte-identical to today's hook-path output.

---

## Phase 5 — Remove `isProjectExcluded` re-check in the processor (moved into `ingestObservation`)

**Goal**: The transcript processor does not re-run project-exclusion. `ingestObservation` (and its siblings) run the check once, centrally (per Plan 07).

### (a) What to implement — Copy from § 3.12

From 05 § 3.12 Deleted list (`:502-506`):

> - `isProjectExcluded` re-check inside transcript processor (done once in `ingestObservation`)

**Code change**:

1. `grep -n "isProjectExcluded" src/services/transcripts/` — if any call site exists (it is currently checked inside `observationHandler.execute`, `src/cli/handlers/observation.ts:59`, which the watcher path no longer uses after Phase 3), delete it.
2. Assert `ingestObservation` performs the exclusion check (Plan 07 requirement, per `06-implementation-plan.md:132` — "(b) runs privacy / project-exclusion validation").

### (b) Docs cited

- 05 § 3.12 deleted-list (`:506`).
- Dependency: `06-implementation-plan.md:132`.
- Live: `src/cli/handlers/observation.ts:57-62` — current exclusion check (removed from the transcript path by Phase 3's loopback kill; this phase confirms no second copy exists in the watcher).

### (c) Verification

- `grep -rn "isProjectExcluded" src/services/transcripts/` → **zero** matches.
- `grep -n "isProjectExcluded" src/services/worker/ingest/` → **exactly one** call (inside `ingestObservation` / shared privacy-validate path).

### (d) Anti-pattern guards

- **E**: one exclusion check, one code path — `ingestObservation` is authoritative.

### Blast radius

Essentially a grep-and-delete pass; most likely zero lines to change (the check never lived in the processor, only in the CLI handler we've already unlinked).

---

## Phase 6 — Verification gate

**Goal**: Prove the four deletions and the single new mechanism by mechanical checks.

### Checks

1. **Parent-dir watch drop test** (from Phase 1's ©): write a brand-new JSONL file into a mock watched dir; within **100 ms** observe a `Watching transcript file` log line AND a `pending_messages` INSERT after the first tool_use+tool_result pair. Without the 5-s rescan, this must succeed on a sub-second timeline.
2. **`pendingTools` gone**: `grep -rn "pendingTools" src/` → `0`.
3. **HTTP loopback gone**: `grep -rn "workerHttpRequest\|ensureWorkerRunning" src/services/transcripts/` → `0`. `grep -rn "observationHandler\|sessionInitHandler\|sessionCompleteHandler" src/services/transcripts/` → `0`.
4. **Timer gone**: `grep -rn "setInterval" src/services/transcripts/` → `0`.
5. **Single-path ingest**: `grep -rn "ingestObservation(" src/` — ≥ 2 call sites (transcript processor + hook-path route handler from Plan 07); zero in CLI handler (still uses HTTP to reach the worker).
6. **Schema-contract fuzz**: drop a crafted JSONL where `tool_use` omits `call_id`. Assert: debug log "tool_use without toolId", no crash, no paired observation emitted. Drop a `tool_result` with a `call_id` we never saw. Assert: debug log "orphan tool_result", no crash.
7. **Cursor / OpenCode / Gemini-CLI unaffected**: those paths go through `src/cli/handlers/observation.ts` (hook PostToolUse). Run the standard hook-round-trip smoke test (`npm run build-and-sync` + trigger a PostToolUse from each); assert `pending_messages` rows still appear. **This is the non-regression guard for the prompt's "preserve Cursor/OpenCode/Gemini-CLI" constraint** — they never depended on the transcript JSONL watcher, so Phases 1-5 cannot break them; this check exists to *prove* it.
8. **End-to-end**: full Codex JSONL fixture → expected SQLite state identical to pre-refactor.

### Anti-pattern guards (final sweep)

- **A**: every new identifier (`getGlobRoot`, `pendingToolUses` map, `readAvailable`) traces to a concrete live function or the plan's invented, single-use helper. No new classes.
- **B**: one `fs.watch` subscription per target, no timers, no polling, no "retry-rescan on SIGCHLD".
- **E**: transcript processor and hook route both import `ingestObservation` from the same module (`src/services/worker/ingest/index.ts`), with no privately duplicated strip / privacy / exclusion logic.

---

## Summary of line deletions

Against current live code:

| File | Lines removed | Lines added | Net |
|---|---|---|---|
| `src/services/transcripts/watcher.ts` | ~40 (per-file fsWatch + rescan interval + timer-cleanup scaffolding) | ~25 (parent-dir recursive watch + `getGlobRoot`) | -15 |
| `src/services/transcripts/processor.ts` | ~120 (`pendingTools` state, `handleToolUse` inline ingest, HTTP queueSummary, HTTP updateContext, handler imports) | ~50 (LRU tool-pairing map, direct `ingestObservation`/`endSession` calls, direct `generateContext` import) | -70 |
| `src/services/transcripts/types.ts` | 1 (`rescanIntervalMs` field) | 0 | -1 |
| `src/cli/handlers/observation.ts` | 0 (preserved; hook path still HTTPs the worker) | 0 | 0 |
| **Total** | **~161** | **~75** | **~-86** |

Plan-level estimate aligns with `05-clean-flowcharts.md:554` row "Transcript 5-s rescan + pendingTools map + HTTP loopback: -150 / +40 / -110" — consistent with our per-file count.

---

## Phase count

**6 phases** (5 implementation + 1 verification gate), matching the minimum set specified in the prompt.

---

## Gaps and open questions

1. **Node-version floor must bump.** `package.json:58` currently pins `"node": ">=18.0.0"`. `fs.watch(dir, { recursive: true })` on **Linux** became stable in **Node 20** (earlier versions throw `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`). macOS + Windows + Bun have supported it all along. **Action before merging Phase 1**: bump `engines.node` to `>=20.0.0` (coordinate with infra/CI matrix) and verify the plugin's install path (Bun-managed) satisfies it. If bumping is blocked, a Linux-only fallback (chokidar or a polling Map of child dirs) is needed — but that re-introduces anti-pattern B, so the Node-20 bump is the right move.
2. **Single schema in the live codebase, audit phrasing diverges from implementation.** The audit text (and this prompt) references "Cursor, OpenCode, Gemini-CLI transcript ingestion" as preserved. In this codebase **those three agents ingest through the PostToolUse hook chain** (`CursorHooksInstaller.ts`, `OpenCodeInstaller.ts`, `GeminiCliHooksInstaller.ts` — none of which register a JSONL schema). The only JSONL schema is **Codex** (`src/services/transcripts/config.ts:9` + `transcript-watch.example.json`). Phases 1-5 therefore only affect the Codex capture path. The preservation claim for Cursor/OpenCode/Gemini-CLI is satisfied trivially — their path doesn't touch this feature. This is worth calling out in the PR description to avoid reviewer confusion.

## Sources consulted

- `PATHFINDER-2026-04-21/05-clean-flowcharts.md` — full file, § 3.12 canonical, Part 1 #17/18/19, Part 2 D1, Part 4 timer census, Part 5 deletion row.
- `PATHFINDER-2026-04-21/06-implementation-plan.md` — full file, Phase 0 V18, Phase 7 scope, Phase 2 ingest-helper contract.
- `PATHFINDER-2026-04-21/01-flowcharts/transcript-watcher-integration.md` — full before-state.
- `src/services/transcripts/watcher.ts` (lines 1-242).
- `src/services/transcripts/processor.ts` (lines 1-393).
- `src/services/transcripts/config.ts` (lines 1-138).
- `src/services/transcripts/types.ts` (lines 1-70).
- `src/services/transcripts/field-utils.ts` (lines 1-153).
- `src/cli/handlers/observation.ts` (lines 1-86).
- `src/services/worker/http/routes/SessionRoutes.ts` (lines 560-659 for `handleObservationsByClaudeId` shape).
- `src/services/worker-service.ts` (watcher lifecycle at :90, :164, :466, :614-640, :1095-1097).
- `src/services/integrations/{CursorHooksInstaller,OpenCodeInstaller,GeminiCliHooksInstaller,CodexCliInstaller}.ts` — confirming only Codex registers a JSONL schema.
- `transcript-watch.example.json` — confirming only `codex` schema in the live config template.
- `package.json:57-60` — Node engine floor.
