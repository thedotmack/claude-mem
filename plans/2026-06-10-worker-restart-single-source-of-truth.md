# Worker Restart: Single Source of Truth

**Created:** 2026-06-10
**Root-cause analysis:** 12-agent diagnosis, adversarially verified (workflow `wf_f07f3541-b05`). Summary: worker-restart failures are caused by five redundant "who is the worker" oracles with uncoordinated writers, a sync-script "hot reload" mirror that writes version-N code into the version-(N-1) cache dir, a kill-only restart endpoint that races hook lazy-spawns, and a build chain that fires two uncoordinated restarts and never verifies the outcome. 98 version-recycle ping-pong events and six EADDRINUSE hard failures observed Jun 8–10.

**Execution model:** Each phase is self-contained and lands independently (one commit/PR per phase, in order). Phases 1–2 are the high-leverage, low-risk slice. Run `npm test` plus the phase's verification checklist before moving on.

---

## Phase 0: Consolidated Documentation — Allowed APIs and Ground Truth

*(Discovery already performed by three fact-extraction subagents on 2026-06-10; consolidated here. Executors: trust these refs, but re-read the cited lines before editing — line numbers drift.)*

### Allowed APIs (verified to exist — use ONLY these, with these exact signatures)

| API | Location | Signature / shape |
|---|---|---|
| `ensureWorkerRunning()` | `src/shared/worker-utils.ts:293-381` | `(): Promise<boolean>` — hook lazy-spawn + PR #2768 version-recycle |
| `resolveWorkerScriptPath()` | `src/shared/worker-utils.ts:206-215` | candidates: `MARKETPLACE_ROOT/plugin/scripts/worker-service.cjs`, then `cwd()/plugin/scripts/worker-service.cjs` |
| `resolveBunRuntime()` | `src/shared/worker-utils.ts:217-235` | hook-side resolver; MISSING `~/.bun/bin` fallbacks |
| `waitForWorkerPort` / `waitForWorkerReadiness` | `src/shared/worker-utils.ts:237-273` | polls `GET /api/readiness`; budget env `CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS` |
| `ensureWorkerStarted(port, workerScriptPath)` | `src/services/worker-spawner.ts:70-153` | returns `'ready' \| 'warming' \| 'dead'`; NO version guard |
| `spawnDaemon(scriptPath, port, extraEnv?)` | `src/services/infrastructure/ProcessManager.ts:408-472` | returns PID or `undefined`; setsid on Unix, PowerShell on Windows |
| `resolveWorkerRuntimePath(options?)` | `src/services/infrastructure/ProcessManager.ts:63-125` | full bun resolver chain (BUN, BUN_PATH, `~/.bun/bin`, brew paths, `which`) |
| PID file APIs | `ProcessManager.ts:134-168, 508-520` | `writePidFile(info)`, `readPidFile(): PidInfo\|null`, `removePidFile()`, `touchPidFile()`, `cleanStalePidFile()` |
| `httpShutdown(port, reason?)` | `src/services/infrastructure/HealthMonitor.ts:94-114` | POSTs `/api/admin/shutdown?reason=restart` |
| `waitForPortFree(port, timeoutMs?)` | `HealthMonitor.ts:85-92` | 500ms poll |
| `checkVersionMatch(port)` | `src/services/infrastructure/HealthMonitor.ts:~120-161` | returns `{matches, pluginVersion, workerVersion}`; fail-open on ENOENT |
| `performGracefulShutdown(config)` | `src/services/infrastructure/GracefulShutdown.ts:30-58` | sequential closes, NO global deadline |
| `flushResponseThen(res, payload, action)` | `src/services/server/flushResponseThen.ts:3-16` | responds, runs action on 'finish', ALWAYS `process.exit(0)` |
| `writeJsonFileAtomic()` | `src/npx-cli/utils/paths.ts:124-205` | the ONLY atomic-write helper in the repo |
| `MARKETPLACE_ROOT` | `src/shared/paths.ts:43` | `~/.claude/plugins/marketplaces/thedotmack` |
| `resolveDataDir()` / `DATA_DIR` | `src/shared/paths.ts:18-40` | env `CLAUDE_MEM_DATA_DIR` wins (line 19-20); module-level const — computed at import time |
| Worker port default | `src/shared/SettingsDefaultsManager.ts:91` | `37700 + (uid % 100)` — NEVER hardcode 37777 |
| `/api/health` response | `src/services/server/Server.ts:212-233` | `{status, version, workerPath, uptime, pid, initialized, mcpReady, ...}` — has everything verification needs |
| `/api/readiness` response | `Server.ts:235-247` | `{status: 'ready'\|'initializing', mcpReady}` |
| `/api/admin/restart` | `Server.ts:282-294` | kill-only via `flushResponseThen` → `onRestart()` → `shutdown('restart')`; NOTHING respawns (macOS/Linux) |
| `version: BUILT_IN_VERSION` | baked via `__DEFAULT_PACKAGE_VERSION__` esbuild define | `scripts/build-hooks.js:312,365,421,469,495,540` |

