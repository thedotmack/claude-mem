# Phase 04: ChromaDB Subprocess Lifecycle

This phase fixes the fire-and-forget subprocess management in the ChromaDB/MCP subsystem, which is the root cause of 8+ issues: process leaks consuming CPU/memory, proxy failures, initialization races, and chroma-mcp zombie accumulation. The core problem is that `ChromaMcpManager` spawns a `uvx chroma-mcp` subprocess but has no health monitoring, no resource limits, and no reliable cleanup when the subprocess wedges.

## Tasks

- [ ] Add health monitoring and automatic recovery to `ChromaMcpManager`. Currently the manager detects subprocess death only via transport close events, which don't fire when the process hangs (CPU spin, deadlock). To fix:
  - Read `src/services/sync/ChromaMcpManager.ts` thoroughly — understand the full lifecycle: `ensureConnected()`, `callTool()`, `stop()`, and the transport close handler (around lines 166-181)
  - Add a periodic health check (every 60 seconds) that sends a lightweight `chroma_list_collections` or similar no-op call through the MCP transport with a 10-second timeout
  - If the health check times out or fails 3 consecutive times:
    - Log the failure with `logger.error('CHROMA', 'Health check failed, restarting subprocess')`
    - Call `stop()` to kill the current subprocess
    - Clear connection state so next `callTool()` triggers `ensureConnected()` with fresh subprocess
  - Ensure the health check interval is cleared in `stop()` to prevent leaks
  - Use the existing `RECONNECT_BACKOFF_MS` (10 seconds) to avoid rapid restart loops after health-triggered restarts

- [ ] Fix chroma-mcp CPU spin on failed initialization. When `uvx` fails (Python not found, package download error, network timeout), the subprocess can enter a busy-wait loop that consumes 100% CPU. To fix:
  - Read `ChromaMcpManager.ts` `spawnChromaMcp()` (around lines 188-234) to understand how the subprocess is launched
  - Add resource monitoring after spawn: check the subprocess's CPU usage after 10 seconds using `process.cpuUsage()` of the parent or by reading `/proc/<pid>/stat` on Linux / `ps -p <pid> -o %cpu` on macOS
  - If CPU exceeds 80% for 10+ seconds after spawn, kill the subprocess and mark Chroma as permanently unavailable for this worker session (avoid infinite restart loops)
  - Add a `maxConsecutiveFailures` counter (default: 3). After 3 failed connection attempts, disable Chroma for the session and log: `"Chroma disabled after 3 failed connection attempts. Vector search unavailable — SQLite search still active."`
  - Ensure this counter resets on successful connection

- [ ] Fix the chroma-mcp process tree cleanup to prevent zombie accumulation. The current `aggressiveStartupCleanup()` in `ProcessManager.ts` kills `chroma-mcp` processes immediately on startup, but spawned `uvx` children (the actual Python process) can survive parent death. To fix:
  - Read `src/services/infrastructure/ProcessManager.ts` `aggressiveStartupCleanup()` (around lines 450-574) and `cleanupOrphanedProcesses()` (around lines 314-431)
  - On Unix: use `kill(-pgid, SIGTERM)` (process group kill) instead of individual PID kill to ensure all child processes of `uvx` are terminated. Check if `setsid` is used when spawning (it is for the worker, but verify for chroma-mcp)
  - On Windows: the existing `taskkill /T /F` should handle tree kills — verify it actually works for `uvx`/Python child processes by checking if the `/T` flag traverses the full process tree
  - In `ChromaMcpManager.stop()`, add a verification step: after sending SIGTERM/SIGKILL, wait 2 seconds and check if the PID is still alive. If so, force kill again
  - Add the chroma-mcp subprocess PID to the worker's PID file (`~/.claude-mem/worker.pid`) as a `chromaPid` field, so orphan cleanup can find it even if the worker crashes without cleanup

- [ ] Implement graceful degradation when Chroma is unavailable. Currently, Chroma failures can cause cascading errors in the observation pipeline. To fix:
  - Read `src/services/worker/agents/ResponseProcessor.ts` (around lines 195-218) for the fire-and-forget Chroma sync pattern
  - Read `src/services/sync/ChromaSync.ts` for `syncObservation()` and `queryDocuments()`
  - Verify that ALL Chroma calls in the hot path (observation storage, search) have proper try-catch that falls back to SQLite-only operation
  - Add a `chromaAvailable` flag to `DatabaseManager` or `ChromaMcpManager` that is checked before attempting any Chroma operations — skip Chroma calls entirely when disabled instead of attempting and catching errors each time
  - When Chroma transitions from available→unavailable, log once: `"Chroma unavailable — falling back to SQLite-only search. Vector search disabled."`
  - When Chroma transitions from unavailable→available (on successful reconnect), log: `"Chroma reconnected — vector search restored."`
  - Ensure the search API response includes a `chromaAvailable: boolean` field so the UI can indicate search mode

- [ ] Write tests for ChromaDB lifecycle management:
  - Test health check: mock a connected transport, simulate 3 consecutive health check timeouts, verify subprocess restart is triggered
  - Test CPU spin detection: mock subprocess with high CPU, verify it's killed and Chroma marked disabled after threshold
  - Test max consecutive failures: simulate 3 connection failures, verify Chroma disabled for session
  - Test graceful degradation: mock Chroma unavailable, verify observation storage succeeds via SQLite, verify search returns SQLite-only results
  - Test process tree cleanup: mock subprocess with child processes, verify all are killed

- [ ] Run build and verify:
  - Run `npm run build-and-sync`
  - Run the test suite and fix any failures
  - Verify the built `worker-service.cjs` includes the new health monitoring logic
  - Search for any remaining fire-and-forget patterns (`.then().catch()` without proper error state management) in Chroma-related code
