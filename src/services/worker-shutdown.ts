/**
 * Guarded worker shutdown sequence: the dying worker drains gracefully under
 * a hard deadline and, on restart, spawns its own successor so no other
 * process races it for the port
 * (plans/2026-06-10-worker-restart-single-source-of-truth.md).
 *
 * This lives in its own module rather than inside worker-service.ts for the
 * same reason as restart-verify.ts: worker-service.ts drags in a very large
 * dependency graph (bun:sqlite, MCP SDK, telemetry, supervisor, express) and
 * ends with an isMainModule bootstrap, which makes it unsafe to import from
 * `bun test`. WorkerService.shutdown() delegates here with its real
 * dependencies — this module IS the production shutdown logic, not a test
 * double.
 *
 * Sequence:
 *   1. Re-entrancy guard — /api/admin/restart, /api/admin/shutdown and the
 *      signal handler can all race into shutdown; only the first wins.
 *   2. Pre-shutdown bookkeeping (watcher/heartbeat/sentinel/telemetry).
 *   3. performGracefulShutdown under a hard deadline — it has no global
 *      deadline of its own and session drain has been observed at 35-40s.
 *   4. reason === 'restart' ONLY: spawn the successor worker as the dying
 *      worker's final act, AFTER the port is confirmed free. 'stop' and
 *      signal shutdowns stay kill-only.
 */

import { logger } from '../utils/logger.js';

/**
 * Closed enum for worker_stopped telemetry. Must stay in sync with the
 * shutdown_reason whitelist documentation (scrub.ts / telemetry.mdx):
 * stop = /api/admin/shutdown (CLI `stop`), restart = /api/admin/restart or
 * CLI `restart` (tagged ?reason=restart), signal = SIGTERM/SIGINT handler.
 */
export type WorkerShutdownReason = 'stop' | 'restart' | 'signal';

export interface RestartHandoffDeps {
  port: number;
  /** Budget for the old worker's port to close before giving up on the spawn. */
  portFreeTimeoutMs: number;
  /** Marketplace-script candidates with a dev-tree fallback (resolveWorkerScriptPath pattern). */
  resolveSuccessorScript: () => string;
  waitForPortFree: (port: number, timeoutMs: number) => Promise<boolean>;
  /**
   * Owner-or-dead guarded deletion (Phase 5): the production injection
   * (worker-service.ts) deletes only the dying worker's own PID file or a
   * dead pid's leftover — never a live successor's.
   */
  removePidFile: () => void;
  spawnDaemon: (scriptPath: string, port: number) => number | undefined;
}

export interface ShutdownSequenceOptions {
  reason: WorkerShutdownReason;
  /** Reads the owner's shutdown flag (WorkerService.isShuttingDown). */
  isShuttingDown: () => boolean;
  markShuttingDown: () => void;
  /** Pre-graceful bookkeeping: transcript watcher, heartbeat, sentinel, telemetry flush. */
  beforeGracefulShutdown: () => Promise<void>;
  performGracefulShutdown: () => Promise<void>;
  gracefulDeadlineMs: number;
  restartHandoff: RestartHandoffDeps;
}

export async function runShutdownSequence(options: ShutdownSequenceOptions): Promise<void> {
  if (options.isShuttingDown()) {
    logger.warn('SYSTEM', 'Shutdown already in progress — ignoring re-entrant shutdown request', {
      reason: options.reason,
    });
    return;
  }
  options.markShuttingDown();

  try {
    await options.beforeGracefulShutdown();
  } catch (error: unknown) {
    // Pre-graceful bookkeeping (watcher/heartbeat/sentinel/telemetry flush)
    // failing must not abort the sequence: graceful shutdown and — for
    // restarts — the successor handoff still have to run. Same "proceed on
    // error, never abort the handoff" policy as performGracefulShutdown below.
    logger.error(
      'SYSTEM',
      'Pre-graceful shutdown bookkeeping failed — proceeding',
      { reason: options.reason },
      error instanceof Error ? error : new Error(String(error))
    );
  }

  // Hard deadline around performGracefulShutdown: on expiry (or failure) log
  // and continue — a restart must never hang the dying worker on an unbounded
  // session drain.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    deadlineTimer = setTimeout(() => resolve('deadline'), options.gracefulDeadlineMs);
    deadlineTimer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      options.performGracefulShutdown().then(
        () => 'graceful' as const,
        (error: unknown) => {
          // A failed graceful shutdown must not abort the restart handoff;
          // proceed exactly like the deadline path.
          logger.error(
            'SYSTEM',
            'Graceful shutdown failed — proceeding',
            { reason: options.reason },
            error instanceof Error ? error : new Error(String(error))
          );
          return 'graceful-error' as const;
        }
      ),
      deadline,
    ]);
    if (outcome === 'deadline') {
      logger.warn('SYSTEM', 'Graceful shutdown deadline exceeded — proceeding', {
        deadlineMs: options.gracefulDeadlineMs,
        reason: options.reason,
      });
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }

  // Successor handoff — ONLY for restart; 'stop' and signal shutdowns stay
  // kill-only. The old worker spawns its replacement as its final act, after
  // its port is confirmed free, so the successor never races the corpse for
  // the port. The hook recycle path (ensureWorkerRunning in
  // src/shared/worker-utils.ts) waits for this successor instead of spawning
  // its own. This runs inside flushResponseThen's flushed action, so it
  // completes before that helper's process.exit(0).
  if (options.reason !== 'restart') return;

  const handoff = options.restartHandoff;
  try {
    const successorScript = handoff.resolveSuccessorScript();
    const portFree = await handoff.waitForPortFree(handoff.port, handoff.portFreeTimeoutMs);
    if (!portFree) {
      logger.error('SYSTEM', 'Restart successor NOT spawned: port never freed after graceful shutdown — the next hook lazy-spawn is the safety net', {
        port: handoff.port,
        timeoutMs: handoff.portFreeTimeoutMs,
      });
      return;
    }
    // Same ordering as the CLI restart path (worker-service.ts `restart`
    // case): port free → remove the now-ownerless PID file → spawn. Without
    // the removal a fast-booting successor can still see this not-yet-exited
    // process in the PID file and refuse to start as a "duplicate". The
    // injected implementation is owner-or-dead guarded (Phase 5): it deletes
    // only this dying worker's own file (or a dead pid's leftover), never a
    // live successor's.
    handoff.removePidFile();
    const successorPid = handoff.spawnDaemon(successorScript, handoff.port);
    if (successorPid === undefined) {
      logger.error('SYSTEM', 'Restart successor spawn FAILED — the next hook lazy-spawn is the safety net', {
        port: handoff.port,
        script: successorScript,
      });
      return;
    }
    logger.info('SYSTEM', 'Restart successor spawned', {
      pid: successorPid,
      script: successorScript,
      port: handoff.port,
    });
  } catch (error: unknown) {
    // spawnDaemon can throw (supervisor assertCanSpawn refuses while its stop
    // cascade is still in flight after a deadline); the handoff must never
    // turn the dying worker's exit into an unhandled rejection.
    logger.error(
      'SYSTEM',
      'Restart successor handoff threw — the next hook lazy-spawn is the safety net',
      { port: handoff.port },
      error instanceof Error ? error : new Error(String(error))
    );
  }
}