### Anti-patterns (verified NOT to exist — do not invent)
- There is NO `/api/admin/status`, NO `/api/version` route in Server.ts (version comes from `/api/health`), NO respawn anywhere in the HTTP restart path.
- There is NO flock/O_EXCL/`wx`-flag lockfile pattern anywhere in src/ — Phase 4 introduces the first one; copy `writeJsonFileAtomic` for the write discipline.
- `plugin/scripts/*.cjs` are BUILT artifacts — never hand-edit; rebuild with `npm run build`.
- `package-lock.json` is gitignored — do not commit it.
- Tests are `bun test` (`bunfig.toml` preloads `tests/preload.ts` for the PostHog mock). Mock pattern: `mock.module()` + query-param cache-bust fresh import (`tests/shared/worker-utils-version-recycle.test.ts:22-32`).

### Behavioral contracts that MUST keep passing
- `tests/shared/worker-utils-version-recycle.test.ts`: on version mismatch `ensureWorkerRunning()` POSTs `/api/admin/restart` ≥1×; on match, 0×.
- `tests/integrations/spawn-contract-windows.test.ts`: spawn-contract env overrides.
- Full suite: 2203 pass / 0 fail as of v13.5.5.

---

## Phase 1: Delete the cache-mirror; make the CLI restart the single initiator

**Why first:** The mirror (`sync-marketplace.cjs:164-173`) is the largest manufactured source of version disagreement (7 of 10 cache dirs hold off-by-one content); the double restart (HTTP POST + sleep 1 + CLI restart) is the race generator. Both fixes are deletions.

### What to implement
1. In `scripts/sync-marketplace.cjs`:
   - Delete the cache-mirror block (lines ~164-173: `INSTALLED_CACHE_PATH` + rsync + `bun install` into the cache dir).
   - Delete `detectInstalledVersion()` (lines ~79-114) and its call site — it exists only to feed the mirror.
   - Delete the HTTP restart trigger block (lines ~196-216: the `http.request` POST to `/api/admin/restart` and its success/error prints). The sync script's job ends at "files synced + `bun install` in the marketplace copy".
2. In root `package.json` line ~67, simplify:
   - From: `"build-and-sync": "npm run build && npm run sync-marketplace && sleep 1 && (cd ~/.claude/plugins/marketplaces/thedotmack && npm run worker:restart)"`
   - To: `"build-and-sync": "npm run build && npm run sync-marketplace && (cd ~/.claude/plugins/marketplaces/thedotmack && npm run worker:restart)"`
   - (drop the `sleep 1` — it existed to let the now-deleted HTTP kill land before the CLI restart)
3. Do NOT touch the existing one-time legacy-cache cleanup elsewhere in sync-marketplace.cjs (if present) — only the three blocks named above.

