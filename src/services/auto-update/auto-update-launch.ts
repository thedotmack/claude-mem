/**
 * How an auto-update leaves the worker and reaches the installer, and the
 * production effects of the supervisor (auto-update-apply.ts).
 *
 *   worker ─spawn, detached─▶ hop ─spawn, detached─▶ supervisor ─spawn─▶ npx --yes claude-mem@<version> update
 *
 *  1. The worker (launchAutoUpdateSupervisor) writes the attempt in flight,
 *     starts `<its runtime> <its own worker script> auto-update-apply ...
 *     --detached-hop` and waits for that hop to exit, within
 *     AUTO_UPDATE_HOP_EXIT_BUDGET_MS.
 *  2. The hop (runAutoUpdateApplyCommand with --detached-hop) starts the same
 *     runtime and script again without the flag, and exits as soon as that
 *     process exists. Exit 0 tells the worker the supervisor was started;
 *     anything else is a launch failure, which the check records without
 *     blocking the version (auto-update-check.ts gate 9).
 *  3. Once the hop has exited, the supervisor has no parent in the worker's
 *     tree (the OS reparents it), so a recycle tree-kill, which walks the
 *     worker's descendants (kill-process-tree.ts), cannot reach it while the
 *     installer stops and restarts the worker (#3793).
 *  4. The supervisor (applyAutoUpdate) runs the installer as its own child,
 *     so it can tree-kill it at the deadline, from a working directory
 *     outside every npm project (autoUpdateInstallerWorkingDirectory).
 *
 * The hop and the supervisor run the worker script the worker was started
 * with, which belongs to the version being replaced, so the supervisor runs
 * known-good code, never the incoming release.
 *
 * FORBID_REAL_AUTO_UPDATE_ENV keeps every test from starting any of this for
 * real; see its comment.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from 'fs';
import path from 'path';
import type { ChildProcess } from 'child_process';
import { installedPluginsPath, marketplaceDirectory, pluginCacheDirectory } from '../../npx-cli/utils/paths.js';
import { readUserScopeRegisteredCacheVersions } from '../../npx-cli/utils/prune-cache.js';
import { INSTALL_RUN_BY_AUTO_UPDATE_ENV, INSTALL_RUN_BY_AUTO_UPDATE_VALUE } from '../../shared/auto-update-install-run.js';
import { killProcessTree } from '../../shared/kill-process-tree.js';
import { DB_PATH, paths } from '../../shared/paths.js';
import { commandInvocation, lookupWindowsCommand, spawnHidden, windowsSystemRootDirectory, type CommandInvocation } from '../../shared/spawn.js';
import { readPackageVersion, resolvePluginRoot, resolveWorkerScriptPath, type WorkerScriptSearchRoots } from '../../shared/worker-utils.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { readOwnedWorkerPidInfo, type PidInfo } from '../../supervisor/process-registry.js';
import { logger } from '../../utils/logger.js';
import { daemonWorkingDirectory, getPlatformTimeout, WORKER_BOOT_PROBE_TIMEOUT_MS } from '../infrastructure/ProcessManager.js';
import { getCurrentWorkerPid, verifyWorkerFinishedStarting } from '../restart-verify.js';
import { LATEST_SCHEMA_VERSION, openReaderDatabase, readSchemaWriterStamp } from '../sqlite/connection.js';
import { captureEvent, shutdownTelemetry } from '../telemetry/telemetry.js';
import { ensureWorkerStarted, type WorkerStartResult } from '../worker-spawner.js';
import {
  applyAutoUpdate,
  readInterruptedAttemptInstall,
  writeOrphanedMarker,
  type AutoUpdateApplyAttempt,
  type AutoUpdateApplyDeps,
  type AutoUpdateInstallerRun,
  type AutoUpdateWorkerProof,
  type DatabaseSchemaStampRead,
  type InstallVersionsRead,
  type InterruptedAttemptInstall,
  type RunningWorkerRead,
} from './auto-update-apply.js';
import { fetchJsonWithTimeout, INSTALLED_VERSION_PATTERN, readNpmPublication, RELEASE_VERSION_PATTERN } from './auto-update-check.js';
import {
  AUTO_UPDATE_INSTALLER_DEADLINE_MS,
  AUTO_UPDATE_SUPERVISOR_DEADLINE_MS,
  AUTO_UPDATE_WORKER_STARTUP_CEILING_MS,
  INSTALLER_EXIT_AFTER_KILL_WAIT_MS,
  WORKER_PID_CAPTURE_TIMEOUT_MS,
} from './auto-update-deadlines.js';
import { readAutoUpdateState, writeAutoUpdateState, type AutoUpdateState } from './auto-update-state.js';

/** The worker CLI subcommand of the hop and the supervisor (worker-service.ts dispatcher). Never a user command. */
export const AUTO_UPDATE_APPLY_COMMAND = 'auto-update-apply';

const TARGET_VERSION_FLAG = '--target-version';
const PREVIOUS_VERSION_FLAG = '--previous-version';
const ATTEMPT_STARTED_AT_FLAG = '--attempt-started-at';
const DETACHED_HOP_FLAG = '--detached-hop';

const AUTO_UPDATE_APPLY_USAGE = `Usage: worker-service ${AUTO_UPDATE_APPLY_COMMAND} ${TARGET_VERSION_FLAG} <X.Y.Z> ${PREVIOUS_VERSION_FLAG} <version> ${ATTEMPT_STARTED_AT_FLAG} <epoch ms> [${DETACHED_HOP_FLAG}]`;

/** The conventional process exit codes: 0 for success, 1 for failure. */
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

