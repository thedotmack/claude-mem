/**
 * How an auto-update leaves the worker and reaches the installer, and the
 * production effects of the supervisor (auto-update-apply.ts).
 *
 *   worker ─spawn, detached─▶ hop ─spawn, detached─▶ supervisor ─spawn─▶ npx --yes --no-workspaces --package=claude-mem@<version> claude-mem update
 *
 *  1. The worker (launchAutoUpdateSupervisor) writes the attempt in flight,
 *     starts `<its runtime> <its own worker script> auto-update-apply ...
 *     --detached-hop` and waits for that hop to exit, within
 *     AUTO_UPDATE_HOP_EXIT_BUDGET_MS.
 *  2. The hop (runAutoUpdateApplyCommand with --detached-hop) starts the same
 *     runtime and script again without the flag, and exits as soon as that
 *     process exists. Exit 0 tells the worker the supervisor was started;
 *     anything else is a launch failure, which the check handles without
 *     blocking the version (auto-update-check.ts gate 9). Once a hop process
 *     was started, it only logs the failure and writes nothing, leaving the
 *     attempt in flight for its gate 3, since the supervisor may be running
 *     and claiming it; it clears the attempt only when none was
 *     (AutoUpdateLaunchError).
 *  3. Once the hop has exited, the supervisor has no parent in the worker's
 *     tree (the OS reparents it), so a recycle tree-kill, which walks the
 *     worker's descendants (kill-process-tree.ts), cannot reach it while the
 *     installer stops and restarts the worker (#3793).
 *  4. The supervisor (applyAutoUpdate) runs the installer as its own child,
 *     so it can tree-kill it at the deadline, from a new folder of its own in
 *     the data dir, made for that run, whose package.json makes it npx's npm
 *     project (makeAutoUpdateInstallerRunFolder).
 *
 * The hop and the supervisor run the worker script the worker was started
 * with, which belongs to the version being replaced, so the supervisor runs
 * known-good code, never the incoming release.
 *
 * FORBID_REAL_AUTO_UPDATE_ENV keeps every test from starting any of this for
 * real; see its comment.
 */

import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import type { ChildProcess } from 'child_process';
import { installedPluginsPath, marketplaceDirectory, pluginCacheDirectory } from '../../npx-cli/utils/paths.js';
import { readUserScopeRegisteredCacheVersions } from '../../npx-cli/utils/prune-cache.js';
import { INSTALL_RUN_BY_AUTO_UPDATE_ENV, INSTALL_RUN_BY_AUTO_UPDATE_VALUE } from '../../shared/auto-update-install-run.js';
import { killProcessTree } from '../../shared/kill-process-tree.js';
import { DB_PATH, paths } from '../../shared/paths.js';
import { commandInvocation, lookupWindowsCommand, spawnHidden, type CommandInvocation } from '../../shared/spawn.js';
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
import { AutoUpdateLaunchError, fetchJsonWithTimeout, INSTALLED_VERSION_PATTERN, NPM_PUBLIC_REGISTRY_URL, readNpmPublication, RELEASE_VERSION_PATTERN } from './auto-update-check.js';
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
 * Resolves once the process exists ('spawn'). Rejects with an
 * AutoUpdateLaunchError that says whether a process was started: none when
 * the attempt log cannot be opened, spawn throws, or an 'error' event comes
 * before 'spawn', which Bun and Node emit after spawn has returned (a missing
 * runtime returns no pid, then emits ENOENT); maybe one when 'spawn' comes
 * without a pid, which leaves nothing to wait on or kill. An 'error' after the
 * process started is logged, never left unhandled.
 */
