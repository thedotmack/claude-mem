/**
 * How long one auto-update attempt may take.
 *
 * The worker's "one attempt at a time" gate (auto-update-check.ts) stops
 * waiting on an attempt older than AUTO_UPDATE_SUPERVISOR_DEADLINE_MS once its
 * recorded supervisor is gone, and on any attempt older than one check cycle
 * (AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS), so an attempt whose supervisor
 * vanished can never hold updates back forever.
 * AUTO_UPDATE_INSTALLER_DEADLINE_MS is the kill deadline for one installer run,
 * and AUTO_UPDATE_WORKER_STARTUP_CEILING_MS the longest the supervisor waits
 * for a worker to finish starting (auto-update-launch.ts).
 *
 * All are backstops, not tuning values. Every step they cover already stops
 * itself at its own budget, so each deadline is the sum of the budgets of the
 * steps it covers: never short enough to cut a slow but working update off,
 * always finite so a hang still ends.
 */

import { DEFAULT_INSTALL_TIMEOUT_MS, INSTALL_TIMEOUT_MS } from '../../npx-cli/install/setup-runtime.js';
import { HOOK_TIMEOUTS, readWedgedWorkerUptimeSeconds } from '../../shared/hook-constants.js';
import { SPAWN_LOCK_STALE_MS } from '../../shared/worker-spawn-gate.js';
import { getPlatformTimeout, WORKER_BOOT_BIND_DEADLINE_MS } from '../infrastructure/ProcessManager.js';

/**
 * Steps of `npx --yes --no-workspaces --package=claude-mem@<version>
 * claude-mem update` that can each take the
 * installer's INSTALL_TIMEOUT_MS, in the order they run:
 *  1. npx downloads the package (28.5 MB unpacked for 15.10.1) and its
 *     dependencies before any installer code runs, so no installer timer
 *     covers it. It is the same kind of work as the dependency installs
 *     below, so it gets the same budget.
 *  2. the Bun installer and 3. the uv installer, each run only when that tool
 *     is missing (setup-runtime.ts ensureBun / ensureUv).
 *  4. `bun install` in cache/<version> (setup-runtime.ts installPluginDependencies).
 *  5. `npm install` in the marketplace copy and 6. its one --legacy-peer-deps
 *     retry after an ERESOLVE (install.ts runNpmInstallInMarketplace; its
 *     budget, npm-install-helper.ts resolveInstallTimeoutMs, reads the same
 *     variable with the same default).
 */
const INSTALL_TIMEOUT_BUDGETED_STEPS = 6;

// The update path's fixed budgets, copied from install.ts: that module is the
// whole installer, too large to bundle into the worker. Nothing checks the
// copies, so a change to one of these install.ts budgets, or a new step with
// its own budget, has to be made here too.
/** install.ts TREE_SITTER_INSTALL_BUDGET_MS: provisioning the tree-sitter CLI. */
const INSTALLER_TREE_SITTER_CLI_BUDGET_MS = 2 * 60 * 1000;
/** install.ts INSTALL_SPAWN_LOCK_WAIT_MS: waiting out a launcher that holds the spawn lock before the worker is stopped. */
const INSTALLER_SPAWN_LOCK_WAIT_MS = SPAWN_LOCK_STALE_MS + 5_000;
/** install.ts requireWorkerStopped: stopWorker(port, 10000), the budget of one worker stop. */
const INSTALLER_WORKER_STOP_BUDGET_MS = 10_000;
/**
 * A non-interactive update stops the worker twice, each with that budget:
 *  1. before it overwrites the plugin files: overwriteWithWorkerStopped →
 *     requireWorkerStopped(port, 'pre-overwrite') (install.ts:2606);
 *  2. in its final "Starting worker daemon" task, which stops any worker that
 *     came up during the install before it starts the new one:
 *     requireWorkerStopped(port, 'provider-cutover') (install.ts:3419).
 * The browser funnel's startInstallWorker makes one more provider-cutover stop
 * (install.ts:2866), but the funnel runs only when stdin is a TTY
 * (install.ts:70 isInteractive, browser-setup.ts shouldUseBrowserSetup), and
 * an unattended update has none.
 */
const INSTALLER_WORKER_STOPS_ON_THE_UPDATE_PATH = 2;