/**
 * How long the worker waits for the hop to exit. The hop is one Bun process
 * that loads the worker bundle, starts one process and exits: the same work
 * as probeWorkerBootFailure's `status` probe (load the bundle, run one short
 * command, exit), so it gets that probe's budget,
 * getPlatformTimeout(WORKER_BOOT_PROBE_TIMEOUT_MS) in ProcessManager.ts: 5 s,
 * 10 s on Windows. Measured: `bun plugin/scripts/worker-service.cjs --version`
 * took 0.20 s on the owner's Mac (2026-11-08). A hop still running then is
 * killed, and the launch counts as failed.
 */
export const AUTO_UPDATE_HOP_EXIT_BUDGET_MS = getPlatformTimeout(WORKER_BOOT_PROBE_TIMEOUT_MS);

/** Unit conversion, so log lines state budgets in seconds. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * Set by tests/preload.ts for every `bun test` process before any module
 * loads, and inherited by every process a test starts (sanitizeEnv keeps
 * CLAUDE_MEM_* names). While it holds any value, every production effect that
 * could start a real auto-update refuses before it acts:
 *  - the worker's launcher (productionAutoUpdateLaunchDeps): no hop starts and
 *    no state is written;
 *  - the hop and supervisor CLI (productionAutoUpdateApplyCommandDeps) and
 *    the supervisor's effects (productionAutoUpdateApplyDeps): no supervisor
 *    starts, no worker is started or probed;
 *  - the one spawn point of installers (runAutoUpdateInstaller), for any
 *    command line that names claude-mem@<version>, however it was built.
 * It is not a setting, so the shipped defaults that tests check are untouched,
 * and it can only refuse, never turn anything on. Tests drive the same code
 * with injected effects instead.
 */
export const FORBID_REAL_AUTO_UPDATE_ENV = 'CLAUDE_MEM_FORBID_REAL_AUTO_UPDATE';

export function assertRealAutoUpdateAllowed(whatWouldStart: string): void {
  const value = process.env[FORBID_REAL_AUTO_UPDATE_ENV];
  if (value === undefined || value === '') return;
  throw new Error(`Refusing to ${whatWouldStart}: ${FORBID_REAL_AUTO_UPDATE_ENV} is set (tests/preload.ts sets it for every test run), so nothing starts a real auto-update`);
}

/** The attempt's own log: the hop's, the supervisor's and every installer run's stdout and stderr. */
export function autoUpdateAttemptLogPath(startedAt: number, logsDirectory: string = paths.logsDir()): string {
  return path.join(logsDirectory, `auto-update-${startedAt}.log`);
}

/** The hop's or the supervisor's argv: `<script> auto-update-apply --target-version ... [--detached-hop]`. */
export function autoUpdateApplyArgv(scriptPath: string, attempt: AutoUpdateApplyAttempt, options: { detachedHop: boolean }): string[] {
  return [
    scriptPath,
    AUTO_UPDATE_APPLY_COMMAND,
    TARGET_VERSION_FLAG, attempt.targetVersion,
    PREVIOUS_VERSION_FLAG, attempt.previousVersion,
    ATTEMPT_STARTED_AT_FLAG, String(attempt.startedAt),
    ...(options.detachedHop ? [DETACHED_HOP_FLAG] : []),
  ];
}

export interface AutoUpdateApplyArguments extends AutoUpdateApplyAttempt {
  detachedHop: boolean;
}

export class AutoUpdateApplyUsageError extends Error {
  constructor(problem: string) {
    super(`${problem}. ${AUTO_UPDATE_APPLY_USAGE}`);
    this.name = 'AutoUpdateApplyUsageError';
  }
}

/**
 * The flags after the command name, read the way the `adopt` command reads
 * its flags (a flag, then its value, which must not be another flag). The
 * versions are checked against the patterns the check uses, because they go
 * on to the installer's command line, through cmd.exe on Windows.
 */
export function parseAutoUpdateApplyArguments(args: readonly string[]): AutoUpdateApplyArguments {
  const values = new Map<string, string>();
  let detachedHop = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === DETACHED_HOP_FLAG) {
      detachedHop = true;
      continue;
    }
    if (argument !== TARGET_VERSION_FLAG && argument !== PREVIOUS_VERSION_FLAG && argument !== ATTEMPT_STARTED_AT_FLAG) {
      throw new AutoUpdateApplyUsageError(`Unknown argument ${JSON.stringify(argument)}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new AutoUpdateApplyUsageError(`${argument} needs a value`);
    if (values.has(argument)) throw new AutoUpdateApplyUsageError(`${argument} is given twice`);
    values.set(argument, value);
    index++;
  }
  const targetVersion = values.get(TARGET_VERSION_FLAG);
  if (targetVersion === undefined || !RELEASE_VERSION_PATTERN.test(targetVersion)) {
    throw new AutoUpdateApplyUsageError(`${TARGET_VERSION_FLAG} must be an exact X.Y.Z release, got ${JSON.stringify(targetVersion ?? null)}`);
  }
  const previousVersion = values.get(PREVIOUS_VERSION_FLAG);
  if (previousVersion === undefined || !INSTALLED_VERSION_PATTERN.test(previousVersion)) {
    throw new AutoUpdateApplyUsageError(`${PREVIOUS_VERSION_FLAG} must be a claude-mem version, got ${JSON.stringify(previousVersion ?? null)}`);
  }
  const startedAtText = values.get(ATTEMPT_STARTED_AT_FLAG);
  const startedAt = startedAtText !== undefined && /^\d+$/.test(startedAtText) ? Number(startedAtText) : Number.NaN;
  if (!Number.isSafeInteger(startedAt)) {
    throw new AutoUpdateApplyUsageError(`${ATTEMPT_STARTED_AT_FLAG} must be the attempt's start in epoch milliseconds, got ${JSON.stringify(startedAtText ?? null)}`);
  }
  return { targetVersion, previousVersion, startedAt, detachedHop };
}

