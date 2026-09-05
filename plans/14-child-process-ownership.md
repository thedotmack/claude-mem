# [plan-14] Child Process Ownership — every process the worker spawns dies with the worker

> **Tracker:** #3602 · **Design doc:** `plans/14-child-process-ownership.md` · **Series:** plan-14 #3602 · plan-15 #3603 · plan-16 #3604 · plan-17 #3605 · plan-18 #3606 · plan-19 #3607 · plan-20 #3608 · plan-21 #3609 · plan-22 #3610 · plan-23 #3611 · plan-24 #3618

## Defect

The worker daemon spawns long-lived children — the chroma-mcp sidecar (`uvx → uv → python`), the headless `claude` observer subprocess, `mcp-server.cjs`, and sibling workers during recycles — but never takes ownership of their lifetime. Concretely:

- The supervisor registry (`supervisor.json`) keys the sidecar under a single fixed name (`"chroma-mcp"`); every (re)spawn overwrites the entry **without killing the previous PID**, so `pruneDeadEntries()` only ever sees one live child while dozens accumulate.
- Children are spawned via `StdioClientTransport` with no `detached`/process-group, and `close()` only SIGTERMs the `uv` wrapper, which does not forward to its python child. On systemd hosts orphans reparent to `systemd --user`, so `PPID==1` sweeps find nothing.
- Every abnormal exit path skips teardown: the 10 s `gracefulDeadlineMs` expires mid-`sessionManager.shutdownAll()` so `chromaMcpManager.stop()` is never reached (#3459); `performGracefulShutdown` throws `Server is not running.` and `process.exit(0)` runs before the registry sweep (#3153); the `EADDRINUSE` "refusing to start duplicate" path exits after background-init already spawned a chroma pair (#3216); SIGKILL after a restart timeout skips everything.
- `ChromaMcpManager.callTool()` retry re-enters `ensureConnected()` after teardown with no shutdown latch, respawning the tree it just killed; `connectInternal()`'s catch swallows `transport.close()` failures and nulls the only handle to a live ~500 MB python child.
- Nothing bounds or recycles a child by resource usage (a single chroma-mcp reaching 23 GB footprint invisible to RSS), and nothing sweeps orphans at boot.

Because the version-mismatch recycle loop (plan-16) can restart the worker hundreds of times per hour, this leak becomes hundreds of processes and tens of GB of swap in a day. Fixing the loop stops the pump; only ownership stops the leak.

## Children

- #2896 — chroma-mcp subprocess leak: unbounded process accumulation via reconnection loop
- #2950 — chroma-mcp subprocess leak on macOS — zombie uv+python3.13 process pairs accumulate across sessions
- #2959 — tracking: chroma-mcp subprocess leak — zombie uv+python process pairs accumulate due to silent kill failures and orphan socket inheritance
- #3149 — chroma-mcp subprocess leaked on every session (never reaped) + CLAUDE_MEM_DATA_DIR ignored by chroma-mcp launch
- #3153 — Worker leaks one chroma-mcp process pair per restart — supervisor.json overwritten, previous chroma never reaped
- #3175 — chroma-mcp processes orphan on session exit → accumulate, hold uv cache lock, bloat ~/.cache/uv
- #3191 — In-process memory leak: single live chroma-mcp subprocess grew to 23 GB footprint — worker should bound and recycle it
- #3205 — chroma-mcp process leak: stale marketplace version triggers an unbounded worker-recycle loop, and recycled workers orphan chroma-mcp to PID 1
- #3216 — Stale-version recycle loop leaks chroma-mcp processes (759 procs / ~71 GB RSS) until the machine OOMs
- #3218 — chroma-mcp orphan leak still present on 13.10.3 — OOMs an 8GB machine in ~20 min (regression of #1063 / #1077)
- #3230 — chroma-mcp subprocesses leak and are never reaped — 1000+ orphaned procs / ~48 GB RAM after a day
- #3270 — Process leak: 58+ claude-mem processes accumulate during a session
- #3301 — Chroma-mcp orphan leak across worker generations: live orphan's registry entry is overwritten without a kill
- #3326 — chroma-mcp server leaks a new process pair every 1-3 min, never reaps old ones
- #3382 — Orphaned chroma-mcp processes accumulate — supervisor tracks 1, hundreds leak
- #3404 — Worker daemon never reaps headless claude observer subprocesses — 203 accumulated over 4 days
- #3413 — chroma-mcp orphans span 5 uv build generations (supervisor tracks 1 of 23); orphans page out so the leak is silent
- #3459 — Graceful shutdown leaks chroma-mcp too: the 10s deadline expires mid-drain, so chromaMcpManager.stop() is never reached
- #3540 — [Windows] chroma-mcp respawn teardown correlates with orphaned uv builds-v0 temp dirs — 144GB confirmed

Related PRs to evaluate/rebase: #3302 (kill-before-overwrite), #3465 (shutdown reap backstop + terminal latch), #3462 (connectionGeneration guards), #3192 (memory watchdog), #3232 (per-PID registry keys + orphan sweep), #3405 (registry-verified reap), #2536, #2920, #1175.

## Fix sequence

1. **Registry keyed by PID, not role.** `ProcessRegistry.register()` records `{pid, pgid, startToken, cmdlineFingerprint, dataDir}` per spawn; before any new chroma/observer spawn, kill the recorded predecessor tree (verified by cmdline fingerprint), then unregister. Overwrite-without-kill becomes impossible by construction.
2. **Spawn every child in its own process group** (`detached: true` + `unref()` on POSIX; Job Object / `CREATE_NEW_PROCESS_GROUP` + `taskkill /T` on Windows) so `kill(-pgid)` reaches `python`, not just `uv`. The Windows kill uses a graceful step before `/F` so uv can clean `builds-v0/.tmp*` (#3540).
3. **One teardown path that always runs.** `runShutdownSequence` gets a bounded reap backstop: `process.on('exit'|'SIGTERM'|'SIGINT'|'uncaughtException')` → registry cascade kill with its own deadline; graceful order becomes `chroma stop → observer abort → http close → db` so the expensive `shutdownAll()` can no longer starve child teardown; `ERR_SERVER_NOT_RUNNING` and the `EADDRINUSE` duplicate path both go through the same cascade.
4. **Shutdown latch.** `chromaMcpManager.stop({terminal:true})` sets a latch; `ensureConnected()`/`callTool()` throw `ChromaUnavailableError` after it. `stop()` is memoized. `connectInternal()` failures kill the spawned PID before nulling the transport.
5. **Boot-time and periodic sweep, registry-independent.** On worker start and every supervisor tick: kill any `chroma-mcp --data-dir <ours>` / `claude … --resume <observer-id>` / `mcp-server.cjs` process whose parent is not a live claude-mem worker (walk by cmdline + data-dir, not `PPID==1`).
6. **Resource bound per child.** Every 5 min sum footprint (PSS/private, not RSS) across the child tree; above `CLAUDE_MEM_CHROMA_MEMORY_LIMIT_MB` (default 2048) recycle through the same kill-before-spawn path. The same watchdog aborts observer subprocesses idle past their deadline.
7. **Chroma launch honors `CLAUDE_MEM_DATA_DIR`** for `--data-dir` (#3149) so multiple config dirs cannot share one store by accident.

## Test matrix

| Host | Trigger | Required behavior |
|---|---|---|
| macOS / Linux (PID 1) / Linux (systemd --user subreaper) / Windows (Bun) | `worker restart` ×20 | exactly one `chroma-mcp` tree alive after each; `supervisor.json` has one live chroma entry |
| all | SIGKILL worker, restart | boot sweep kills the orphaned tree within 5 s of new worker health |
| all | graceful shutdown with 40 s of pending summarize work | chroma tree gone before process exit; no respawn after `stop()` |
| all | `EADDRINUSE` duplicate start | duplicate exits with zero children left |
| all | chroma child footprint > limit | recycled once, not looped; old tree gone |
| all | 4 h idle worker | observer subprocess count == active sessions |
| Windows | `taskkill` path | no new `%LOCALAPPDATA%\uv\cache\builds-v0\.tmp*` dirs older than 10 min |

The matrix lives in CI (`tests/infrastructure/process-ownership.test.ts` + a Docker `systemd --user` job + the Windows job). A regression must fail CI before a user can file.

## Out of scope

Ghost LISTEN sockets, stale PID/spawn/writer locks and reclaim (plan-15). The version-mismatch recycle loop and stale-path successor spawn that pump the leak (plan-16). Chroma spawn arguments, pins and sync watermarks (plan-22).