/** Unit conversion: the wedged-worker grace is configured in seconds. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * The longest the supervisor waits for a worker to finish starting before it
 * counts the install as not proven (auto-update-launch.ts autoUpdateWorkerProof).
 * The worker reports its startup on GET /api/ready (server/init-phase.ts:
 * starting, db_ready, routes_ready, then ready, or failed with a message), and
 * the proof waits while it is still starting and stops at once on failed. A
 * start that runs database migrations can also go silent for a while: they run
 * synchronously and hold the worker's event loop. Neither is a failure until
 * one of the worker's own startup bounds has passed:
 *  1. WORKER_BOOT_BIND_DEADLINE_MS: a worker that has not bound its port 60 s
 *     after it started exits (worker-service.ts boot watchdog);
 *  2. readWedgedWorkerUptimeSeconds(): from its bind (when it writes its PID
 *     file) a launcher's port reclaim treats a silent worker as "booting or
 *     migrating", never wedged, until it has been up this long: 300 s unless
 *     CLAUDE_MEM_WEDGED_WORKER_UPTIME_S sets it (port-reclaim.ts
 *     reclaimWedgedOwnedWorker).
 * So a worker this codebase still counts as starting has been up at most
 * their sum: 60 s + 300 s = 6 min with the defaults. The proof starts once the installer
 * (or ensureWorkerStarted) has started the worker, so waiting that long from
 * the proof's start covers the worker's whole start. The restart CLI's 30 s
 * budget is not used: on the owner's Mac, three of four worker starts on
 * 2026-11-04 and -05 spent 13.7 s to 15.8 s in "Initializing database
 * manager" alone, with no migration to run (worker log), so a start that
 * migrates a large database can pass 30 s while healthy. Neither bound scales
 * on Windows, so this does not either.
 */
export function autoUpdateWorkerStartupCeilingMs(env: NodeJS.ProcessEnv = process.env): number {
  return WORKER_BOOT_BIND_DEADLINE_MS + readWedgedWorkerUptimeSeconds(env) * MILLISECONDS_PER_SECOND;
}

export const AUTO_UPDATE_WORKER_STARTUP_CEILING_MS = autoUpdateWorkerStartupCeilingMs();

/**
 * After the installer deadline's tree-kill, how long the supervisor waits for
 * the installer's own process to exit before it treats it as still running:
 * the 1 s the supervisor's shutdown waits for SIGKILLed processes to be gone
 * (supervisor/shutdown.ts, waitForExit(survivors, 1000)). SIGKILL cannot be
 * caught, so only a kill that did not land outlives it.
 */
export const INSTALLER_EXIT_AFTER_KILL_WAIT_MS = 1_000;

/**
 * connection.ts SQLITE_BUSY_TIMEOUT_MS, the longest one SQLite statement waits
 * for a lock. Copied, not imported: connection.ts loads bun:sqlite, and the
 * worker's check (which imports this module) stays free of database code.
 * tests/services/auto-update/auto-update-deadlines.test.ts pins the copy.
 */
const SQLITE_BUSY_TIMEOUT_COPY_MS = 5_000;

/**
 * Reading the database's schema stamp without writing to it
 * (auto-update-launch.ts readDatabaseSchemaStamp: connection.ts
 * openReaderDatabase, then readSchemaWriterStamp) runs at most four statements
 * that can each wait out the busy timeout: the read-only probe; when that
 * fails, the read-write probe and a second read-only probe; then the stamp.
 */
const SCHEMA_STAMP_READ_BUSY_WAITS = 4;

/**
 * The `restart` CLI's budget for reading the running worker's pid before it
 * restarts it: getCurrentWorkerPid(port, 2000) in worker-service.ts. The
 * supervisor reads it the same way before each installer run, so the proof
 * after it can require a new pid.
 */
export const WORKER_PID_CAPTURE_TIMEOUT_MS = 2_000;

/**
 * Bounds each background fetch, so a hung connection cannot hold a tick open.
 * It only bounds the tick and is not a tuning value: measured 0.26 s for
 * raw.githubusercontent.com and 0.55 s for registry.npmjs.org (2026-11-06).
 * It lives here, not in auto-update-check.ts (which re-exports it), because
 * the supervisor deadline below counts one such fetch.
 */
export const AUTO_UPDATE_FETCH_TIMEOUT_MS = 10_000;

