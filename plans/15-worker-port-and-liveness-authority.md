# [plan-15] Worker Port & Liveness Authority — one verified answer to "is a worker serving this port?"

> **Tracker:** #3603 · **Design doc:** `plans/15-worker-port-and-liveness-authority.md` · **Series:** plan-14 #3602 · plan-15 #3603 · plan-16 #3604 · plan-17 #3605 · plan-18 #3606 · plan-19 #3607 · plan-20 #3608 · plan-21 #3609 · plan-22 #3610 · plan-23 #3611

## Defect

"Is the worker alive?" is answered by five independent, mutually inconsistent signals — `worker.pid`, `spawn.lock`, `chroma/.claude-mem-chroma-writer.lock`, `supervisor.json`, and "is the port in use?" — and none of them is verified against the process that actually owns the listening socket. So:

- The listening socket handle is inheritable; the chroma-mcp tree (and, under Bun on Windows, hook-spawned worker children) keeps `:37777` bound after the worker dies. The kernel completes TCP handshakes on the ghost listener, so probes see "port in use" and clients wait the full `CLAUDE_MEM_API_TIMEOUT_MS`.
- Every launcher treats "port in use" as proof of a live worker (`Port already in use, refusing to start duplicate`, `Worker PID file points to a live process, skipping duplicate spawn`, `Another launcher holds the spawn lock`) and never reclaims: `spawn.lock` has no holder-liveness check, `validateWorkerPidFile` deletes the pid file so `ensureWorkerRunning` can no longer identify the owner, the `EADDRINUSE` branch `exit(1)`s with no remediation, `pidFileStatus === 'alive'` returns `warming` forever.
- Health probes have no deadline (`HealthMonitor.httpRequestToWorker()` `fetch()` without `AbortSignal`, `isPortInUse()` same), so a wedged-but-bound worker (DarkWake 100 % CPU, CLI-probe hang, stale writer lock, unwritable data dir) turns every hook into a 30–60 s stall and every launcher into a pile-up (296+ hook clients, 16+ bun.exe).
- Recovery paths themselves lie: `startWithBun` pre-writes the PID file and health-checks the bootstrap PID (`Process died during startup` while the daemon is healthy), `Restart successor spawned {pid=0}` after a failed graceful shutdown, `Worker available {}` logged after a health timeout, cooldown markers (`.worker-start-attempted`, 120 s) block the retry that would have worked, and on Windows the daemon can exit 0 one second after boot with no marker and no log line.
- The daemon logs to its startup-date file forever while `/api/logs` reads today's, so weeks of these failures are invisible.

The architectural fix is a single liveness authority: an owner record with a start token that the health endpoint echoes; "alive" means *that* token answered `/api/health` within a bounded probe; anything else bound to the port is reclaimable.

## Children