/** A process that started: its pid, and its exit. */
export interface StartedAutoUpdateProcess {
  child: ChildProcess;
  pid: number;
  /** Resolves when it exits. Never rejects. */
  exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

export interface DetachedAutoUpdateProcessOptions {
  logPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** spawn.ts spawnHidden in production. */
  spawnImplementation?: typeof spawnHidden;
}

/**
 * Start a detached, windowless process (the hop, or the supervisor) whose
 * stdout and stderr append to the attempt log. It copies how
 * spawnDetachedWorkerDaemon starts the worker (ProcessManager.ts): spawnHidden
 * with detached: true and the cwd pinned to the data dir (#3706). It is not
 * wrapped in /usr/bin/setsid as the worker daemon is: setsid forks when its
 * caller already leads a process group, which `detached` makes it, so the pid
 * and exit code would be setsid's, and the worker could not read the hop's
 * exit. `detached` already gives the child its own process group.
 *
 * Resolves once the process exists ('spawn'). Rejects when it cannot start:
 * a throw from spawn, or an 'error' event, which Bun and Node emit after spawn
 * has returned (a missing runtime returns no pid, then emits ENOENT). An
 * 'error' after the process started is logged, never left unhandled.
 */
export function startDetachedAutoUpdateProcess(
  command: string,
  args: readonly string[],
  options: DetachedAutoUpdateProcessOptions,
): Promise<StartedAutoUpdateProcess> {
  const spawnImplementation = options.spawnImplementation ?? spawnHidden;
  mkdirSync(path.dirname(options.logPath), { recursive: true });
  const logFd = openSync(options.logPath, 'a');
  let logClosed = false;
  const closeLog = (): void => {
    if (logClosed) return;
    logClosed = true;
    closeSync(logFd);
  };
  return new Promise<StartedAutoUpdateProcess>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnImplementation(command, args, { detached: true, stdio: ['ignore', logFd, logFd], cwd: options.cwd, env: options.env });
    } catch (error: unknown) {
      closeLog();
      reject(new Error(`could not start ${command}: ${errorMessageOf(error)}`, { cause: error }));
      return;
    }
    let started = false;
    const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once('exit', (exitCode, signal) => resolveExit({ exitCode, signal }));
    });
    child.on('error', (error: Error) => {
      closeLog();
      if (!started) {
        reject(new Error(`could not start ${command}: ${error.message}`, { cause: error }));
        return;
      }
      logger.warn('AUTO_UPDATE', 'An auto-update process reported an error after it started', { command, pid: child.pid }, error);
    });
    child.once('spawn', () => {
      started = true;
      closeLog();
      if (child.pid === undefined) {
        reject(new Error(`could not start ${command}: it started without a pid`));
        return;
      }
      resolve({ child, pid: child.pid, exited });
    });
  });
}

// ─── The worker's side ─────────────────────────────────────────────────────

export interface AutoUpdateLaunchDeps {
  now: () => number;
  readState: () => AutoUpdateState;
  writeState: (state: AutoUpdateState) => void;
  /** AUTO_UPDATE_SUPERVISOR_DEADLINE_MS, recorded with the attempt (AutoUpdateInFlightAttempt.supervisorDeadlineMs says why). */
  supervisorDeadlineMs: number;
  /** Start `<runtime> <worker script> auto-update-apply ... --detached-hop` (startDetachedAutoUpdateProcess). */
  startHop: (attempt: AutoUpdateApplyAttempt) => Promise<StartedAutoUpdateProcess>;
  hopExitBudgetMs: number;
  /** Kill a hop that outlived its budget, with its tree (kill-process-tree.ts killProcessTree). */
  killProcessTree: (pid: number) => Promise<void>;
  attemptLogPath: (startedAt: number) => string;
}

/**
 * The worker's launchSupervisor (auto-update-check.ts gate 9). Writes the
 * attempt in flight with no supervisor yet and the deadline it may run for,
 * starts the hop and waits for it to exit 0. Throws on anything else, which
 * gate 9 records as launch-failed without blocking the version.
 */
export async function launchAutoUpdateSupervisor(
  versions: { targetVersion: string; previousVersion: string },
  deps: AutoUpdateLaunchDeps,
): Promise<void> {
  const attempt: AutoUpdateApplyAttempt = { ...versions, startedAt: deps.now() };
  const state = deps.readState();
  state.inFlightAttempt = {
    targetVersion: attempt.targetVersion,
    previousVersion: attempt.previousVersion,
    startedAt: attempt.startedAt,
    supervisorPid: null,
    supervisorDeadlineMs: deps.supervisorDeadlineMs,
  };
  deps.writeState(state);

  const logPath = deps.attemptLogPath(attempt.startedAt);
  const hop = await deps.startHop(attempt);
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const outlivedBudget = new Promise<'outlived-budget'>((resolveTimeout) => {
    budgetTimer = setTimeout(() => resolveTimeout('outlived-budget'), deps.hopExitBudgetMs);
  });
  const hopEnded = await Promise.race([hop.exited, outlivedBudget]);
  clearTimeout(budgetTimer);
  if (hopEnded === 'outlived-budget') {
    const budgetSeconds = Math.round(deps.hopExitBudgetMs / MILLISECONDS_PER_SECOND);
    try {
      await deps.killProcessTree(hop.pid);
    } catch (error: unknown) {
      logger.error('AUTO_UPDATE', 'Could not kill an auto-update hop that outlived its budget', { hopPid: hop.pid, logPath },
        error instanceof Error ? error : new Error(String(error)));
      throw new Error(`the auto-update hop (pid ${hop.pid}) did not exit within ${budgetSeconds} s, and killing it failed (${errorMessageOf(error)}), so it may still be running; see ${logPath}`, { cause: error });
    }
    throw new Error(`the auto-update hop (pid ${hop.pid}) did not exit within ${budgetSeconds} s, so it was killed; see ${logPath}`);
  }
  if (hopEnded.exitCode !== EXIT_SUCCESS) {
    const ending = hopEnded.exitCode === null ? `was ended by ${hopEnded.signal ?? 'an unknown signal'}` : `exited with code ${hopEnded.exitCode}`;
    throw new Error(`the auto-update hop (pid ${hop.pid}) ${ending} before the supervisor was started; see ${logPath}`);
  }
  logger.info('AUTO_UPDATE', `Auto-update supervisor launched: ${attempt.previousVersion} → ${attempt.targetVersion}`, {
    targetVersion: attempt.targetVersion,
    previousVersion: attempt.previousVersion,
    attemptStartedAt: new Date(attempt.startedAt).toISOString(),
    hopPid: hop.pid,
    logPath,
  });
}

