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
  /**
   * Bounded teardown of the OS subprocess tree that leaks when the graceful
   * sequence is cut short — in production, chroma-mcp. performGracefulShutdown
   * already stops it, but only as its second-to-last step, behind a session
   * drain observed at 35-40s (see the deadline note above). When the deadline
   * wins that race the process exits with that step unreached, orphaning the
   * tree to init. This runs it again on its own budget so subprocess teardown
   * is never collateral of a slow drain.
   *
   * Must be idempotent: on the deadline path the abandoned
   * performGracefulShutdown is still in flight and may reach the same teardown
   * concurrently.
   *
   * Must not hold state that the restart handoff depends on — it runs to
   * completion (or times out) BEFORE spawnRestartSuccessor. The supervisor
   * cascade is therefore NOT part of this hook; it is reapProcessRegistry
   * below, on the far side of the handoff.
   */
  reapSubprocesses: () => Promise<void>;
  /**
   * The supervisor's registry cascade — the OTHER teardown step the deadline
   * skips, covering every managed child (SDK trees, mcp servers), not just
   * chroma. Split from reapSubprocesses because it must run AFTER the restart
   * handoff: it holds the supervisor's spawn gate for its duration, so running
   * it first can make the successor spawn fail. See the call site.
   *
   * `successorSpawned` reports whether the handoff attempt successfully
   * launched a successor process. Once it has, that successor may register
   * itself in supervisor.json at any point, so this cascade must not write to
   * the file. If the launch failed, normal cleanup applies.
   */
  reapProcessRegistry: (successorSpawned: boolean) => Promise<void>;
  /**
   * Budget for reapSubprocesses — a chroma tree-kill is ~200ms, not 40s. Kept
   * tight because this one runs BEFORE the handoff and so delays the successor.
   */
  reapDeadlineMs: number;
  /**
   * Budget for reapProcessRegistry, which needs a bigger one: the cascade is
   * SIGTERM -> waitForExit(5s) -> SIGKILL -> waitForExit(1s) -> unregister, so
   * anything under ~6s truncates it mid-SIGKILL and skips the unregister pass,
   * leaving stubborn children alive at process.exit(). On Windows each signal
   * additionally shells out to taskkill with its own 10s timeout, per child, so
   * the true worst case is unbounded by any fixed number — see the production
   * value for how that is sized and why truncation is acceptable there.
   *
   * Affordable because this runs AFTER the handoff: it delays only this dying
   * process, not the successor, which is already up. And it is a ceiling, not a
   * sleep — a fast cascade returns immediately.
   */
  reapRegistryDeadlineMs: number;
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
  let outcome: 'graceful' | 'graceful-error' | 'deadline';
  try {
    outcome = await Promise.race([
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

  // Subprocess teardown backstop. performGracefulShutdown stops the chroma-mcp
  // tree second-to-last, behind the session drain, so on the deadline path it
  // has definitely not run; on the error path it may not have (steps fail fast,
  // so an early failure skips it). Either way the caller — flushResponseThen or
  // the supervisor signal handler — is about to process.exit(), abandoning the
  // in-flight promise and reparenting the tree (uvx -> uv -> python) to init,
  // where it survives indefinitely because chroma-mcp does not terminate on
  // stdin EOF.
  //
  // Nothing downstream catches it either: the supervisor's registry cascade is
  // the LAST step of the same sequence, and the signal handler's
  // Supervisor.stop() fallback fires only when the handler *throws* — a
  // deadline-expired shutdown returns normally. So this is the last point at
  // which a leaked tree can still be reaped in-process.
  if (outcome !== 'graceful') {
    await reapUnderDeadline(
      options.reapSubprocesses, 'subprocess teardown', options.reapDeadlineMs, options, outcome
    );
  }

  // Successor handoff — ONLY for restart; 'stop' and signal shutdowns stay
  // kill-only. The old worker spawns its replacement as its final act, after
  // its port is confirmed free, so the successor never races the corpse for
  // the port. CLI `claude-mem restart` is the caller. Hook version-mismatch
  // recycles (ensureWorkerRunning in src/shared/worker-utils.ts) never reach
  // this: they SIGKILL the stale worker and lazy-spawn the resolved version
  // themselves, because this handoff runs the DYING install's resolver — a
  // stale install would respawn its own version forever (#3378). This runs
  // inside flushResponseThen's flushed action, so it completes before that
  // helper's process.exit(0).
  // Whether spawnDaemon() returned a pid for a successor process. NOT proof
  // that the successor is live, registered, or has touched supervisor.json —
  // only that a launch happened, after which it may register at any moment.
  // That is the point at which this worker must stop writing. If the launch
  // failed, it remains the sole known writer and cleans up as it always did.
  let successorSpawned = false;

  if (options.reason === 'restart') {
    const handoff = options.restartHandoff;
    try {
      successorSpawned = await spawnRestartSuccessor(handoff);
    } catch (error: unknown) {
      // spawnDaemon can still throw if something else concurrently started a
      // supervisor stop (assertCanSpawn refuses while stopPromise is set); the
      // handoff must never turn the dying worker's exit into an unhandled
      // rejection. deferSupervisorStop rules out this sequence's own graceful
      // path as that "something else".
      logger.error(
        'SYSTEM',
        'Restart successor handoff threw — the next hook lazy-spawn is the safety net',
        { port: handoff.port },
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  // Registry cascade, AFTER the handoff — deliberately, and this ordering is
  // load-bearing. Supervisor.stop() holds its stopPromise for the whole cascade
  // (SIGTERM -> waitForExit(5s) -> SIGKILL), and assertCanSpawn() refuses any
  // spawn while that is set. Run before the handoff and a cascade still in
  // flight makes spawnDaemon throw, trading a leaked subprocess for a worker
  // that never comes back. Running it after is safe in both directions: the
  // spawn gate has already been passed, and spawnDaemon spawns the successor
  // detached WITHOUT registering it (ProcessManager.ts), so the cascade
  // iterates only this worker's own children and cannot signal its replacement.
  // ProcessRegistry.getAll() is in-memory after a once-guarded initialize()
  // (process-registry.ts), so the successor's own records — written to the
  // shared supervisor.json on its boot — are invisible here and are not
  // signalled by this cascade. (Not an absolute guarantee: a stale child record
  // whose pid the OS has since recycled onto the successor would still be
  // signalled. That hazard predates this ordering and applies to any pid-based
  // teardown here.)
  //
  // On a restart this is the ONLY cascade: performGracefulShutdown defers its
  // own (deferSupervisorStop), so ownership of the restart-path cascade lives
  // here and it always runs after the handoff — including on the fully graceful
  // outcome, where it is not a backstop but the sequence's own teardown step.
  //
  // That single invariant is what keeps the successor spawnable. The deadline
  // does not cancel the graceful promise, so if that promise could still reach
  // getSupervisor().stop() it would set stopPromise on either side of the
  // boundary — finishing just before expiry, or resuming just after — and
  // assertCanSpawn() would refuse the handoff. Deferring removes the race
  // instead of trying to out-time it.
  //
  // Preserve mode is gated on a successor process having been LAUNCHED, not
  // merely on this being a restart. All three handoff failure paths (port never
  // freed, spawnDaemon returned undefined, spawnDaemon threw) leave this worker
  // as the sole known writer, so suppressing writes there would strand its own
  // records with nothing to prune them — a regression against the pre-existing
  // behavior, where the graceful path cleaned up before exit.
  //
  // Once a successor is launched, the cascade signals this worker's children
  // without writing to a file that successor may claim at any moment. What it
  // leaves behind is normally pruned by the successor's 30s health check —
  // normally, not always: that repair needs a successor which stayed up, and
  // pid reuse can make a dead record look alive, so the file can over-report
  // stale processes for a while. Accepted direction of error, against erasing a
  // live worker's record.
  if (options.reason === 'restart' || outcome !== 'graceful') {
    await reapUnderDeadline(
      () => options.reapProcessRegistry(successorSpawned),
      'registry cascade', options.reapRegistryDeadlineMs, options, outcome
    );
  }
}

/**
 * Run the subprocess teardown under its own short deadline, never throwing.
 *
 * Bounded for the same reason the graceful sequence is: the dying worker must
 * not hang. But this budget is sized for a tree-kill (~200ms), not a session
 * drain, so it cannot be starved by the work that overran the outer deadline.
 * On expiry we proceed anyway — a boot-time reaper in the successor is the
 * remaining backstop for whatever survives.
 */
async function reapUnderDeadline(
  reap: () => Promise<void>,
  label: string,
  deadlineMs: number,
  options: ShutdownSequenceOptions,
  outcome: 'graceful' | 'graceful-error' | 'deadline'
): Promise<void> {
  // On a graceful restart this is not a backstop: the graceful sequence deferred
  // the cascade to here on purpose, so "did not reach" would be a false alarm.
  if (outcome === 'graceful') {
    logger.info('SYSTEM', `Running ${label} after the restart handoff`, {
      outcome,
      reason: options.reason,
      reapDeadlineMs: deadlineMs,
    });
  } else {
    logger.warn('SYSTEM', `Graceful shutdown did not reach ${label} — reaping directly`, {
      outcome,
      reason: options.reason,
      reapDeadlineMs: deadlineMs,
    });
  }

  let reapTimer: ReturnType<typeof setTimeout> | undefined;
  const reapDeadline = new Promise<'deadline'>((resolve) => {
    reapTimer = setTimeout(() => resolve('deadline'), deadlineMs);
    reapTimer.unref?.();
  });

  try {
    const reapOutcome = await Promise.race([
      reap().then(
        () => 'reaped' as const,
        (error: unknown) => {
          logger.error(
            'SYSTEM',
            `Reap of ${label} failed — proceeding to exit`,
            { reason: options.reason },
            error instanceof Error ? error : new Error(String(error))
          );
          return 'reap-error' as const;
        }
      ),
      reapDeadline,
    ]);
    if (reapOutcome === 'deadline') {
      logger.error('SYSTEM', `Reap of ${label} exceeded its deadline — processes may be orphaned`, {
        reapDeadlineMs: deadlineMs,
        reason: options.reason,
      });
    } else if (reapOutcome === 'reaped') {
      logger.info('SYSTEM', `Reaped ${label} via shutdown backstop`, {
        reason: options.reason,
      });
    }
  } finally {
    if (reapTimer !== undefined) clearTimeout(reapTimer);
  }
}

/**
 * The restart handoff proper: wait for the dying worker's port to free, drop
 * the now-ownerless PID file, then spawn the successor. Extracted from
 * runShutdownSequence so its caller's try wraps a single call; every failure
 * path logs and returns (the next hook lazy-spawn is the safety net).
 */
async function spawnRestartSuccessor(handoff: RestartHandoffDeps): Promise<boolean> {
  const successorScript = handoff.resolveSuccessorScript();
  const portFree = await handoff.waitForPortFree(handoff.port, handoff.portFreeTimeoutMs);
  if (!portFree) {
    logger.error('SYSTEM', 'Restart successor NOT spawned: port never freed after graceful shutdown — the next hook lazy-spawn is the safety net', {
      port: handoff.port,
      timeoutMs: handoff.portFreeTimeoutMs,
    });
    return false;
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
    return false;
  }
  logger.info('SYSTEM', 'Restart successor spawned', {
    pid: successorPid,
    script: successorScript,
    port: handoff.port,
  });
  return true;
}
