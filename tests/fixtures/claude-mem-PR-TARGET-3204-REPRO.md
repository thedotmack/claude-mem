## Summary

On Windows, the worker restart flow can kill the worker without a graceful shutdown and fail to spawn its successor. The dead process's socket stays in the TCP table as `LISTENING` (owned by a PID that no longer exists), permanently blocking the configured worker port until reboot. From then on, **every** hook invocation (`UserPromptSubmit`, `PostToolUse`, `PreToolUse` Read) hangs for its full 60–120s timeout on every prompt and tool call, with zero tokens consumed — Claude Code sessions feel frozen.

This happened **twice in two days** on the same machine: port `37778` on 2026-07-11 and port `37779` on 2026-07-12. Each time the only recovery was manually changing `CLAUDE_MEM_WORKER_PORT` in `~/.claude-mem/settings.json` (or rebooting Windows to clear the orphaned socket).

## Environment

- **Claude-mem**: 13.10.2
- **Claude Code**: 2.1.207
- **Node.js**: v24.3.0
- **Bun**: 1.3.13
- **OS**: Microsoft Windows 11 Home 10.0.26200 (x64)
- **Worker**: Not running (port orphaned at time of report)
- **Key settings**: `CLAUDE_MEM_WORKER_PORT: 37780` (already bumped twice as workaround: 37778 → 37779 → 37780)

## Failure sequence (from logs)

1. Worker running fine on port 37779.
2. Plugin triggers an internal restart (`reason=restart`, apparently after a version check).
3. Graceful shutdown fails: `Graceful shutdown failed — proceeding {reason=restart} Server is not running.`
4. Restart successor fails to spawn (`pid=0`).
5. The dead PID keeps the `LISTENING` socket bound in the Windows TCP table.
6. Every new worker start attempt fails with `Is port 37779 in use?`, and every hook client connects to the dead listener's kernel backlog and waits forever — burning the entire hook timeout (60–120s) instead of failing fast.

## Log evidence (`claude-mem-2026-07-12.log`)

```
[2026-07-11 23:52:10.457] [INFO ] [SYSTEM] HTTP server started {host=127.0.0.1, port=37779, pid=26440}
[2026-07-11 23:52:11.304] [INFO ] [SYSTEM] Worker started {host=127.0.0.1, port=37779, pid=26440}
[2026-07-11 23:52:14.175] [ERROR] [SYSTEM] Graceful shutdown failed — proceeding {reason=restart} Server is not running.
[2026-07-11 23:53:11.583] [WARN ] [SYSTEM] Worker port did not open after lazy-spawn within the cold-boot wait (~15s)
[2026-07-11 23:57:11.880] [INFO ] [SYSTEM] Restart successor spawned {pid=0, script=...\worker-service.cjs, port=37779}
[2026-07-12 00:02:30.885] [ERROR] [SYSTEM] ✗ Worker failed to start Failed to start server. Is port 37779 in use?
[2026-07-12 00:07:13.654] [ERROR] [SYSTEM] ✗ Worker failed to start Failed to start server. Is port 37779 in use?
```

## OS-level evidence

```
> netstat -ano | findstr :37779
  TCP    127.0.0.1:37779        0.0.0.0:0              LISTENING       26440
  TCP    127.0.0.1:37779        127.0.0.1:57441        ESTABLISHED     26440
  TCP    127.0.0.1:57441        127.0.0.1:37779        ESTABLISHED     2056

> tasklist /FI "PID eq 26440"
INFO: No tasks are running which match the specified criteria.
```

PID 26440 (the dead worker) still owns the `LISTENING` socket. PID 2056 was a live `bun.exe` hook client stuck connected to the dead listener, waiting until the hook timeout.

## Expected behavior

- Worker restart should shut down the old server gracefully **before** spawning the successor, and verify the successor actually bound the port.
- On startup, if the configured port is held by a PID that no longer exists, the worker should detect this and fall back to another port automatically instead of failing forever.
- Hook clients should use a short connect/response timeout and fail fast when the worker is unreachable, so a broken worker degrades silently instead of freezing every Claude Code interaction for 60–120s.

## Steps to reproduce

1. On Windows, run claude-mem v13.10.2 with the worker on its configured port.
2. Trigger the internal worker restart flow (observed with `reason=restart` after a version check).
3. Observe `Graceful shutdown failed — proceeding` followed by successor spawn with `pid=0`.
4. Check `netstat -ano`: the port is still `LISTENING`, owned by a PID that no longer exists in `tasklist`.
5. Every subsequent hook call hangs 60–120s; worker start attempts fail with `Is port ... in use?`.

## Workaround

Change `CLAUDE_MEM_WORKER_PORT` in `~/.claude-mem/settings.json` to a free port, or reboot Windows to clear the orphaned socket. (Not sustainable — each failed restart can burn another port.)