/** The worker's production launcher effects. Refuses under FORBID_REAL_AUTO_UPDATE_ENV. */
export function productionAutoUpdateLaunchDeps(options: { scriptPath: string }): AutoUpdateLaunchDeps {
  assertRealAutoUpdateAllowed('launch an auto-update supervisor');
  return autoUpdateLaunchDeps(options);
}

/**
 * The launcher effects for a worker script: the state file in DATA_DIR, the
 * hop started as `<runtime> <scriptPath> auto-update-apply ... --detached-hop`,
 * and its output in the attempt log. productionAutoUpdateLaunchDeps returns
 * exactly these behind the tripwire; the integration test drives them with
 * its stand-in script and a scratch CLAUDE_MEM_DATA_DIR, so a launcher that
 * stopped going through the detached hop fails it. Without the tripwire check
 * this starts only the script it is given; a real worker script started under
 * the tripwire still refuses as the hop (productionAutoUpdateApplyCommandDeps).
 */
export function autoUpdateLaunchDeps(options: { scriptPath: string }): AutoUpdateLaunchDeps {
  return {
    now: Date.now,
    readState: () => readAutoUpdateState(),
    writeState: (state) => writeAutoUpdateState(state),
    supervisorDeadlineMs: AUTO_UPDATE_SUPERVISOR_DEADLINE_MS,
    startHop: (attempt) => startDetachedAutoUpdateProcess(
      process.execPath,
      autoUpdateApplyArgv(options.scriptPath, attempt, { detachedHop: true }),
      { logPath: autoUpdateAttemptLogPath(attempt.startedAt), env: sanitizeEnv(process.env), cwd: daemonWorkingDirectory() },
    ),
    hopExitBudgetMs: AUTO_UPDATE_HOP_EXIT_BUDGET_MS,
    // 'immediate': the hop is this release's own code with nothing to clean up.
    killProcessTree: (pid) => killProcessTree(pid, { signalMode: 'immediate' }),
    attemptLogPath: (startedAt) => autoUpdateAttemptLogPath(startedAt),
  };
}

// ─── The hop and the supervisor ────────────────────────────────────────────

export interface AutoUpdateApplyCommandDeps {
  /** Start `<runtime> <worker script> auto-update-apply ...` without the hop flag (startDetachedAutoUpdateProcess). */
  startSupervisor: (attempt: AutoUpdateApplyAttempt) => Promise<StartedAutoUpdateProcess>;
  /** The supervisor's effects, built only when this process is the supervisor. */
  buildApplyDeps: (attempt: AutoUpdateApplyAttempt) => AutoUpdateApplyDeps;
  /** Flush queued telemetry before the supervisor exits (telemetry.ts shutdownTelemetry, which never rejects). */
  flushTelemetry: () => Promise<void>;
}

/** The `auto-update-apply` subcommand, as the hop or as the supervisor. Returns the exit code; never throws. */
export async function runAutoUpdateApplyCommand(args: readonly string[], deps: AutoUpdateApplyCommandDeps): Promise<number> {
  let parsed: AutoUpdateApplyArguments;
  try {
    parsed = parseAutoUpdateApplyArguments(args);
  } catch (error: unknown) {
    logger.error('AUTO_UPDATE', `${AUTO_UPDATE_APPLY_COMMAND} was started with arguments it cannot use`, { args: args.join(' ') },
      error instanceof Error ? error : new Error(String(error)));
    return EXIT_FAILURE;
  }
  const attempt: AutoUpdateApplyAttempt = {
    targetVersion: parsed.targetVersion,
    previousVersion: parsed.previousVersion,
    startedAt: parsed.startedAt,
  };
  return parsed.detachedHop ? runDetachedHop(attempt, deps) : runSupervisor(attempt, deps);
}

/** The hop: start the supervisor and exit as soon as it exists. */
async function runDetachedHop(attempt: AutoUpdateApplyAttempt, deps: AutoUpdateApplyCommandDeps): Promise<number> {
  let supervisor: StartedAutoUpdateProcess;
  try {
    supervisor = await deps.startSupervisor(attempt);
  } catch (error: unknown) {
    logger.error('AUTO_UPDATE', 'Auto-update hop could not start the supervisor', {
      targetVersion: attempt.targetVersion,
      previousVersion: attempt.previousVersion,
    }, error instanceof Error ? error : new Error(String(error)));
    return EXIT_FAILURE;
  }
  supervisor.child.unref();
  logger.info('AUTO_UPDATE', 'Auto-update hop started the supervisor and exits', {
    targetVersion: attempt.targetVersion,
    previousVersion: attempt.previousVersion,
    hopPid: process.pid,
    supervisorPid: supervisor.pid,
  });
  return EXIT_SUCCESS;
}

async function runSupervisor(attempt: AutoUpdateApplyAttempt, deps: AutoUpdateApplyCommandDeps): Promise<number> {
  try {
    const result = await applyAutoUpdate(attempt, deps.buildApplyDeps(attempt));
    return result.kind === 'finished' ? EXIT_SUCCESS : EXIT_FAILURE;
  } catch (error: unknown) {
    // applyAutoUpdate logged what it could not record; this names the exit.
    logger.error('AUTO_UPDATE', 'Auto-update supervisor exits without a recorded outcome', {
      targetVersion: attempt.targetVersion,
      previousVersion: attempt.previousVersion,
    }, error instanceof Error ? error : new Error(String(error)));
    return EXIT_FAILURE;
  } finally {
    await deps.flushTelemetry();
  }
}