export function startDetachedAutoUpdateProcess(
  command: string,
  args: readonly string[],
  options: DetachedAutoUpdateProcessOptions,
): Promise<StartedAutoUpdateProcess> {
  const spawnImplementation = options.spawnImplementation ?? spawnHidden;
  let logFd: number;
  try {
    mkdirSync(path.dirname(options.logPath), { recursive: true });
    logFd = openSync(options.logPath, 'a');
  } catch (error: unknown) {
    return Promise.reject(new AutoUpdateLaunchError(`could not start ${command}: its log ${options.logPath} could not be opened: ${errorMessageOf(error)}`, false, { cause: error }));
  }
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
      reject(new AutoUpdateLaunchError(`could not start ${command}: ${errorMessageOf(error)}`, false, { cause: error }));
      return;
    }
    let started = false;
    const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once('exit', (exitCode, signal) => resolveExit({ exitCode, signal }));
    });
    child.on('error', (error: Error) => {
      closeLog();
      if (!started) {
        reject(new AutoUpdateLaunchError(`could not start ${command}: ${error.message}`, false, { cause: error }));
        return;
      }
      logger.warn('AUTO_UPDATE', 'An auto-update process reported an error after it started', { command, pid: child.pid }, error);
    });
    child.once('spawn', () => {
      started = true;
      closeLog();
      if (child.pid === undefined) {
        reject(new AutoUpdateLaunchError(`could not start ${command}: it started without a pid`, true));
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
 * gate 9 handles without blocking the version. From the hop's start on, every
 * failure is an AutoUpdateLaunchError saying whether a process was started:
 * only a start that startDetachedAutoUpdateProcess reports as never begun
 * started none, and gate 9 then clears the attempt. A hop that outlived its
 * budget, ended with anything but 0, or failed to start in another way may
 * have started the supervisor, so gate 9 writes nothing and leaves the attempt
 * in flight for its gate 3. A throw before the hop's start (reading or writing
 * the state) started nothing and is passed on as it is.
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
  let hop: StartedAutoUpdateProcess;
  try {
    hop = await deps.startHop(attempt);
  } catch (error: unknown) {
    if (error instanceof AutoUpdateLaunchError) throw error;
    throw new AutoUpdateLaunchError(`starting the auto-update hop failed (${errorMessageOf(error)}), and nothing shows that no process was started; see ${logPath}`, true, { cause: error });
  }
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
      throw new AutoUpdateLaunchError(`the auto-update hop (pid ${hop.pid}) did not exit within ${budgetSeconds} s, and killing it failed (${errorMessageOf(error)}), so it may still be running; see ${logPath}`, true, { cause: error });
    }
    // The hop may have started the supervisor first. The kill walks the
    // descendants it reads at that moment (kill-process-tree.ts), so a
    // supervisor started after that read, or left without a parent by a hop
    // that exited just as its budget ran out, can survive it.
    throw new AutoUpdateLaunchError(`the auto-update hop (pid ${hop.pid}) did not exit within ${budgetSeconds} s, so it was killed; see ${logPath}`, true);
  }
  if (hopEnded.exitCode !== EXIT_SUCCESS) {
    const ending = hopEnded.exitCode === null ? `was ended by ${hopEnded.signal ?? 'an unknown signal'}` : `exited with code ${hopEnded.exitCode}`;
    throw new AutoUpdateLaunchError(`the auto-update hop (pid ${hop.pid}) ${ending} before the supervisor was started; see ${logPath}`, true);
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
    buildApplyDeps: (attempt) => productionAutoUpdateApplyDeps({
      port: options.port,
      logPath: autoUpdateAttemptLogPath(attempt.startedAt),
      attemptStartedAt: attempt.startedAt,
    }),
    flushTelemetry: () => shutdownTelemetry(),
  };
}