- #2891 — claude-mem worker unreachable — hooks fail silently on every tool call after session start
- #2893 — [Windows] Zombie-port killer (#1721) misses orphaned children holding the inherited socket
- #2899 — [Windows] Plugin update orphans the worker port (ghost LISTENING socket), blocking all Claude Code prompts
- #2907 — chroma-mcp children pin port after hook-parent exit, blocking respawn
- #2926 — Worker never starts on Windows — port 37777 held by orphaned process; UserPromptSubmit hook fails in a loop
- #2963 — tracking: Windows worker port orphaned after crash/update — ghost LISTEN socket blocks respawn, hooks fail loop
- #2992 — [Windows] Hook times out after 29s — localhost resolves to ::1 first but worker only listens on 127.0.0.1
- #2996 — Windows: stale port holder + aggressive spawn cooldown blocks prompts for ~15 min
- #3031 — Windows: failed worker recycle on version bump leaves a zombie process holding port 37777; stale supervisor.json PID blocks every respawn
- #3052 — Linux/WSL2: worker-cli.js start reports false "Process died during startup" — pre-written-PID self-exit still present
- #3073 — [Windows] No shutdown hook for the persistent worker daemon — blocks update/restart; manual stop leaves a ghost LISTEN socket
- #3085 — MCP STDIO connection closes after 59s, making claude-mem unusable
- #3109 — Stop-hook has no timing logging — root cause: stale spawn.lock (dead holder) + daemon stdout swallowed on Windows
- #3128 — Windows: version-mismatch recycle orphans children that inherit the listening socket — port stays bound under a dead PID for hours
- #3171 — Worker can wedge while holding its port; accepted sockets leak into CLOSE_WAIT; peer sessions retry-storm
- #3204 — Windows: worker restart leaves orphaned LISTENING socket, permanently blocking the worker port — every hook hangs 60–120s
- #3300 — Worker daemon leaks its listening socket into child workers → port never frees → infinite lazy-spawn thrash
- #3340 — worker-service.cjs hangs at 100% CPU after macOS sleep/wake; HTTP listener stops responding
- #3386 — Worker recycle on plugin version bump leaves port bound after failed server.close() (maintainer reports fixed in 13.12.4 — verify and close)
- #3398 — Worker becomes unresponsive to health checks after Claude CLI subprocess probe/hang, stalling synchronous hooks
- #3415 — Long-running worker daemon logs to its startup-date file forever; GET /api/logs reads today's file
- #3420 — Stale chroma writer lock (dead PID) permanently wedges worker daemon (maintainer: stale-lock part fixed on main — verify)
- #3448 — Worker stuck 'warming' forever when a verified live owner never becomes healthy — bounded verified-owner reclaim proposal
- #3450 — Killing the worker leaves the port bound via an inherited socket handle; hook clients hang and pile up (296+ processes)
- #3469 — [Windows] Worker never binds: hangs silently after boot cache, even on a free port
- #3482 — Windows: orphaned chroma child inherits the worker's listening socket, permanently blocking port 37777
- #3484 — Windows: hook health-check never succeeds despite healthy worker (zombie port vs. configured port mismatch)
- #3496 — Unwritable data dir costs 48s per hook instead of failing fast; spawn lock fails open, causing worker pileup
- #3546 — Worker processes accumulate unboundedly on 13.14.0 (12 processes / 2.17 GB RSS, still climbing)
- #3557 — Worker exits cleanly (code 0) ~1s after boot on Windows — never binds port, no CAPTURE_BROKEN marker written
- #3596 — UserPromptSubmit hook blocks all input when the worker is unreachable (unrecoverable deadlock on a stale :37777 listener)

Related PRs to evaluate/rebase: #3405 (registry-verified reap + failover port), #3416 (port relocation), #3431, #3309 (listen-socket inheritance), #2895 (real port occupation detection), #2980, #3009, #3112, #2998, #3099, PR from @dajiaohuang for bounded fetch timeouts (#3553 thread), #3231, #3219.

## Fix sequence