/**
 * The worker-service.ts dispatcher's `auto-update-apply` case: production
 * effects, every failure turned into an exit code. The dispatcher's own catch
 * exits 0 for any command but the daemon, which would tell the worker that a
 * hop that failed had started the supervisor.
 */
export async function runAutoUpdateApplyCli(args: readonly string[], options: { scriptPath: string; port: number }): Promise<number> {
  let deps: AutoUpdateApplyCommandDeps;
  try {
    deps = productionAutoUpdateApplyCommandDeps(options);
  } catch (error: unknown) {
    logger.error('AUTO_UPDATE', `${AUTO_UPDATE_APPLY_COMMAND} refused to start`, { args: args.join(' ') },
      error instanceof Error ? error : new Error(String(error)));
    return EXIT_FAILURE;
  }
  return runAutoUpdateApplyCommand(args, deps);
}

/** The hop's and the supervisor's production effects. Refuses under FORBID_REAL_AUTO_UPDATE_ENV. */
export function productionAutoUpdateApplyCommandDeps(options: { scriptPath: string; port: number }): AutoUpdateApplyCommandDeps {
  assertRealAutoUpdateAllowed('run the auto-update hop or supervisor');
  return {
    startSupervisor: (attempt) => startDetachedAutoUpdateProcess(
      process.execPath,
      autoUpdateApplyArgv(options.scriptPath, attempt, { detachedHop: false }),
      { logPath: autoUpdateAttemptLogPath(attempt.startedAt), env: sanitizeEnv(process.env), cwd: daemonWorkingDirectory() },
    ),
    buildApplyDeps: (attempt) => productionAutoUpdateApplyDeps({ port: options.port, logPath: autoUpdateAttemptLogPath(attempt.startedAt) }),
    flushTelemetry: () => shutdownTelemetry(),
  };
}

/** The supervisor's production effects (AutoUpdateApplyDeps). Refuses under FORBID_REAL_AUTO_UPDATE_ENV. */
export function productionAutoUpdateApplyDeps(options: { port: number; logPath: string }): AutoUpdateApplyDeps {
  assertRealAutoUpdateAllowed('build the auto-update supervisor\'s effects');
  const { port, logPath } = options;
  return {
    now: Date.now,
    readState: () => readAutoUpdateState(),
    writeState: (state) => writeAutoUpdateState(state),
    processId: process.pid,
    getCurrentWorkerPid: () => getCurrentWorkerPid(port, WORKER_PID_CAPTURE_TIMEOUT_MS),
    runInstaller: async (version) => {
      const invocation = claudeMemUpdateInvocation(version);
      if (invocation.kind === 'npx-not-found') return invocation;
      return runAutoUpdateInstaller(invocation.invocation, { logPath, deadlineMs: AUTO_UPDATE_INSTALLER_DEADLINE_MS });
    },
    proveWorkerOnVersion: autoUpdateWorkerProof(port),
    readInstallVersions: () => readInstallVersions(),
    readDatabaseSchemaStamp: () => readDatabaseSchemaStamp(),
    supervisorSchemaVersion: LATEST_SCHEMA_VERSION,
    pluginCacheDirectory,
    stampOrphaned: writeOrphanedMarker,
    readRunningWorker: () => readRunningWorker(port),
    ensureWorkerStarted: () => ensureWorkerStartedFromResolvedScript(port),
    readNpmPublication: (version) => readNpmPublication({ fetchJson: fetchJsonWithTimeout }, version),
    captureEvent: (event, properties) => captureEvent(event, properties),
  };
}

/**
 * Gate 3's readInterruptedAttemptInstall (auto-update-check.ts) for the
 * worker that runs the check: the supervisor's own readers on the real
 * install, which only read. Gate 3 names the fix itself, the target's own
 * installer (auto-update-state-file.ts interruptedAttemptFix), so nothing
 * here reads the database or npm.
 */
export function workerInterruptedAttemptReader(): (attempt: { targetVersion: string; previousVersion: string }) => Promise<InterruptedAttemptInstall> {
  return (attempt) => readInterruptedAttemptInstall(attempt, { readInstallVersions: () => readInstallVersions() });
}

/**
 * The supervisor's proof that a worker finished starting
 * (productionAutoUpdateApplyDeps.proveWorkerOnVersion): restart-verify.ts
 * verifyWorkerFinishedStarting on this install's port, which needs the
 * worker's own `ready` on GET /api/ready, stops at once on its `failed`, and
 * waits while it is still starting, up to the startup ceiling
 * (AUTO_UPDATE_WORKER_STARTUP_CEILING_MS explains it). A worker that only
 * answers with its pid and version, as a failed or hung startup still does on
 * /api/health, proves nothing.
 */
export function autoUpdateWorkerProof(
  port: number,
  ceilingMs: number = AUTO_UPDATE_WORKER_STARTUP_CEILING_MS,
): AutoUpdateApplyDeps['proveWorkerOnVersion'] {
  return async (oldPid, version): Promise<AutoUpdateWorkerProof> => {
    const proof = await verifyWorkerFinishedStarting(port, oldPid, version, ceilingMs);
    if (proof.ok) return { ok: true, pid: proof.pid };
    return proof.startupFailed
      ? { ok: false, startupFailed: true, detail: `pid ${proof.pid}: ${proof.message}` }
      : { ok: false, startupFailed: false, detail: `${Math.round(ceilingMs / MILLISECONDS_PER_SECOND)} s, ${proof.lastObserved}` };
  };
}