/**
 * The longest one `npx --yes --no-workspaces
 * --package=claude-mem@<version> claude-mem update` can run while every
 * step stays inside its own budget: the six INSTALL_TIMEOUT_MS steps, the
 * fixed install.ts steps (both worker stops included), and the wait for the
 * restarted worker to report ready (getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT),
 * worker-spawner.ts). With the 5-minute default:
 * 6 × 5 min + 2 min + 95 s + 2 × 10 s + 30 s = 34 min 25 s
 * (34 min 55 s on Windows, where platform timeouts double).
 *
 * CLAUDE_MEM_INSTALL_TIMEOUT_MS=0 turns the installer's own timers off. The
 * deadline must stay finite, so it counts the default per step then.
 */
export function autoUpdateInstallerDeadlineMs(installTimeoutMs: number = INSTALL_TIMEOUT_MS): number {
  const perStepBudgetMs = installTimeoutMs > 0 ? installTimeoutMs : DEFAULT_INSTALL_TIMEOUT_MS;
  return INSTALL_TIMEOUT_BUDGETED_STEPS * perStepBudgetMs
    + INSTALLER_TREE_SITTER_CLI_BUDGET_MS
    + INSTALLER_SPAWN_LOCK_WAIT_MS
    + INSTALLER_WORKER_STOPS_ON_THE_UPDATE_PATH * INSTALLER_WORKER_STOP_BUDGET_MS
    + getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT);
}

/** A failed switch runs the install-and-prove sequence twice: once for the target, once to restore the previous version. */
const INSTALL_AND_PROVE_RUNS_ON_THE_LONGEST_PATH = 2;

/**
 * Before each proof the supervisor reads whether a worker runs and, when none
 * does, starts one (auto-update-apply.ts startWorkerIfNoneRuns). The read is
 * one GET /api/health under WORKER_PID_CAPTURE_TIMEOUT_MS, then the PID file,
 * which waits for nothing. The start (worker-spawner.ts ensureWorkerStarted)
 * is counted the way autoUpdateInstallerDeadlineMs counts the installer's own
 * start: its readiness wait, getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT),
 * the one wait in it that is not a short probe.
 */
function workerStartBeforeProofBudgetMs(): number {
  return WORKER_PID_CAPTURE_TIMEOUT_MS + getPlatformTimeout(HOOK_TIMEOUTS.READINESS_WAIT);
}

/**
 * The longest one supervisor run can take (auto-update-apply.ts). Its longest
 * path is a failed switch: read the worker's pid, install the target (killed
 * at its deadline, then the wait for its exit), start a worker when none runs
 * and wait for it; then read the database's schema stamp, check on npm that
 * the previous version is fully published (one fetch), read the pid again,
 * reinstall the previous version the same way, start a worker when none runs
 * and wait for it. The check before the first installer reads files only and
 * waits for nothing. Every other path runs fewer or shorter steps: one blocked
 * by the database's schema waits for the target's worker twice but runs one
 * installer. With the defaults:
 * 2 × (2 s + 34 min 25 s + 1 s + 2 s + 30 s + 6 min) + 4 × 5 s + 10 s = 82 min 30 s
 * (84 min 30 s on Windows).
 */
export function autoUpdateSupervisorDeadlineMs(
  installerDeadlineMs: number = autoUpdateInstallerDeadlineMs(),
  workerStartupCeilingMs: number = AUTO_UPDATE_WORKER_STARTUP_CEILING_MS,
): number {
  return INSTALL_AND_PROVE_RUNS_ON_THE_LONGEST_PATH
    * (WORKER_PID_CAPTURE_TIMEOUT_MS + installerDeadlineMs + INSTALLER_EXIT_AFTER_KILL_WAIT_MS
      + workerStartBeforeProofBudgetMs() + workerStartupCeilingMs)
    + SCHEMA_STAMP_READ_BUSY_WAITS * SQLITE_BUSY_TIMEOUT_COPY_MS
    + AUTO_UPDATE_FETCH_TIMEOUT_MS;
}

export const AUTO_UPDATE_INSTALLER_DEADLINE_MS = autoUpdateInstallerDeadlineMs();
export const AUTO_UPDATE_SUPERVISOR_DEADLINE_MS = autoUpdateSupervisorDeadlineMs();
