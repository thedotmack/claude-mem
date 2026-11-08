/**
 * How long one auto-update attempt may take.
 *
 * The worker's "one attempt at a time" gate (auto-update-check.ts) stops
 * waiting on an attempt older than AUTO_UPDATE_SUPERVISOR_DEADLINE_MS once its
 * supervisor is gone, and on any attempt older than one check cycle
 * (AUTO_UPDATE_LIVE_SUPERVISOR_CEILING_MS), so an attempt whose supervisor
 * vanished can never hold updates back forever.
 * AUTO_UPDATE_INSTALLER_DEADLINE_MS is the kill deadline for one installer run,
 * for the supervisor that runs the installer.
 *
 * Both are backstops, not tuning values. Every step the installer runs already
 * stops itself at its own budget, so each deadline is the sum of the budgets
 * of the steps it covers: never short enough to cut a slow but working update
 * off, always finite so a hang still ends.
 */

import { DEFAULT_INSTALL_TIMEOUT_MS, INSTALL_TIMEOUT_MS } from '../../npx-cli/install/setup-runtime.js';
import { HOOK_TIMEOUTS } from '../../shared/hook-constants.js';
import { SPAWN_LOCK_STALE_MS } from '../../shared/worker-spawn-gate.js';
import { getPlatformTimeout } from '../infrastructure/ProcessManager.js';

/**
 * Steps of `npx --yes claude-mem@<version> update` that can each take the
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

/**
 * The `restart` CLI's budget for proving that a worker came back on the
 * expected version: verifyRestartedWorker(port, oldPid, version,
 * getPlatformTimeout(30000)) in worker-service.ts. An auto-update proves each
 * install with the same call and budget.
 */
const RESTART_PROOF_BASE_MS = 30_000;

/**
 * The longest one `npx --yes claude-mem@<version> update` can run while every
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
 * The longest one supervisor run can take. Its longest path is a failed
 * switch: install the target and prove it, then reinstall the previous
 * version and prove that. Every other path runs fewer steps. With the
 * defaults: 2 × (34 min 25 s + 30 s) = 69 min 50 s (71 min 50 s on Windows).
 */
export function autoUpdateSupervisorDeadlineMs(installerDeadlineMs: number = autoUpdateInstallerDeadlineMs()): number {
  return INSTALL_AND_PROVE_RUNS_ON_THE_LONGEST_PATH * (installerDeadlineMs + getPlatformTimeout(RESTART_PROOF_BASE_MS));
}

export const AUTO_UPDATE_INSTALLER_DEADLINE_MS = autoUpdateInstallerDeadlineMs();
export const AUTO_UPDATE_SUPERVISOR_DEADLINE_MS = autoUpdateSupervisorDeadlineMs();