/**
 * The production readInstallVersions: the places the install's version is
 * recorded, read with the readers that own them. The resolver
 * (worker-utils.ts resolvePluginRoot, the version oracle every launcher
 * uses); the registration the npx installer writes in installed_plugins.json
 * (prune-cache.ts readUserScopeRegisteredCacheVersions, whose readJsonSafe
 * throws on a file that does not parse); the marketplace copy's package.json
 * and plugin manifest (worker-utils.ts readPackageVersion, the resolver's own
 * read of package.json) and whether its worker script is there.
 * `searchRoots` and `installedPluginsFile` default to the real install; tests
 * point them at a scratch layout.
 */
export function readInstallVersions(
  options: { searchRoots?: WorkerScriptSearchRoots; installedPluginsFile?: string } = {},
): InstallVersionsRead {
  const marketplaceRoot = options.searchRoots?.marketplaceRoot ?? marketplaceDirectory();
  let registered: InstallVersionsRead['registered'];
  try {
    registered = { kind: 'read', versions: readUserScopeRegisteredCacheVersions(options.installedPluginsFile ?? installedPluginsPath()) };
  } catch (error: unknown) {
    registered = { kind: 'unreadable', message: errorMessageOf(error) };
  }
  return {
    resolved: resolvePluginRoot(options.searchRoots)?.version ?? null,
    registered,
    marketplace: {
      packageVersion: readPackageVersion(path.join(marketplaceRoot, 'package.json')),
      pluginManifestVersion: readPackageVersion(path.join(marketplaceRoot, 'plugin', '.claude-plugin', 'plugin.json')),
      hasWorkerScript: existsSync(path.join(marketplaceRoot, 'plugin', 'scripts', 'worker-service.cjs')),
    },
  };
}

/**
 * The production readRunningWorker: a worker answering GET /api/health on
 * the install's port (restart-verify.ts getCurrentWorkerPid, with the pid
 * read's own budget), else the PID file's worker when it is a live claude-mem
 * worker meant for this port (process-registry.ts readOwnedWorkerPidInfo, the
 * port compared the way install.ts readOwnedWorkerOnPort compares it). The
 * worker writes its PID file once it has bound its port, before its database
 * opens, so a worker that is migrating has one while it answers nothing.
 */
export async function readRunningWorker(
  port: number,
  readers: { getCurrentWorkerPid?: typeof getCurrentWorkerPid; readOwnedWorker?: () => PidInfo | null } = {},
): Promise<RunningWorkerRead> {
  const answeringPid = await (readers.getCurrentWorkerPid ?? getCurrentWorkerPid)(port, WORKER_PID_CAPTURE_TIMEOUT_MS);
  if (answeringPid !== null) return { kind: 'answering', pid: answeringPid };
  const owner = (readers.readOwnedWorker ?? readOwnedWorkerPidInfo)();
  if (owner !== null && (!owner.port || Number(owner.port) === port)) return { kind: 'alive-not-answering', pid: owner.pid };
  return { kind: 'none' };
}

/**
 * The database's schema stamp (PRAGMA user_version), read without writing to
 * it: connection.ts openReaderDatabase, the opener for readers that must never
 * write (its fallback creates only the -wal and -shm a read-only handle
 * needs), then readSchemaWriterStamp, which every guard reads. No database
 * file means nothing to refuse.
 */