### Documentation references
- Verbatim quotes of all three blocks: Phase 0 table + the restart/shutdown extraction (sync-marketplace.cjs:79-114, 164-173, 196-216; package.json:64-79).

### Verification checklist
- `grep -n "INSTALLED_CACHE_PATH\|detectInstalledVersion\|admin/restart" scripts/sync-marketplace.cjs` → no matches.
- `grep -n "sleep 1" package.json` → no match in build-and-sync.
- `npm run build-and-sync` → completes; worker restarts (via CLI path only); `curl -s http://127.0.0.1:$PORT/api/health` shows the just-built version. (Resolve `$PORT` as `37700 + uid%100` or from `~/.claude-mem/settings.json`.)
- `npm test` → green.
- Stale-cache regression check: `ls ~/.claude/plugins/cache/thedotmack/claude-mem/*/package.json | xargs grep -h '"version"'` — record current values; after the NEXT release, re-check that no cache dir's content changed (the mirror used to mutate them).

### Anti-pattern guards
- Do not "fix" the mirror by targeting `workerPath` instead — the feature is being removed, not repaired.
- Do not add a new restart mechanism here; Phase 2 hardens the existing CLI restart.

---

## Phase 2: Post-restart verification — restart proves itself or exits 1

**Why:** `restart` currently exits 0 after `spawnDaemon` returns a PID — fork success, not boot success. Four silent exit-0 daemon paths mean "✓" with a dead/stale worker.

### What to implement
All in `src/services/worker-service.ts`:
1. In `case 'restart'` (lines ~956-973):
   - BEFORE `httpShutdown`, capture the old worker: `GET /api/health` (2s timeout) → save `oldPid` (may be null if no worker).
   - Replace `waitForPortFree(port, 5000)` with `waitForPortFree(port, getPlatformTimeout(15000))` — parity with `stop` (line ~946).
   - AFTER `spawnDaemon`, add a verification loop (new helper `verifyRestartedWorker(port, oldPid, deadlineMs)`): poll `GET /api/health` every 500ms until `health.pid !== oldPid && health.version === EXPECTED_VERSION`, where `EXPECTED_VERSION` is this process's own baked `__DEFAULT_PACKAGE_VERSION__` (build-and-sync runs the marketplace copy, so its baked version IS the just-synced version). Deadline: `getPlatformTimeout(30000)`.
   - On success: log `Worker restart verified {pid, version}` and exit 0. On deadline: `console.error` with the last observed health payload (or connection error) and **exit 1**.
2. In the `--daemon` block (lines ~1167-1208): change EXIT PATH 4 only (generic start failure, lines ~1204-1206) from `process.exit(0)` to `process.exit(1)`. Paths 1-3 are legitimate duplicate-suppression and stay exit 0.
3. Spawn target: change `spawnDaemon(__filename, port)` (line ~965) to prefer the marketplace script — copy the candidate pattern from `resolveWorkerScriptPath()` (`src/shared/worker-utils.ts:206-215`), falling back to `__filename` when no marketplace copy exists (dev trees, CI).

### Documentation references
- `/api/health` shape: `Server.ts:212-233` (`pid`, `version` fields confirmed).
- `getPlatformTimeout`: used at `worker-service.ts:946`.
- `__DEFAULT_PACKAGE_VERSION__` availability inside worker-service bundle: `scripts/build-hooks.js:312-313`.

### Verification checklist
- New test `tests/services/worker-restart-verify.test.ts`: mock `global.fetch` (copy the fetchLog pattern from `tests/shared/worker-utils-version-recycle.test.ts:34-50`); assert `verifyRestartedWorker` returns success when health flips to `{pid: newPid, version: expected}`, failure on stale pid, failure on wrong version, failure on timeout.
- Manual: `npm run build-and-sync` → output includes `Worker restart verified`; then `kill -9 <worker pid>` mid-restart-window and re-run to see a LOUD exit-1 path (or simulate by pointing the verify loop at a dead port in the test).
- `npm test` → green, including the version-recycle contract.