/** The supervisor's production effects (AutoUpdateApplyDeps). Refuses under FORBID_REAL_AUTO_UPDATE_ENV. */
export function productionAutoUpdateApplyDeps(options: { port: number; logPath: string; attemptStartedAt: number }): AutoUpdateApplyDeps {
  assertRealAutoUpdateAllowed('build the auto-update supervisor\'s effects');
  const { port, logPath, attemptStartedAt } = options;
  return {
    now: Date.now,
    readState: () => readAutoUpdateState(),
    writeState: (state) => writeAutoUpdateState(state),
    processId: process.pid,
    getCurrentWorkerPid: () => getCurrentWorkerPid(port, WORKER_PID_CAPTURE_TIMEOUT_MS),
    runInstaller: async (version) => {
      const invocation = claudeMemUpdateInvocation(version);
      if (invocation.kind === 'npx-not-found') return invocation;
      return runAutoUpdateInstaller(invocation.invocation, {
        logPath,
        deadlineMs: AUTO_UPDATE_INSTALLER_DEADLINE_MS,
        runFolderName: autoUpdateInstallerRunFolderName(attemptStartedAt, version),
      });
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
 * `npx --yes --no-workspaces --package=claude-mem@<version> claude-mem
 * update`: the installer users run (`npx claude-mem@<version> update`), with
 * three flags for npx and only `update` for the installer. It runs from a
 * folder of its own (makeAutoUpdateInstallerRunFolder says why).
 *  - `--yes` answers npx's own "Ok to proceed?" for a package it has not
 *    cached.
 *  - `--no-workspaces` stops npm's search for the project at that folder:
 *    without it npm goes on reading every package.json above it, looking for
 *    a workspace root (makeAutoUpdateInstallerRunFolder).
 *  - `--package` names the package, and `claude-mem` is the command npx runs
 *    from it: the package's only bin, the same since 10.6.2 (package.json).
 *    Given the package as the command instead, npx first looks for a file
 *    named `claude-mem@<version>` in node_modules/.bin of the project and of
 *    every folder above it, up to the root, and runs the first one it finds,
 *    then for the command in the global bin folder (libnpmexec lib/index.js,
 *    lib/file-exists.js localFileExists). With --package npx skips both: it
 *    installs the version in its own cache (the project holds no claude-mem),
 *    from the registry unless the cache already holds it, and runs the command
 *    with the cache's bin folder first on its PATH (lib/index.js;
 *    @npmcli/run-script lib/set-path.js).
 * All three come before the command: npx hands everything from its first
 * positional argument on to the command it runs (npm bin/npx-cli.js). The
 * installer's non-interactive path keeps the user's saved provider, and any
 * flag given to it could change that. On Windows npx is a .cmd shim, which
 * only cmd.exe can start (spawn.ts commandInvocation, which quotes each
 * argument), found the way the other installers find theirs
 * (lookupWindowsCommand, which drops a match in the current directory). When
 * it finds none the run fails as npx-not-found: a bare `npx.cmd` would let
 * cmd.exe search its working directory before PATH.
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
  return {
    kind: 'ready',
    invocation: commandInvocation(npx, ['--yes', '--no-workspaces', `--package=claude-mem@${version}`, 'claude-mem', 'update'], platform),
  };
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

/** The folder in the data dir that holds each installer run's own folder. */
const AUTO_UPDATE_INSTALLER_FOLDER_NAME = 'auto-update-installer';

/**
 * The installer folders' mode: read, write and search for their owner only,
 * so no other account but root can list them or put anything in them, nor
 * rename a run's folder and put another in its place. claude-mem-launcher.ts
 * neutralBunSpawnCwd gives the data dir's `run` folder the same mode the same
 * way: mkdir with the mode, then chmod, which no umask narrows and which also
 * tightens a folder that is already there. Windows applies no mode: there the
 * folders take the data dir's permissions, and the default data dir, in the
 * user's profile, is closed to every other account but administrators and
 * SYSTEM.
 */
const OWNER_ONLY_FOLDER_MODE = 0o700;

/**
 * The run folder's package.json: a private package that is not claude-mem,
 * with no dependencies and no bin, so the npm project npx loads there holds
 * nothing it could run (makeAutoUpdateInstallerRunFolder).
 */
const AUTO_UPDATE_INSTALLER_RUN_PACKAGE_JSON = `${JSON.stringify({ name: 'auto-update-installer-run', private: true }, null, 2)}\n`;

/** The folder that holds each installer run's own folder: auto-update-installer in the data dir, as an absolute path. */
export function autoUpdateInstallerFolder(dataDirectory: string = paths.dataDir()): string {
  return path.resolve(dataDirectory, AUTO_UPDATE_INSTALLER_FOLDER_NAME);
}

/**
 * The name of one installer run's folder: `<attempt start in epoch ms>-<the
 * version the run installs>`. The target's run and the restore run of one
 * attempt install different versions (a promoted target is always newer than
 * the installed version, auto-update-check.ts), so every run of every attempt
 * gets a name of its own. Throws on anything else, as
 * claudeMemUpdateInvocation does for a version that is not one, so the name is
 * always one plain path segment.
 */
export function autoUpdateInstallerRunFolderName(attemptStartedAt: number, version: string): string {
  if (!Number.isSafeInteger(attemptStartedAt) || attemptStartedAt < 0 || !INSTALLED_VERSION_PATTERN.test(version)) {
    throw new Error(`Refusing to name an installer folder for ${JSON.stringify({ attemptStartedAt, version })}: not an attempt start and a claude-mem version`);
  }
  return `${attemptStartedAt}-${version}`;
}

export type AutoUpdateInstallerRunFolder =
  | { kind: 'made'; path: string }
  | { kind: 'failed'; message: string };

/**
 * The folder one installer run stands in (runAutoUpdateInstaller), new for
 * that run: <data dir>/auto-update-installer/<runFolderName>, holding only
 * AUTO_UPDATE_INSTALLER_RUN_PACKAGE_JSON and, like the folder that holds it,
 * open to this user only (OWNER_ONLY_FOLDER_MODE).
 *
 * npx runs what the npm project around it provides. npm takes as the project
 * the first folder, from its working directory up to the root, that holds a
 * package.json or a node_modules folder (@npmcli/config lib/index.js
 * loadLocalPrefix), reads that project's .npmrc (loadProjectConfig) and loads
 * its tree, the project's own package included; when anything in it is
 * claude-mem at the version asked for, npx downloads nothing and runs that
 * copy (libnpmexec lib/index.js missingFromTree). So no working directory is
 * safe on its own: from the data dir, a claude-mem checkout above it made
 * every update exit 127 (a checkout links no bin for its own package); from
 * the root of C:\, where any local user can create a folder, another user
 * could plant C:\node_modules\claude-mem at the promoted version, and the
 * updater would run it.
 *
 * The package.json makes this folder that first folder, so the project is
 * this folder: its tree holds only the package.json's own package, which is
 * not claude-mem, and its .npmrc does not exist. Two more things keep every
 * folder above out:
 *  - Past the first folder, loadLocalPrefix goes on up to the root and reads
 *    each package.json there, looking for a workspace root whose `workspaces`
 *    list this folder; one that does becomes the project, its .npmrc
 *    included, and a `script-shell` set there runs the command. Only
 *    `--no-workspaces` on the command line stops the search at the first
 *    folder (claudeMemUpdateInvocation). npm does not pass that setting on to
 *    the installer (definitions.js `workspaces`, envExport false).
 *  - Given the package as the command, npx would look for a node_modules/.bin
 *    file named like it in every folder above; claudeMemUpdateInvocation's
 *    --package skips that.
 * npx then fetches the version from the registry gate 7 read
 * (autoUpdateInstallerEnv).
 *
 * Nothing else about npm changes. Its global prefix stays the machine's own
 * (PREFIX, else the folder above the node executable's; loadGlobalPrefix), so
 * it reads the same global npmrc (<prefix>/etc/npmrc, loadDefaults) and user
 * npmrc (~/.npmrc) as the user's own `npx claude-mem@<version> update`, a
 * proxy or CA file set there included, and passes their settings on to the
 * installer the same way (lib/set-envs.js), where its own npm installs
 * (npm-install-helper.ts runNpmStrict) and its Bun lookup (ProcessManager.ts
 * resolveWorkerRuntimePath reads npm_config_prefix) find them.
 *
 * The folder is new for every run (autoUpdateInstallerRunFolderName), so no
 * run waits on removing an earlier one's. The folders earlier runs left are
 * removed first, as far as they can be: one that cannot be (on Windows, a
 * process still holding it) is logged and left, and the run goes on. The run
 * folder is made without `recursive`, which fails when it is already there,
 * and its package.json is written with `wx`, so a run only ever stands in a
 * folder it made itself.
 *
 * Never throws: a folder that cannot be made, or a package.json that cannot
 * be written, comes back as failed, naming the step and the reason.
 *
 * Read in npm 11.14.1 (@npmcli/config 10.9.0, libnpmexec 10.2.7), and checked
 * with it from such a folder below each of four plants in a parent folder
 * (2026-11-08): node_modules/claude-mem at the promoted version, a claude-mem
 * package.json at that version, a node_modules/.bin file named
 * claude-mem@<version>, and a workspace root listing the folder whose .npmrc
 * names a script-shell. The first three ran with the flags from before #5500,
 * from the data dir; the fourth ran without --no-workspaces. With
 * claudeMemUpdateInvocation's flags none ran, and npx asked the registry for
 * claude-mem.
 */
export function makeAutoUpdateInstallerRunFolder(runFolderName: string, dataDirectory: string = paths.dataDir()): AutoUpdateInstallerRunFolder {
  const installerFolder = autoUpdateInstallerFolder(dataDirectory);
  const runFolder = path.join(installerFolder, runFolderName);
  const packageJsonPath = path.join(runFolder, 'package.json');
  let failedStep = `the folder ${installerFolder} could not be made`;
  try {
    mkdirSync(installerFolder, { recursive: true, mode: OWNER_ONLY_FOLDER_MODE });
    if (process.platform !== 'win32') chmodSync(installerFolder, OWNER_ONLY_FOLDER_MODE);
    removeFoldersEarlierInstallerRunsLeft(installerFolder);
    failedStep = `the folder ${runFolder} could not be made`;
    mkdirSync(runFolder, { mode: OWNER_ONLY_FOLDER_MODE });
    if (process.platform !== 'win32') chmodSync(runFolder, OWNER_ONLY_FOLDER_MODE);
    failedStep = `${packageJsonPath} could not be written`;
    writeFileSync(packageJsonPath, AUTO_UPDATE_INSTALLER_RUN_PACKAGE_JSON, { flag: 'wx' });
    return { kind: 'made', path: runFolder };
  } catch (error: unknown) {
    return { kind: 'failed', message: `${failedStep}: ${errorMessageOf(error)}` };
  }
}

/** Remove what earlier runs left in the installer folder, each entry as far as it can be. Logs what it cannot remove; never throws. */
function removeFoldersEarlierInstallerRunsLeft(installerFolder: string): void {
  let leftovers: string[];
  try {
    leftovers = readdirSync(installerFolder);
  } catch (error: unknown) {
    logger.warn('AUTO_UPDATE', 'Could not list what earlier auto-update installer runs left; the run goes on', { installerFolder },
      error instanceof Error ? error : new Error(String(error)));
    return;
  }
  for (const leftover of leftovers) {
    const leftoverPath = path.join(installerFolder, leftover);
    try {
      rmSync(leftoverPath, { recursive: true, force: true });
    } catch (error: unknown) {
      logger.warn('AUTO_UPDATE', 'Could not remove a folder an earlier auto-update installer run left; the run goes on', { leftoverPath },
        error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * Every spelling of the variables that set the default registry for npx, npm
 * and bun install:
 *  - npm reads every variable whose name matches /^npm_config_/i into its
 *    `env` layer, in any case, and that layer outranks every npmrc file; only
 *    the command line outranks it (@npmcli/config lib/index.js loadEnv and
 *    confTypes, read in npm 11.14.1; https://docs.npmjs.com/cli/v11/using-npm/config
 *    "Environment Variables": "Config values are case-insensitive, so
 *    NPM_CONFIG_FOO=bar will work the same").
 *  - bun install reads BUN_CONFIG_REGISTRY, then NPM_CONFIG_REGISTRY, then
 *    npm_config_registry, and the first one set wins over .npmrc and
 *    bunfig.toml; only --registry outranks it (bun's docs/pm/npmrc.mdx,
 *    "Configuration is loaded in this order", in bun-types 1.4.4;
 *    src/install/PackageManager/PackageManagerOptions.zig at bun-v1.3.9, and
 *    PackageManagerOptions.rs on main, read 2026-11-08).
 * Windows env names are case-insensitive, so every spelling inherited is
 * removed before the three below are set, as npm-install-helper.ts
 * npmChildEnv removes an inherited allow-scripts setting.
 */
const REGISTRY_ENV_NAME = /^(?:npm|bun)_config_registry$/i;

/** The names autoUpdateInstallerEnv sets: the two spellings bun looks for besides its own, which npm reads in any case. */
const REGISTRY_ENV_NAMES_SET = ['npm_config_registry', 'NPM_CONFIG_REGISTRY', 'BUN_CONFIG_REGISTRY'] as const;

/**
 * The environment of every installer run, the target's and the previous
 * version's (runAutoUpdateInstaller): the supervisor's, which the hop passed
 * through sanitizeEnv, with two changes.
 *  - The default registry is the one gate 7 read npm's metadata from
 *    (auto-update-check.ts NPM_PUBLIC_REGISTRY_URL), over anything inherited:
 *    the artifact installed must come from the registry whose metadata the
 *    check verified, and the worker's environment can come from whatever
 *    process started it (a project's SessionStart hook can cold-start it).
 *    The installer passes its environment on to the npm and bun installs of
 *    the plugin's dependencies (npm-install-helper.ts runNpmStrict,
 *    setup-runtime.ts installPluginDependencies), so they use it too. Proxy
 *    settings (env-sanitizer.ts ENV_PROXY_VARS) are kept as they are.
 *  - INSTALL_RUN_BY_AUTO_UPDATE_ENV marks the run as the auto-updater's
 *    (shared/auto-update-install-run.ts).
 */
export function autoUpdateInstallerEnv(supervisorEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(supervisorEnv).filter(([name]) => !REGISTRY_ENV_NAME.test(name)),
  );
  for (const name of REGISTRY_ENV_NAMES_SET) env[name] = NPM_PUBLIC_REGISTRY_URL;
  env[INSTALL_RUN_BY_AUTO_UPDATE_ENV] = INSTALL_RUN_BY_AUTO_UPDATE_VALUE;
  return env;
}

/** True for any command line that runs a claude-mem package, however it was built: what FORBID_REAL_AUTO_UPDATE_ENV refuses. */
function invocationRunsClaudeMem(invocation: CommandInvocation): boolean {
  return [invocation.command, ...invocation.args].some((part) => part.includes('claude-mem@'));
}

export interface AutoUpdateInstallerOptions {
  logPath: string;
  deadlineMs: number;
  /** The run's own folder in the installer folder (autoUpdateInstallerRunFolderName), made new for it. */
  runFolderName: string;
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
 * sanitizeEnv) with the registry gate 7 read and INSTALL_RUN_BY_AUTO_UPDATE_ENV
 * (autoUpdateInstallerEnv). Its working directory is a new folder made for
 * this run (makeAutoUpdateInstallerRunFolder), never the supervisor's own (the
 * data dir). When that folder cannot be made, nothing is started and the run
 * is reported as folder-failed, with the reason in the attempt log.
 *
 * At the deadline its tree is killed, and then the installer's own exit is
 * awaited for exitAfterKillWaitMs. One still running then is reported as
 * installerStillRunning, and the supervisor starts no other installer while
 * it may run (auto-update-apply.ts). A kill that threw is reported as failed,
 * never as killed.
 *
 * Rejects only before anything is started: when FORBID_REAL_AUTO_UPDATE_ENV
 * refuses a claude-mem installer, or when the attempt log cannot be created
 * or opened. Once the promise exists it always settles with how the run ended.
 */
export async function runAutoUpdateInstaller(invocation: CommandInvocation, options: AutoUpdateInstallerOptions): Promise<AutoUpdateInstallerRun> {
  const commandLine = [invocation.command, ...invocation.args].join(' ');
  if (invocationRunsClaudeMem(invocation)) assertRealAutoUpdateAllowed(`run the real installer (${commandLine})`);
  const spawnImplementation = options.spawnImplementation ?? spawnHidden;
  const killTree = options.killProcessTree ?? ((pid: number) => killProcessTree(pid));
  const exitAfterKillWaitMs = options.exitAfterKillWaitMs ?? INSTALLER_EXIT_AFTER_KILL_WAIT_MS;
  const deadlineSeconds = Math.round(options.deadlineMs / MILLISECONDS_PER_SECOND);
  mkdirSync(path.dirname(options.logPath), { recursive: true });
  const appendToLog = (line: string): void => {
    try {
      appendFileSync(options.logPath, `[auto-update ${new Date().toISOString()}] ${line}\n`);
    } catch (error: unknown) {
      logger.warn('AUTO_UPDATE', 'Could not append to the auto-update attempt log', { logPath: options.logPath, line },
        error instanceof Error ? error : new Error(String(error)));
    }
  };
  const runFolder = makeAutoUpdateInstallerRunFolder(options.runFolderName);
  if (runFolder.kind === 'failed') {
    appendToLog(`not running: ${commandLine}: ${runFolder.message}`);
    return { kind: 'folder-failed', message: runFolder.message };
  }
  const workingDirectory = runFolder.path;
  appendFileSync(options.logPath, `\n[auto-update ${new Date().toISOString()}] running: ${commandLine} in ${workingDirectory} (deadline ${deadlineSeconds} s)\n`);
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
        env: autoUpdateInstallerEnv(process.env),
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