export function readDatabaseSchemaStamp(databasePath: string = DB_PATH): DatabaseSchemaStampRead {
  if (!existsSync(databasePath)) return { kind: 'no-database' };
  let database: ReturnType<typeof openReaderDatabase>;
  try {
    database = openReaderDatabase(databasePath);
  } catch (error: unknown) {
    return { kind: 'unreadable', message: `${databasePath}: ${errorMessageOf(error)}` };
  }
  try {
    return { kind: 'stamped', schemaVersion: readSchemaWriterStamp(database) };
  } catch (error: unknown) {
    return { kind: 'unreadable', message: `${databasePath}: ${errorMessageOf(error)}` };
  } finally {
    try {
      database.close();
    } catch (error: unknown) {
      // The stamp is already read; a handle that will not close only costs this short-lived process a descriptor.
      logger.warn('AUTO_UPDATE', 'Could not close the read-only handle used to read the schema stamp', { databasePath },
        error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** ensureWorkerStarted with the worker script the install resolves to now. */
async function ensureWorkerStartedFromResolvedScript(port: number): Promise<WorkerStartResult> {
  const scriptPath = resolveWorkerScriptPath();
  if (scriptPath === null) {
    logger.error('AUTO_UPDATE', 'No worker script resolves, so no worker can be started', { port });
    return 'dead';
  }
  return ensureWorkerStarted(port, scriptPath);
}

// ─── The installer ─────────────────────────────────────────────────────────

export type ClaudeMemUpdateInvocation =
  | { kind: 'ready'; invocation: CommandInvocation }
  | { kind: 'npx-not-found'; message: string };

/**
 * `npx --yes claude-mem@<version> update`: the command users run, with no
 * other flag. `--yes` answers npx's own "Ok to proceed?" for a package it has
 * not cached; the installer's non-interactive path keeps the user's saved
 * provider, and any added flag could change it. On Windows npx is a .cmd
 * shim, which only cmd.exe can start (spawn.ts commandInvocation), found the
 * way the other installers find theirs (lookupWindowsCommand, which drops a
 * match in the current directory). When it finds none the run fails as
 * npx-not-found: a bare `npx.cmd` would let cmd.exe search its working
 * directory before PATH.
 */
export function claudeMemUpdateInvocation(
  version: string,
  platform: NodeJS.Platform = process.platform,
  findWindowsCommand: (command: string) => string | null = lookupWindowsCommand,
): ClaudeMemUpdateInvocation {
  if (!INSTALLED_VERSION_PATTERN.test(version)) {
    throw new Error(`Refusing to build an installer command for ${JSON.stringify(version)}: not a claude-mem version`);
  }
  let npx = 'npx';
  if (platform === 'win32') {
    const found = findWindowsCommand('npx');
    if (found === null) return { kind: 'npx-not-found', message: 'npx was not found on PATH' };
    npx = found;
  }
  return { kind: 'ready', invocation: commandInvocation(npx, ['--yes', `claude-mem@${version}`, 'update'], platform) };
}

/**
 * Where the supervisor's installer run (claudeMemUpdateInvocation) would find
 * npx, or null when it would find none, for the worker's check before it turns
 * off Claude Code's background update (auto-update-check.ts
 * settleClaudeCodeBackgroundUpdate). On Windows it is the supervisor's own
 * lookup. Elsewhere the supervisor starts the bare name `npx`, which spawn
 * finds on PATH, so Bun.which looks it up on the same PATH. The supervisor's
 * environment is the worker's process.env through sanitizeEnv, which keeps
 * PATH (env-sanitizer.ts), so that PATH is the one read, passed to Bun.which
 * explicitly: on its own, Bun.which reads the PATH the process started with,
 * not a later value of process.env.PATH.
 */
export function findNpxForTheInstaller(
  platform: NodeJS.Platform = process.platform,
  findWindowsCommand: (command: string) => string | null = lookupWindowsCommand,
  findOnPath: (command: string) => string | null = (command) => Bun.which(command, { PATH: process.env.PATH }),
): string | null {
  return platform === 'win32' ? findWindowsCommand('npx') : findOnPath('npx');
}

/**
 * The working directory of every installer run, the target's and the
 * previous version's (runAutoUpdateInstaller): the root of the filesystem,
 * `/`, and on Windows the root of the drive Windows is installed on (C:\),
 * from the folder spawn.ts windowsSystemRootDirectory names.
 *
 * npx runs what the npm project around its working directory provides. That
 * project is the first folder, from the working directory up to the root,
 * that holds a package.json or a node_modules folder (npm's local prefix,
 * @npmcli/config loadLocalPrefix). npx loads its tree, the project's own
 * package included, and when anything in it is claude-mem at the version
 * asked for, it downloads nothing and runs that tree's `claude-mem` bin
 * (libnpmexec missingFromTree; read in npm 11.14). It also reads the
 * project's .npmrc. The supervisor's own working directory is the data dir
 * (daemonWorkingDirectory): one inside a claude-mem source checkout made every
 * update exit 127, because a checkout links no `claude-mem` bin for its own
 * package, and a node_modules holding claude-mem would run that copy instead
 * of the published one.
 *
 * From a root npm checks only the root, and the root is on the way up from
 * every other folder on its drive, so no working directory is checked in
 * fewer places. Only the superuser can write to `/`, and only administrators
 * can create a file at the root of C:\ (any user can create a folder there, a
 * node_modules among them, but the data dir and the home folder reach it on
 * their way up too). The home folder is not used: it can hold a package.json
 * or a node_modules itself. The installer reads nothing from its working
 * directory; it starts npm and the worker in folders it names
 * (npm-install-helper.ts runNpmStrict, setup-runtime.ts,
 * ProcessManager.ts daemonWorkingDirectory).
 *
 * Throws when SystemRoot is not an absolute path: a relative one names no
 * root, and would leave cmd.exe in a folder relative to the supervisor's.
 */
export function autoUpdateInstallerWorkingDirectory(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== 'win32') return path.posix.sep;
  const systemRoot = windowsSystemRootDirectory(env);
  if (!path.win32.isAbsolute(systemRoot)) {
    throw new Error(`Refusing to run the installer: SystemRoot ${JSON.stringify(systemRoot)} is not an absolute path, so it names no drive root to run the installer from`);
  }
  return path.win32.parse(systemRoot).root;
}

/** True for any command line that runs a claude-mem package, however it was built: what FORBID_REAL_AUTO_UPDATE_ENV refuses. */
function invocationRunsClaudeMem(invocation: CommandInvocation): boolean {
  return [invocation.command, ...invocation.args].some((part) => part.includes('claude-mem@'));
}

export interface AutoUpdateInstallerOptions {
  logPath: string;
  deadlineMs: number;
  /** Kill the installer's tree at the deadline (kill-process-tree.ts killProcessTree). */
  killProcessTree?: (pid: number) => Promise<void>;
  /** How long to wait for the installer's own exit after that kill (INSTALLER_EXIT_AFTER_KILL_WAIT_MS gives the reason). */
  exitAfterKillWaitMs?: number;
  /** spawn.ts spawnHidden in production. */
  spawnImplementation?: typeof spawnHidden;
}

/**
 * Run one installer and settle with how it ended. The installer is the
 * supervisor's own child (not detached), so the tree-kill at the deadline
 * reaches everything it started. Its stdin is 'ignore', which makes the
 * installer take its non-interactive path (install.ts isInteractive is
 * `process.stdin.isTTY === true`); stdout and stderr append to the attempt
 * log; its environment is the supervisor's (which the hop passed through
 * sanitizeEnv) plus INSTALL_RUN_BY_AUTO_UPDATE_ENV, which marks the run as
 * the auto-updater's (shared/auto-update-install-run.ts). Its working
 * directory is autoUpdateInstallerWorkingDirectory, outside every npm
 * project, never the supervisor's own (the data dir).
 *
 * At the deadline its tree is killed, and then the installer's own exit is
 * awaited for exitAfterKillWaitMs. One still running then is reported as
 * installerStillRunning, and the supervisor starts no other installer while
 * it may run (auto-update-apply.ts). A kill that threw is reported as failed,
 * never as killed.
 *
 * Rejects only before anything is started: when FORBID_REAL_AUTO_UPDATE_ENV
 * refuses a claude-mem installer, when autoUpdateInstallerWorkingDirectory
 * names no directory, or when the attempt log cannot be created or opened.
 * Once the promise exists it always settles with how the run ended.
 */
export async function runAutoUpdateInstaller(invocation: CommandInvocation, options: AutoUpdateInstallerOptions): Promise<AutoUpdateInstallerRun> {
  const commandLine = [invocation.command, ...invocation.args].join(' ');
  if (invocationRunsClaudeMem(invocation)) assertRealAutoUpdateAllowed(`run the real installer (${commandLine})`);
  const workingDirectory = autoUpdateInstallerWorkingDirectory();
  const spawnImplementation = options.spawnImplementation ?? spawnHidden;
  const killTree = options.killProcessTree ?? ((pid: number) => killProcessTree(pid));
  const exitAfterKillWaitMs = options.exitAfterKillWaitMs ?? INSTALLER_EXIT_AFTER_KILL_WAIT_MS;
  const deadlineSeconds = Math.round(options.deadlineMs / MILLISECONDS_PER_SECOND);
  mkdirSync(path.dirname(options.logPath), { recursive: true });
  appendFileSync(options.logPath, `\n[auto-update ${new Date().toISOString()}] running: ${commandLine} in ${workingDirectory} (deadline ${deadlineSeconds} s)\n`);
  const appendToLog = (line: string): void => {
    try {
      appendFileSync(options.logPath, `[auto-update ${new Date().toISOString()}] ${line}\n`);
    } catch (error: unknown) {
      logger.warn('AUTO_UPDATE', 'Could not append to the auto-update attempt log', { logPath: options.logPath, line },
        error instanceof Error ? error : new Error(String(error)));
    }
  };
  const logFd = openSync(options.logPath, 'a');
  let logClosed = false;
  const closeLog = (): void => {
    if (logClosed) return;
    logClosed = true;
    try {
      closeSync(logFd);
    } catch (error: unknown) {
      // The child holds its own copy of the descriptor; only this process's copy leaks.
      logger.warn('AUTO_UPDATE', 'Could not close the supervisor\'s handle on the attempt log', { logPath: options.logPath },
        error instanceof Error ? error : new Error(String(error)));
    }
  };

  return new Promise<AutoUpdateInstallerRun>((resolve) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    // Resolves first, so nothing after it can leave the run unsettled; the
    // log calls after it never throw.
    const settle = (run: AutoUpdateInstallerRun, logLine: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      resolve(run);
      closeLog();
      appendToLog(logLine);
    };

    let child: ChildProcess;
    try {
      child = spawnImplementation(invocation.command, invocation.args, {
        cwd: workingDirectory,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, [INSTALL_RUN_BY_AUTO_UPDATE_ENV]: INSTALL_RUN_BY_AUTO_UPDATE_VALUE },
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
    } catch (error: unknown) {
      settle({ kind: 'spawn-failed', message: errorMessageOf(error) }, `could not start the installer: ${errorMessageOf(error)}`);
      return;
    }

    let started = false;
    // Set the moment the deadline passes, so the exit the tree-kill causes is
    // never mistaken for the installer ending on its own.
    let deadlinePassed = false;
    let childExited = false;
    const childExit = new Promise<void>((resolveExit) => {
      child.once('exit', () => {
        childExited = true;
        resolveExit();
      });
    });
    child.once('spawn', () => {
      started = true;
      closeLog();
    });
    child.on('error', (error: Error) => {
      if (!started) {
        settle({ kind: 'spawn-failed', message: error.message }, `could not start the installer: ${error.message}`);
        return;
      }
      logger.warn('AUTO_UPDATE', 'The auto-update installer reported an error after it started', { commandLine, pid: child.pid }, error);
    });
    child.once('exit', (exitCode, signal) => {
      if (deadlinePassed) return;
      settle({ kind: 'exited', exitCode, signal }, `installer exited (code ${exitCode ?? 'none'}, signal ${signal ?? 'none'})`);
    });

    const killAtDeadline = async (): Promise<void> => {
      const installerPid = child.pid ?? null;
      let killError: string | null = null;
      if (installerPid !== null) {
        try {
          await killTree(installerPid);
        } catch (error: unknown) {
          killError = errorMessageOf(error);
          logger.error('AUTO_UPDATE', 'Could not kill the auto-update installer at its deadline', { commandLine, pid: installerPid },
            error instanceof Error ? error : new Error(String(error)));
        }
      }
      const exitedAfterKill = childExited || await settlesWithin(childExit, exitAfterKillWaitMs);
      const installerStillRunning = installerPid !== null && !exitedAfterKill;
      if (installerStillRunning) {
        logger.error('AUTO_UPDATE', 'The auto-update installer was still running after its process tree was killed', {
          commandLine, pid: installerPid, killError, waitedMs: exitAfterKillWaitMs,
        });
      }
      const killNote = killError === null ? 'its process tree was killed' : `killing its process tree failed: ${killError}`;
      settle({ kind: 'timed-out', deadlineMs: options.deadlineMs, killError, installerPid, installerStillRunning },
        `installer ran past its ${deadlineSeconds} s deadline; ${killNote}; ${installerStillRunning ? `pid ${installerPid} was still running ${exitAfterKillWaitMs} ms later` : 'it exited'}`);
    };
    deadlineTimer = setTimeout(() => {
      if (settled) return;
      deadlinePassed = true;
      killAtDeadline().catch((error: unknown) => {
        // Not expected: every step above handles its own failure. The run
        // still settles, as possibly running, so no second installer starts.
        logger.error('AUTO_UPDATE', 'The auto-update installer\'s deadline handling failed', { commandLine, pid: child.pid },
          error instanceof Error ? error : new Error(String(error)));
        settle({ kind: 'timed-out', deadlineMs: options.deadlineMs, killError: errorMessageOf(error), installerPid: child.pid ?? null, installerStillRunning: child.pid !== undefined && !childExited },
          `installer ran past its ${deadlineSeconds} s deadline; its deadline handling failed: ${errorMessageOf(error)}`);
      });
    }, options.deadlineMs);
  });
}

/** Whether `promise` settles within `timeoutMs`; the timer never outlives the answer. */
async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs);
  });
  try {
    return await Promise.race([promise.then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