### Anti-pattern guards
- Do NOT poll `/api/version` (doesn't exist) or invent new health fields.
- Do NOT compare against marketplace `package.json` on disk for `EXPECTED_VERSION` — the baked constant is the truth for "the code I am running"; disk reads reintroduce a second oracle.
- The verify deadline must not block forever: hard cap, then exit 1.

---

## Phase 3: Self-replacing restart — old worker spawns its successor; recycle path stops spawning into corpses

**Why:** `/api/admin/restart` is kill-only; hooks that POST it then lazy-spawn race the dying worker (the ping-pong). If the OLD worker spawns its successor as its final act after the port closes, old and new never coexist and no third party spawns into a corpse.

### What to implement
1. `src/services/worker-service.ts` `shutdown()` (lines ~671-699):
   - Re-entrancy guard: the `isShuttingDown` field (line ~188) is write-only today; make `shutdown()` check-and-set it at entry (`if (this.isShuttingDown) return; this.isShuttingDown = true;`).
   - Hard deadline: wrap `performGracefulShutdown(...)` in `Promise.race` with a `getPlatformTimeout(10000)` timer; on deadline, log `Graceful shutdown deadline exceeded — proceeding` and continue (do not hang on unbounded session drain — drain today can run 35-40s).
   - Successor spawn: when `reason === 'restart'`, after graceful shutdown completes/deadlines: resolve the marketplace script (same candidate pattern as Phase 2 step 3), `await waitForPortFree(port, 5000)`, then `spawnDaemon(marketplaceScript, port)`. If port never frees or spawn returns `undefined`, log loudly (`logger.error`) — the next hook's lazy-spawn is the safety net. Note `flushResponseThen` (flushResponseThen.ts:3-16) calls `process.exit(0)` after the action completes, so the spawn must be awaited inside the action.
2. `src/shared/worker-utils.ts` `ensureWorkerRunning()` recycle path (lines ~305-330):
   - After POSTing `/api/admin/restart`, do NOT immediately lazy-spawn. Instead poll `GET /api/health` (500ms interval, `HOOK_READINESS_TIMEOUT_MS` budget) for the successor: healthy AND `version === pluginVersion` (already in hand from `checkVersionMatch`). Only fall through to the existing lazy-spawn if the successor never appears.
   - Amplifier fix: after `waitForWorkerReadiness` succeeds anywhere in this function, re-check the version once via `/api/health`; if still mismatched, log a warning (do NOT loop/recycle again in the same invocation — one recycle per hook event, the next hook retries; unbounded loops here re-create the storm).

### Documentation references
- `onRestart` wiring: `worker-service.ts:255`; route: `Server.ts:282-294`; `flushResponseThen.ts:3-16`.
- Drain timings + unbounded awaits: `GracefulShutdown.ts:30-75`.
- `HOOK_READINESS_TIMEOUT_MS`: `worker-utils.ts:45-48`.
- Signal-path guard to mirror: `src/supervisor/index.ts:56-60`.

### Verification checklist
- `tests/shared/worker-utils-version-recycle.test.ts` still green (still POSTs restart on mismatch — the change is what happens AFTER the POST).
- New test: shutdown re-entrancy — call `shutdown()` twice, assert `performGracefulShutdown` runs once (mock it via `mock.module`).
- New test: recycle-no-corpse-spawn — fetch mock where `/api/admin/restart` 200s and `/api/health` returns the NEW version on poll N: assert NO spawn attempt; where health never recovers: assert lazy-spawn fallback fires.
- Manual end-to-end: with a worker running, `curl -X POST http://127.0.0.1:$PORT/api/admin/restart`; within ~15s `/api/health` shows a NEW pid and the marketplace version, with no hook involvement. Check `~/.claude-mem/logs/claude-mem-$(date +%F).log` for exactly one shutdown and one daemon start (no duplicate-refusal lines).
- `npm test` → green.

### Anti-pattern guards
- The successor spawn happens ONLY on `reason === 'restart'` — `stop` must stay kill-only.
- Never spawn before the port is confirmed free — that recreates EXIT PATH 2/3 duplicate suicides.
- Do not add respawn logic to `flushResponseThen` itself or to the Windows-managed IPC branch (`process.send` path, Server.ts:284-289) — Windows wrapper already owns restart there.

---

## Phase 4: One spawn gate — shared ensureWorker() with a spawn lockfile; kill the resolver asymmetry

**Why:** Three spawn paths (hooks via `worker-utils`, MCP via `worker-spawner`, CLI via `spawnDaemon`) with two different bun resolvers and no mutual exclusion; logs show 3 launchers colliding within one second.

### What to implement
1. New module `src/shared/worker-spawn-gate.ts`:
   - `acquireSpawnLock(): boolean` — `writeFileSync(join(DATA_DIR, 'spawn.lock'), JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}), {flag: 'wx'})` in try/catch. On `EEXIST`: `statSync` the lock; if `mtimeMs` older than 30_000ms, `unlinkSync` and retry ONCE; else return false.
   - `releaseSpawnLock(): void` — unlink, owner-checked (read it; only delete if `pid === process.pid`), errors swallowed.
   - Use `DATA_DIR` from `src/shared/paths.ts` — never `homedir()` directly.
2. In `src/shared/worker-utils.ts` `ensureWorkerRunning()` (spawn section, lines ~332-351): wrap the spawn in the lock — if `acquireSpawnLock()` fails, skip the spawn and go straight to `waitForWorkerPort`/`waitForWorkerReadiness` (someone else is spawning; wait for their worker). Release in `finally`.
3. Same wrap in `src/services/worker-spawner.ts` `ensureWorkerStarted()` around the `spawnDaemon` call (line ~132).
4. Resolver unification: delete `resolveBunRuntime()` from `worker-utils.ts` (lines 217-235) and import/re-export `resolveWorkerRuntimePath` from `ProcessManager.ts` (already exported; it strictly supersedes — adds BUN_PATH, `~/.bun/bin`, brew, snap fallbacks). This closes the kill-then-can't-respawn path.
5. `src/servers/mcp-server.ts` (lines ~42-51): compute `WORKER_SCRIPT_PATH` preferring the marketplace copy — copy the candidate pattern from `resolveWorkerScriptPath()` with fallback to the current own-dir resolution. This stops MCP servers in stale cache dirs from spawning stale workers.

### Documentation references
- Write-discipline reference for the lock: `writeJsonFileAtomic`, `src/npx-cli/utils/paths.ts:124-205` (the `wx`-flag + cleanup-on-error shape; the lock is simpler — no rename needed, `wx` IS the atomicity).
- Spawn call sites table: Phase 0 / spawn-path report §7.
- `resolveWorkerRuntimePath` chain: `ProcessManager.ts:63-125`.

### Verification checklist
- New test `tests/shared/worker-spawn-gate.test.ts` (temp dir via `CLAUDE_MEM_DATA_DIR` + dynamic import — see Phase 6 trap): second acquire fails while held; stale lock (backdate mtime via `utimesSync`) is broken and re-acquired; release is owner-only.
- `grep -rn "resolveBunRuntime" src/` → no definition in worker-utils (only the ProcessManager import).
- `grep -n "spawnHidden\|spawnDaemon" src/shared/worker-utils.ts src/services/worker-spawner.ts` → every spawn site is inside the lock.
- Race test (manual): run 5 concurrent `node "$_P/scripts/bun-runner.js" .../worker-service.cjs start` invocations with no worker running; logs must show exactly ONE `Starting worker daemon` and zero `refusing to start duplicate` storms.
- `npm test` → green (version-recycle contract intact).

### Anti-pattern guards
- The lock gates SPAWNING only — never health checks; a held lock must never make a hook fail, only wait.
- 30s staleness must use file mtime, not clock-in-content comparisons (test pollution wrote `startedAt: 2024-01-01` once already).
- Do not introduce a lock library; `wx` flag is sufficient and dependency-free.

---

## Phase 5: Demote the PID file — port + /api/health become the only liveness oracle

**Why:** The dying worker's shutdown cascade deletes the NEW worker's PID file (`src/supervisor/shutdown.ts:88`), after which `status` reports a healthy worker as "not running" (status requires `portInUse && pidInfo`, `worker-service.ts:975-988`). `/api/health` already carries `pid`, `version`, `workerPath` — it subsumes the file.

### What to implement
1. Owner-guarded deletion (the clobber fix):
   - `src/supervisor/shutdown.ts` (~line 88): before `rmSync(pidFilePath)`, read the file; delete ONLY if its `pid === process.pid`. A mismatch means a successor already wrote its own — log debug and leave it.
   - `src/services/worker-service.ts` `case 'restart'` (~line 964) and `case 'stop'` (~line 949): replace bare `removePidFile()` with the same owner-or-dead check: delete only if the recorded pid is the one we just shut down (captured in Phase 2's pre-shutdown health probe) or the recorded pid is not alive.
2. `case 'status'` (lines ~975-988): source of truth becomes `GET /api/health` — report `pid`, `version`, `uptime`, `workerPath` from the response; fall back to "port in use but health unreachable (wedged?)" and "not running". Drop the `readPidFile()` requirement.
3. `--daemon` duplicate gate (lines ~1167-1182): reorder — port/health probe FIRST (it's ground truth), PID file second (advisory only, for the no-port-bound-yet boot window). Keep `writePidFile`/`touchPidFile` as diagnostics — the worker itself remains the only writer.

### Documentation references
- Clobber chain: `GracefulShutdown.ts:55` → `supervisor.stop()` → `runShutdownCascade` → `shutdown.ts:87-98`.
- `verifyPidFileOwnership` + startToken: `ProcessManager.ts` (PID APIs §3 of spawn-path report).
- Health shape: `Server.ts:212-233`.

### Verification checklist
- Update `tests/infrastructure/process-manager.test.ts` expectations where deletion semantics changed (owner-guard) — coordinate with Phase 6 which relocates this file's data dir.
- New test: old-worker-cleanup-spares-successor — write PID file as `{pid: 99999...}` (not own pid), run the shutdown cascade deletion step, assert file survives.
- Manual: start worker, `rm ~/.claude-mem/worker.pid`, run `worker-service.cjs status` → must still print "Worker is running" with pid/version from health.
- Full ping-pong scenario from Phase 3's manual check still converges.
- `npm test` → green.

### Anti-pattern guards
- Do NOT delete `writePidFile` entirely — external tooling may read it; it's demoted to diagnostics, not removed.
- `status` must not require BOTH oracles ever again — health wins, full stop.
- Do not let the boot-window PID check (advisory) exit 1 — duplicate suppression stays exit 0 (Phase 2 changed only the generic-failure path).

---

## Phase 6: Test hygiene — no test ever touches the real ~/.claude-mem again

**Why:** `tests/infrastructure/process-manager.test.ts` writes corrupt JSON and sentinel PIDs into the REAL `~/.claude-mem/worker.pid` (snapshot-restore shrinks but doesn't close the race window, and a killed test run leaves corruption behind). It also pollutes the shared log, which contaminated this very diagnosis.

### What to implement
1. `tests/infrastructure/process-manager.test.ts`:
   - Replace the hardcoded `DATA_DIR = path.join(homedir(), '.claude-mem')` (lines 24-25) with: create `mkdtempSync(join(tmpdir(), 'claude-mem-pm-test-'))`, set `process.env.CLAUDE_MEM_DATA_DIR` to it.
   - **TRAP:** `DATA_DIR` in `src/shared/paths.ts:40` is a module-level const computed at import time, and ESM hoists static imports — setting the env var in `beforeEach` is too late. Copy the fresh-import pattern from `tests/shared/worker-utils-version-recycle.test.ts:30-32` (query-param cache-bust dynamic import) OR set the env var at the very top of the file before any `await import(...)` of ProcessManager modules (convert the static imports of code-under-test to dynamic).
   - Delete the snapshot-restore of the real PID file (lines 28-43) — unnecessary once isolated; `rmSync(tempDir, {recursive: true, force: true})` in `afterAll` (copy Pattern A: `tests/write-json-file-atomic.test.ts:34-40`).
2. Sweep for other offenders: `grep -rn "homedir()" tests/ | grep -v node_modules` — any test resolving the real data dir gets the same treatment.
3. Add a tripwire to `tests/preload.ts` (it already exists for the PostHog mock): if `CLAUDE_MEM_DATA_DIR` is unset, set it to a per-run `mkdtempSync` dir so NO test can fall through to `~/.claude-mem`. (Env restoration discipline: copy `tests/env-isolation.test.ts:31-90`.)

### Documentation references
- Offending lines verbatim: process-manager.test.ts:24-25, 28-43, 109, 499-503 (test-hygiene report §1).
- Copy-ready isolation patterns: Pattern A `write-json-file-atomic.test.ts:34-40`; Pattern C env restore `env-isolation.test.ts:31-90`.
- Env override honored at `src/shared/paths.ts:19-20`.

### Verification checklist
- `bun test tests/infrastructure/` green.
- While the suite runs: `ls -la ~/.claude-mem/worker.pid; shasum ~/.claude-mem/worker.pid` before/after → byte-identical (or consistently absent).
- `grep -rn "homedir()" tests/` → no hit resolves a data-dir path for writes.
- Full `npm test` green.

### Anti-pattern guards
- Do not mock `fs` to fake isolation — real temp dirs only, the tests exercise real file semantics.
- Do not weaken assertions to dodge the trap; the fresh-import pattern is proven in-repo.

---

## Phase 7: Final Verification

1. **Full suite + typecheck:** `npx tsc --noEmit` and `npm test` — zero failures.
2. **Anti-pattern greps (all must be empty):**
   - `grep -rn "INSTALLED_CACHE_PATH\|detectInstalledVersion" scripts/`
   - `grep -n "admin/restart" scripts/sync-marketplace.cjs`
   - `grep -n "37777" src/ scripts/ -r` (hardcoded port)
   - `grep -rn "resolveBunRuntime" src/shared/worker-utils.ts`
   - `grep -rn "homedir(), '.claude-mem'" tests/`
3. **Triple-restart soak:** run `npm run build-and-sync` three times consecutively; every run must end `Worker restart verified`; `/api/health` pid changes each time, version stays the built version; `grep -c "refusing to start duplicate\|Failed to start server" ~/.claude-mem/logs/claude-mem-$(date +%F).log` shows no new occurrences during the soak.
4. **Stale-launcher convergence test (the original bug):** manually spawn a worker from an OLD cache dir (`node ~/.claude/plugins/cache/thedotmack/claude-mem/<old>/scripts/bun-runner.js .../worker-service.cjs start`), then trigger any hook (or `ensureWorkerRunning` via a session). Expect in the log: exactly ONE `Worker version mismatch — recycling stale worker`, then the self-replacing restart, then a healthy marketplace-version worker — NO ping-pong (no second recycle within 5 minutes).
5. **Observation check:** confirm claude-mem itself recorded observations during the soak (the worker was restarting underneath the recorder — the pipeline must survive its own surgery): query the 10 most recent rows in `~/.claude-mem/claude-mem.db` `observations` and confirm fresh timestamps.
6. **Docs:** update `docs/public/troubleshooting.mdx` if it documents the old restart semantics; CHANGELOG is auto-generated — do not edit.