1. **Non-inheritable listener.** Create the HTTP listener with `WSA_FLAG_NO_HANDLE_INHERIT` / `SetHandleInformation(HANDLE_FLAG_INHERIT, 0)` on Windows and `FD_CLOEXEC` on POSIX; spawn every child with explicit `stdio` (never `inherit`) so no descendant can hold the port. Add a CI test that kills the worker and asserts the port is bindable within 1 s while children are alive.
2. **Owner record + start token.** Worker writes `{pid, startToken, port, scriptPath, version, bootId}` to `worker-port.json`; `/api/health` echoes `startToken` and `bootId`. Every liveness decision (`ensureWorkerRunning`, `worker-cli start/stop/restart`, hooks' readiness wait, version-mismatch recycle) reads the record and calls `/api/health` with a **5 s** `AbortSignal`; a match is the only definition of "alive".
3. **Reclaim policy (bounded, verified).** Port bound + no token match ⇒ SIGTERM the record's PID if its cmdline is a claude-mem worker → wait → SIGKILL → sweep registry children (plan-14 sweep) → re-probe bindability; if still bound by an unowned process, **relocate** to the next free port and persist it (`CLAUDE_MEM_WORKER_PORT` fallback file) so hooks and MCP follow. One reclaim attempt per launcher invocation; never touch a PID that answers `/api/health`.
4. **Locks with liveness.** `spawn.lock`, `worker.pid`, and the chroma writer lock all carry `{pid, startToken, createdAt}`; acquisition checks `process.kill(pid,0)` **and** cmdline; dead holder ⇒ reclaim, not wait. Lock write failing for EACCES/EROFS/ENOSPC aborts loudly instead of failing open (#3496): boot runs `access(dataDir, W_OK)` first and writes the failure to stderr and the runner-errors log.
5. **Startup that cannot lie.** `startWithBun` writes the PID file only after `/api/health` returns the new token; readiness is `/api/readiness`, never the bootstrap PID; a worker that reaches boot-cache but never binds exits **non-zero** with the reason logged and `CAPTURE_BROKEN` written (#3557); daemon stdout/stderr are redirected to the log file on Windows (`Start-Process` path) so a silent exit is never silent again; `--help` never starts a worker.
6. **Wedge watchdog.** In-process heartbeat: if the event loop is blocked > 15 s or `/api/health` self-probe fails 3× (DarkWake, CLI-probe hang, stuck writer lock), the worker closes accepted sockets and self-terminates non-zero so the next hook's launcher spawns a fresh one; sleep/wake (`SIGCONT`, monotonic clock jump) re-inits the listener. Idle-connection timeout closes CLOSE_WAIT leaks.
7. **Cooldowns keyed to evidence, not time.** `.worker-start-attempted` / spawn cooldown apply only when the previous attempt's failure was *not* "port bound by dead owner"; a reclaimable port always permits one immediate retry. Cold-boot wait is measured (p95 of recent boots) with a floor of 15 s and a ceiling below the hook timeout (plan-17 owns the hook side).
8. **Bind host normalization.** `localhost` → `127.0.0.1` in `SettingsDefaultsManager`/`getWorkerHost` so worker and probes never end up cross-family (#2992).
9. **Daemon observability.** Log path recomputed per write (date roll) or a size-rotated `claude-mem.log`; `/api/logs` reads whatever the daemon writes; `worker-cli status` prints owner record vs. live health so a mismatch is one command away.

## Test matrix

| Host | Runtime | Scenario | Required behavior |
|---|---|---|---|
| Windows 10/11 | Bun, Node | worker killed while chroma tree alive | port bindable ≤ 1 s; next hook's launcher starts a new worker ≤ 15 s |
| Windows | Bun | plugin update / version-mismatch recycle | incumbent released only after successor token answers `/api/health`; no ghost LISTEN |
| Windows | Bun | ghost listener from an *unowned* process (simulated) | relocation to next free port; hooks + MCP follow within one invocation |
| macOS | Bun | sleep/DarkWake with idle worker | health answers ≤ 5 s after wake or worker self-restarts |
| macOS / Linux | Bun | wedged event loop (injected 30 s block) | probe aborts at 5 s; watchdog restarts worker; hooks never wait > 5 s on liveness |
| Linux / WSL2 | Bun | `worker-cli start` against a healthy worker | exits 0 "already running"; never "Process died during startup" |
| all | all | stale `spawn.lock` / `worker.pid` / writer lock with dead PID | reclaimed on first touch; no cooldown engaged |
| all | all | unwritable `~/.claude-mem` | hook fails in < 1 s with a stderr reason; no worker spawned |
| all | all | 30 concurrent hook launchers on a cold start | exactly one worker; other launchers attach or exit; no pile-up |
| all | all | daemon running across a date boundary | `/api/logs` shows the daemon's ERROR lines |

The matrix lives in CI (`tests/infrastructure/liveness-authority.test.ts` with an injectable fake listener/child, plus the Windows job). A regression must fail CI before a user can file.

## Out of scope

Killing children that outlive the worker (plan-14). Which on-disk copy the launcher spawns from and when a version-mismatch recycle is allowed to fire (plan-16). What a hook does when the authority says "not alive" — fail-open, no blocking (plan-17).
