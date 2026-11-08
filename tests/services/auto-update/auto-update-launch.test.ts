import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import type { AutoUpdateApplyDeps } from '../../../src/services/auto-update/auto-update-apply.js';
import {
  AUTO_UPDATE_APPLY_COMMAND,
  AUTO_UPDATE_HOP_EXIT_BUDGET_MS,
  AutoUpdateApplyUsageError,
  FORBID_REAL_AUTO_UPDATE_ENV,
  autoUpdateApplyArgv,
  autoUpdateAttemptLogPath,
  autoUpdateLaunchDeps,
  autoUpdateWorkerProof,
  claudeMemUpdateInvocation,
  type ClaudeMemUpdateInvocation,
  launchAutoUpdateSupervisor,
  parseAutoUpdateApplyArguments,
  previousVersionSchemaKnownToCode,
  productionAutoUpdateApplyCommandDeps,
  productionAutoUpdateApplyDeps,
  productionAutoUpdateLaunchDeps,
  readRunningWorker,
  runAutoUpdateApplyCli,
  runAutoUpdateApplyCommand,
  runAutoUpdateInstaller,
  startDetachedAutoUpdateProcess,
  type AutoUpdateApplyCommandDeps,
  type AutoUpdateLaunchDeps,
  type StartedAutoUpdateProcess,
} from '../../../src/services/auto-update/auto-update-launch.js';
import { WORKER_PID_CAPTURE_TIMEOUT_MS } from '../../../src/services/auto-update/auto-update-deadlines.js';
import { autoUpdateStatePath, defaultAutoUpdateState, type AutoUpdateState } from '../../../src/services/auto-update/auto-update-state.js';
import { LATEST_SCHEMA_VERSION } from '../../../src/services/sqlite/connection.js';
import type { PidInfo } from '../../../src/supervisor/process-registry.js';
import { getPlatformTimeout, WORKER_BOOT_PROBE_TIMEOUT_MS } from '../../../src/services/infrastructure/ProcessManager.js';
import { Server, type ServerOptions } from '../../../src/services/server/Server.js';
import { InitPhaseTracker } from '../../../src/services/server/init-phase.js';
import { INSTALL_RUN_BY_AUTO_UPDATE_ENV } from '../../../src/shared/auto-update-install-run.js';
import { paths } from '../../../src/shared/paths.js';
import { commandInvocation, type CommandInvocation } from '../../../src/shared/spawn.js';
import * as spawnModule from '../../../src/shared/spawn.js';
import { logger } from '../../../src/utils/logger.js';
import { listenOnEphemeralPort } from '../../helpers/ephemeral-port.js';

// The process plumbing around the supervisor. Real processes here are only
// harmless Bun one-liners started by the test itself; the production
// factories are checked to refuse under the test tripwire.

const TARGET = '15.13.0';
const PREVIOUS = '15.12.0';
const STARTED_AT = Date.UTC(2026, 10, 8, 10, 0, 0);
const attempt = { targetVersion: TARGET, previousVersion: PREVIOUS, startedAt: STARTED_AT };
/** A deadline or budget these runs never reach: each ends in milliseconds, or is refused before it starts. */
const NEVER_REACHED_DEADLINE_MS = 60_000;
/**
 * Per-test limit for tests that start real Bun processes. Each starts and exits
 * in well under a second here; bun test's 5 s default is tight on a loaded runner.
 */
const REAL_PROCESS_TEST_TIMEOUT_MS = 30_000;

const scratchRoot = path.join(import.meta.dir, '..', '..', '..', '.scratch', 'test-runs');
let runDirectory: string;

beforeAll(() => {
  mkdirSync(scratchRoot, { recursive: true });
  runDirectory = mkdtempSync(path.join(scratchRoot, 'auto-update-launch-'));
});

afterAll(() => {
  rmSync(runDirectory, { recursive: true, force: true });
});

afterEach(() => {
  mock.restore();
});

function silenceLogger() {
  return {
    info: spyOn(logger, 'info').mockImplementation(() => {}),
    warn: spyOn(logger, 'warn').mockImplementation(() => {}),
    error: spyOn(logger, 'error').mockImplementation(() => {}),
    debug: spyOn(logger, 'debug').mockImplementation(() => {}),
  };
}

let logCounter = 0;
const freshLogPath = (): string => path.join(runDirectory, `attempt-${++logCounter}.log`);

/** The command line claudeMemUpdateInvocation builds, when it found npx. */
function readyInvocation(result: ClaudeMemUpdateInvocation): CommandInvocation {
  if (result.kind !== 'ready') throw new Error(`expected an invocation, got ${JSON.stringify(result)}`);
  return result.invocation;
}

describe('the test tripwire: no test can start a real auto-update', () => {
  it('is set for every test process by tests/preload.ts', () => {
    expect(process.env[FORBID_REAL_AUTO_UPDATE_ENV]).toBe('1');
  });

  it('stops the worker\'s launcher, the hop and supervisor CLI, and the supervisor\'s effects before they act', async () => {
    const logs = silenceLogger();
    const spawned = spyOn(spawnModule, 'spawnHidden');
    const stateBefore = existsSync(autoUpdateStatePath()) ? readFileSync(autoUpdateStatePath(), 'utf-8') : null;
    const refusal = `${FORBID_REAL_AUTO_UPDATE_ENV} is set`;

    expect(() => productionAutoUpdateLaunchDeps({ scriptPath: '/never/run/worker-service.cjs' })).toThrow(refusal);
    expect(() => productionAutoUpdateApplyCommandDeps({ scriptPath: '/never/run/worker-service.cjs', port: 1 })).toThrow(refusal);
    expect(() => productionAutoUpdateApplyDeps({ port: 1, logPath: freshLogPath() })).toThrow(refusal);
    // The dispatcher's case turns the refusal into a failed exit, even for a well-formed hop.
    const hopArgs = autoUpdateApplyArgv('/never/run/worker-service.cjs', attempt, { detachedHop: true }).slice(2);
    expect(await runAutoUpdateApplyCli(hopArgs, { scriptPath: '/never/run/worker-service.cjs', port: 1 })).toBe(1);
    expect(logs.error.mock.calls.map((call) => call[1])).toContain(`${AUTO_UPDATE_APPLY_COMMAND} refused to start`);

    expect(spawned).not.toHaveBeenCalled();
    expect(existsSync(autoUpdateStatePath()) ? readFileSync(autoUpdateStatePath(), 'utf-8') : null).toBe(stateBefore);
  });

  it('stops the installer runner for any claude-mem command line, however it was built, before it spawns or opens the log', async () => {
    const spawned = spyOn(spawnModule, 'spawnHidden');
    const logPath = freshLogPath();
    for (const invocation of [
      readyInvocation(claudeMemUpdateInvocation(TARGET, 'darwin')),
      readyInvocation(claudeMemUpdateInvocation(TARGET, 'win32', () => 'C:\\Program Files\\nodejs\\npx.cmd')),
      commandInvocation('bunx', ['claude-mem@latest', 'install']),
    ]) {
      await expect(runAutoUpdateInstaller(invocation, { logPath, deadlineMs: NEVER_REACHED_DEADLINE_MS })).rejects.toThrow(`${FORBID_REAL_AUTO_UPDATE_ENV} is set`);
    }
    expect(spawned).not.toHaveBeenCalled();
    expect(existsSync(logPath)).toBe(false);
  });
});

describe('auto-update-apply arguments', () => {
  it('round-trips what the worker and the hop pass', () => {
    const hopArgv = autoUpdateApplyArgv('/plugin/scripts/worker-service.cjs', attempt, { detachedHop: true });
    expect(hopArgv).toEqual([
      '/plugin/scripts/worker-service.cjs', AUTO_UPDATE_APPLY_COMMAND,
      '--target-version', TARGET, '--previous-version', PREVIOUS, '--attempt-started-at', String(STARTED_AT), '--detached-hop',
    ]);
    expect(parseAutoUpdateApplyArguments(hopArgv.slice(2))).toEqual({ ...attempt, detachedHop: true });
    const supervisorArgv = autoUpdateApplyArgv('/plugin/scripts/worker-service.cjs', attempt, { detachedHop: false });
    expect(parseAutoUpdateApplyArguments(supervisorArgv.slice(2))).toEqual({ ...attempt, detachedHop: false });
  });

  it('accepts a prerelease previous version, the form an installed version can take', () => {
    expect(parseAutoUpdateApplyArguments(['--target-version', TARGET, '--previous-version', '15.12.0-beta.1', '--attempt-started-at', '1']))
      .toMatchObject({ previousVersion: '15.12.0-beta.1' });
  });

  it.each([
    [['--target-version', TARGET, '--previous-version', PREVIOUS], 'must be the attempt\'s start in epoch milliseconds'],
    [['--target-version', TARGET, '--previous-version', PREVIOUS, '--attempt-started-at', '12abc'], 'epoch milliseconds'],
    [['--target-version', 'latest', '--previous-version', PREVIOUS, '--attempt-started-at', '1'], 'exact X.Y.Z release'],
    [['--target-version', '15.13.0-beta.1', '--previous-version', PREVIOUS, '--attempt-started-at', '1'], 'exact X.Y.Z release'],
    [['--target-version', '15.13.0" & calc & "', '--previous-version', PREVIOUS, '--attempt-started-at', '1'], 'exact X.Y.Z release'],
    [['--target-version', TARGET, '--previous-version', '../15.12.0', '--attempt-started-at', '1'], 'must be a claude-mem version'],
    [['--target-version', TARGET, '--previous-version', '--attempt-started-at', '1'], '--previous-version needs a value'],
    [['--target-version', TARGET, '--target-version', TARGET], 'given twice'],
    [['--provider', 'claude'], 'Unknown argument "--provider"'],
  ] as Array<[string[], string]>)('refuses %j', (args, problem) => {
    expect(() => parseAutoUpdateApplyArguments(args)).toThrow(AutoUpdateApplyUsageError);
    expect(() => parseAutoUpdateApplyArguments(args)).toThrow(problem);
  });
});

describe('claudeMemUpdateInvocation', () => {
  it('is exactly `npx --yes claude-mem@<version> update`: no provider or other flag', () => {
    expect(claudeMemUpdateInvocation(TARGET, 'linux')).toEqual({
      kind: 'ready',
      invocation: { command: 'npx', args: ['--yes', `claude-mem@${TARGET}`, 'update'], windowsVerbatimArguments: false },
    });
  });

  it('runs the npx .cmd shim through cmd.exe on Windows, found the way the other installers find theirs', () => {
    const lookups: string[] = [];
    const invocation = readyInvocation(claudeMemUpdateInvocation(TARGET, 'win32', (command) => { lookups.push(command); return 'C:\\Program Files\\nodejs\\npx.cmd'; }));
    expect(lookups).toEqual(['npx']);
    expect(invocation).toEqual({
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `""C:\\Program Files\\nodejs\\npx.cmd" "--yes" "claude-mem@${TARGET}" "update""`],
      windowsVerbatimArguments: true,
    });
  });

  it('fails as npx-not-found on Windows when no npx is on PATH, never falling back to a bare npx.cmd that cmd.exe would look for in the data dir first', () => {
    expect(claudeMemUpdateInvocation(TARGET, 'win32', () => null)).toEqual({ kind: 'npx-not-found', message: 'npx was not found on PATH' });
  });

  it('refuses anything that is not a claude-mem version', () => {
    expect(() => claudeMemUpdateInvocation('latest', 'linux')).toThrow('not a claude-mem version');
  });
});

describe('runAutoUpdateInstaller', () => {
  const bunScript = (source: string) => commandInvocation(process.execPath, ['-e', source]);

  it('gives the installer no stdin and no TTY, so it takes the non-interactive path, and appends its output to the attempt log', async () => {
    const logPath = freshLogPath();
    const run = await runAutoUpdateInstaller(bunScript([
      "process.stdout.write(JSON.stringify({ stdinIsTTY: process.stdin.isTTY ?? null }));",
      "let received = '';",
      "process.stdin.on('data', (chunk) => { received += chunk; });",
      "process.stdin.on('end', () => { process.stdout.write(' stdin-ended-with-bytes:' + received.length); process.exit(3); });",
    ].join('\n')), { logPath, deadlineMs: NEVER_REACHED_DEADLINE_MS });

    expect(run).toEqual({ kind: 'exited', exitCode: 3, signal: null });
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('{"stdinIsTTY":null} stdin-ended-with-bytes:0');
    expect(log).toContain('running: ');
    expect(log).toContain('installer exited (code 3, signal none)');
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  it('inherits the supervisor\'s environment', async () => {
    const logPath = freshLogPath();
    const run = await runAutoUpdateInstaller(bunScript(`process.stdout.write('tripwire=' + process.env.${FORBID_REAL_AUTO_UPDATE_ENV})`), { logPath, deadlineMs: NEVER_REACHED_DEADLINE_MS });
    expect(run).toEqual({ kind: 'exited', exitCode: 0, signal: null });
    expect(readFileSync(logPath, 'utf-8')).toContain('tripwire=1');
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  it('reports an installer that cannot start: Bun returns no pid and emits ENOENT after spawn returned', async () => {
    const logs = silenceLogger();
    const logPath = freshLogPath();
    const run = await runAutoUpdateInstaller(commandInvocation(path.join(runDirectory, 'missing-npx'), ['--yes']), { logPath, deadlineMs: NEVER_REACHED_DEADLINE_MS });
    expect(run).toMatchObject({ kind: 'spawn-failed', message: expect.stringContaining('ENOENT') });
    expect(readFileSync(logPath, 'utf-8')).toContain('could not start the installer');
    expect(logs.error).not.toHaveBeenCalled();
  });

  it('reports a spawn that throws', async () => {
    const run = await runAutoUpdateInstaller(commandInvocation('npm-like', []), {
      logPath: freshLogPath(),
      deadlineMs: NEVER_REACHED_DEADLINE_MS,
      spawnImplementation: (() => { throw new Error('spawn EAGAIN'); }) as never,
    });
    expect(run).toEqual({ kind: 'spawn-failed', message: 'spawn EAGAIN' });
  });

  it('logs an error the child reports after it started, and keeps waiting for its exit', async () => {
    const logs = silenceLogger();
    const child = Object.assign(new EventEmitter(), { pid: 4321, unref() {} });
    const runPromise = runAutoUpdateInstaller(commandInvocation('npm-like', []), {
      logPath: freshLogPath(),
      deadlineMs: NEVER_REACHED_DEADLINE_MS,
      spawnImplementation: (() => child) as never,
    });
    child.emit('spawn');
    child.emit('error', new Error('kill EPERM'));
    child.emit('exit', 0, null);
    expect(await runPromise).toEqual({ kind: 'exited', exitCode: 0, signal: null });
    expect(logs.warn.mock.calls.map((call) => call[1])).toContain('The auto-update installer reported an error after it started');
  });

  it('kills the tree at the deadline, and records a kill that failed', async () => {
    silenceLogger();
    const killed: number[] = [];
    const logPath = freshLogPath();
    const child = Object.assign(new EventEmitter(), { pid: 4322, unref() {} });
    const run = await runAutoUpdateInstaller(commandInvocation('npm-like', []), {
      logPath,
      // The shortest real timer: this child never exits on its own.
      deadlineMs: 1,
      spawnImplementation: (() => { setTimeout(() => child.emit('spawn'), 0); return child; }) as never,
      killProcessTree: async (pid) => {
        killed.push(pid);
        // The exit the kill causes arrives before the kill call returns, and must not read as the installer's own exit.
        child.emit('exit', null, 'SIGTERM');
        throw new Error('taskkill failed: Access is denied');
      },
    });
    expect(killed).toEqual([4322]);
    // The installer did exit, so no installer is left running, but the kill is still reported as failed.
    expect(run).toEqual({ kind: 'timed-out', deadlineMs: 1, killError: 'taskkill failed: Access is denied', installerPid: 4322, installerStillRunning: false });
    expect(readFileSync(logPath, 'utf-8')).toContain('killing its process tree failed: taskkill failed: Access is denied; it exited');
  });

  it('reports an installer still running after the kill, whether the kill threw or returned, and logs it as failed', async () => {
    for (const kill of [async () => {}, async () => { throw new Error('kill EPERM'); }]) {
      const logs = silenceLogger();
      const logPath = freshLogPath();
      const child = Object.assign(new EventEmitter(), { pid: 4324, unref() {} });
      const run = await runAutoUpdateInstaller(commandInvocation('npm-like', []), {
        logPath,
        // The shortest real timers: this child never exits, not even when killed.
        deadlineMs: 1,
        exitAfterKillWaitMs: 1,
        spawnImplementation: (() => { setTimeout(() => child.emit('spawn'), 0); return child; }) as never,
        killProcessTree: kill,
      });
      expect(run).toMatchObject({ kind: 'timed-out', installerPid: 4324, installerStillRunning: true });
      expect(readFileSync(logPath, 'utf-8')).toContain('pid 4324 was still running 1 ms later');
      expect(logs.error.mock.calls.map((call) => call[1])).toContain('The auto-update installer was still running after its process tree was killed');
      mock.restore();
    }
  });

  it('marks the run as the auto-updater\'s in the installer\'s environment, and keeps the rest of it', async () => {
    const logPath = freshLogPath();
    const run = await runAutoUpdateInstaller(bunScript(`process.stdout.write('marker=' + process.env.${INSTALL_RUN_BY_AUTO_UPDATE_ENV} + ' path=' + Boolean(process.env.PATH))`), { logPath, deadlineMs: NEVER_REACHED_DEADLINE_MS });
    expect(run).toEqual({ kind: 'exited', exitCode: 0, signal: null });
    expect(readFileSync(logPath, 'utf-8')).toContain('marker=1 path=true');
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  it('settles even when its handle on the attempt log cannot be closed, and logs that', async () => {
    const logs = silenceLogger();
    const child = Object.assign(new EventEmitter(), { pid: 4325, unref() {} });
    const runPromise = runAutoUpdateInstaller(commandInvocation('npm-like', []), {
      logPath: freshLogPath(),
      deadlineMs: NEVER_REACHED_DEADLINE_MS,
      // Close the descriptor the runner passes as the child's stdout, so its own close then fails with EBADF.
      spawnImplementation: ((_command: string, _args: string[], options: { stdio: [unknown, number, number] }) => { closeSync(options.stdio[1]); return child; }) as never,
    });
    child.emit('spawn');
    child.emit('exit', 0, null);
    expect(await runPromise).toEqual({ kind: 'exited', exitCode: 0, signal: null });
    expect(logs.warn.mock.calls.map((call) => call[1])).toContain('Could not close the supervisor\'s handle on the attempt log');
  });
});

describe('startDetachedAutoUpdateProcess', () => {
  it('starts a process in its own process group, with its output in the attempt log', async () => {
    const logPath = freshLogPath();
    const started = await startDetachedAutoUpdateProcess(process.execPath, ['-e', "console.log('hop says hi')"], {
      logPath,
      env: { ...process.env },
      cwd: runDirectory,
    });
    if (process.platform !== 'win32') {
      const processGroup = execFileSync('ps', ['-o', 'pgid=', '-p', String(started.pid)], { encoding: 'utf-8' }).trim();
      expect(Number(processGroup)).toBe(started.pid);
    }
    expect(await started.exited).toEqual({ exitCode: 0, signal: null });
    expect(readFileSync(logPath, 'utf-8')).toContain('hop says hi');
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  it('rejects when the runtime cannot be started, including the ENOENT that arrives after spawn returned', async () => {
    await expect(startDetachedAutoUpdateProcess(path.join(runDirectory, 'missing-bun'), [], {
      logPath: freshLogPath(),
      env: {},
      cwd: runDirectory,
    })).rejects.toThrow('ENOENT');
  });

  it('rejects when spawn throws', async () => {
    await expect(startDetachedAutoUpdateProcess('bun', [], {
      logPath: freshLogPath(),
      env: {},
      cwd: runDirectory,
      spawnImplementation: (() => { throw new Error('spawn EMFILE'); }) as never,
    })).rejects.toThrow('could not start bun: spawn EMFILE');
  });

  it('logs an error after the process started instead of leaving it unhandled', async () => {
    const logs = silenceLogger();
    const child = Object.assign(new EventEmitter(), { pid: 4323, unref() {} });
    const startedPromise = startDetachedAutoUpdateProcess('bun', [], {
      logPath: freshLogPath(),
      env: {},
      cwd: runDirectory,
      spawnImplementation: (() => child) as never,
    });
    child.emit('spawn');
    const started = await startedPromise;
    child.emit('error', new Error('late failure'));
    expect(started.pid).toBe(4323);
    expect(logs.warn.mock.calls.map((call) => call[1])).toContain('An auto-update process reported an error after it started');
  });
});

describe('launchAutoUpdateSupervisor (the worker\'s side)', () => {
  function fakeHop(exit: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>, pid = 6161): StartedAutoUpdateProcess {
    return { child: Object.assign(new EventEmitter(), { unref() {} }) as never, pid, exited: exit };
  }

  function launchHarness(startHop: AutoUpdateLaunchDeps['startHop'], overrides: Partial<AutoUpdateLaunchDeps> = {}) {
    let stored: AutoUpdateState = { ...defaultAutoUpdateState(), lastSeenPromotedVersion: TARGET };
    const events: string[] = [];
    const killed: number[] = [];
    const deps: AutoUpdateLaunchDeps = {
      now: () => STARTED_AT,
      readState: () => structuredClone(stored),
      writeState: (state) => { events.push('write-state'); stored = structuredClone(state); },
      startHop: async (hopAttempt) => { events.push(`start-hop ${JSON.stringify(hopAttempt)}`); return startHop(hopAttempt); },
      hopExitBudgetMs: NEVER_REACHED_DEADLINE_MS,
      killProcessTree: async (pid) => { killed.push(pid); },
      attemptLogPath: (startedAt) => `/logs/auto-update-${startedAt}.log`,
      ...overrides,
    };
    return { deps, stored: () => stored, events, killed };
  }

  it('records the attempt in flight before it starts the hop, and returns once the hop exits 0', async () => {
    silenceLogger();
    const harness = launchHarness(async () => fakeHop(Promise.resolve({ exitCode: 0, signal: null })));
    await launchAutoUpdateSupervisor({ targetVersion: TARGET, previousVersion: PREVIOUS }, harness.deps);
    expect(harness.events).toEqual(['write-state', `start-hop ${JSON.stringify(attempt)}`]);
    expect(harness.stored().inFlightAttempt).toEqual({ ...attempt, supervisorPid: null });
    expect(harness.stored().lastSeenPromotedVersion).toBe(TARGET);
  });

  it('throws when the hop exits non-zero, naming the attempt log', async () => {
    const harness = launchHarness(async () => fakeHop(Promise.resolve({ exitCode: 1, signal: null })));
    await expect(launchAutoUpdateSupervisor({ targetVersion: TARGET, previousVersion: PREVIOUS }, harness.deps))
      .rejects.toThrow(`the auto-update hop (pid 6161) exited with code 1 before the supervisor was started; see /logs/auto-update-${STARTED_AT}.log`);
  });

  it('throws when the hop cannot be started', async () => {
    const harness = launchHarness(async () => { throw new Error('could not start /missing/bun: spawn ENOENT'); });
    await expect(launchAutoUpdateSupervisor({ targetVersion: TARGET, previousVersion: PREVIOUS }, harness.deps)).rejects.toThrow('spawn ENOENT');
  });

  it('kills a hop that outlives its budget, and throws', async () => {
    silenceLogger();
    const harness = launchHarness(async () => fakeHop(new Promise(() => {})), { hopExitBudgetMs: 1 });
    await expect(launchAutoUpdateSupervisor({ targetVersion: TARGET, previousVersion: PREVIOUS }, harness.deps))
      .rejects.toThrow('did not exit within 0 s, so it was killed');
    expect(harness.killed).toEqual([6161]);
  });

  it('reports a kill of the hop that failed as failed, never as killed', async () => {
    const logs = silenceLogger();
    const harness = launchHarness(async () => fakeHop(new Promise(() => {})), {
      hopExitBudgetMs: 1,
      killProcessTree: async () => { throw new Error('tree-kill failed for PID 6161: EPERM'); },
    });
    const launch = launchAutoUpdateSupervisor({ targetVersion: TARGET, previousVersion: PREVIOUS }, harness.deps);
    await expect(launch).rejects.toThrow('did not exit within 0 s, and killing it failed (tree-kill failed for PID 6161: EPERM), so it may still be running');
    await expect(launch).rejects.not.toThrow('so it was killed');
    expect(logs.error.mock.calls.map((call) => call[1])).toContain('Could not kill an auto-update hop that outlived its budget');
  });

  it('starts the hop through the production launcher\'s own effects: the worker\'s script with --detached-hop, output in the attempt log', async () => {
    // A stand-in worker script that prints its arguments; the real one would refuse under the tripwire anyway.
    const scriptPath = path.join(runDirectory, 'print-argv.cjs');
    writeFileSync(scriptPath, "console.log('argv=' + JSON.stringify(process.argv.slice(2)));\n");
    const deps = autoUpdateLaunchDeps({ scriptPath });

    const hop = await deps.startHop(attempt);

    expect(await hop.exited).toEqual({ exitCode: 0, signal: null });
    expect(deps.attemptLogPath(STARTED_AT)).toBe(autoUpdateAttemptLogPath(STARTED_AT, paths.logsDir()));
    expect(readFileSync(deps.attemptLogPath(STARTED_AT), 'utf-8')).toContain(`argv=${JSON.stringify(autoUpdateApplyArgv(scriptPath, attempt, { detachedHop: true }).slice(1))}`);
    rmSync(deps.attemptLogPath(STARTED_AT), { force: true });
  }, REAL_PROCESS_TEST_TIMEOUT_MS);

  it('gives the hop the budget of a bundle-loading probe: 5 s, 10 s on Windows', () => {
    expect(AUTO_UPDATE_HOP_EXIT_BUDGET_MS).toBe(getPlatformTimeout(WORKER_BOOT_PROBE_TIMEOUT_MS));
  });
});

describe('runAutoUpdateApplyCommand', () => {
  const hopArgs = autoUpdateApplyArgv('/plugin/scripts/worker-service.cjs', attempt, { detachedHop: true }).slice(2);
  const supervisorArgs = autoUpdateApplyArgv('/plugin/scripts/worker-service.cjs', attempt, { detachedHop: false }).slice(2);

  function commandHarness(overrides: Partial<AutoUpdateApplyCommandDeps> = {}) {
    const calls: string[] = [];
    let unrefs = 0;
    const deps: AutoUpdateApplyCommandDeps = {
      startSupervisor: async (supervisorAttempt) => {
        calls.push(`start-supervisor ${JSON.stringify(supervisorAttempt)}`);
        return { child: { unref: () => { unrefs++; } } as never, pid: 7171, exited: new Promise(() => {}) };
      },
      buildApplyDeps: () => { calls.push('build-apply-deps'); throw new Error('not expected'); },
      flushTelemetry: async () => { calls.push('flush-telemetry'); },
      ...overrides,
    };
    return { deps, calls, unrefs: () => unrefs };
  }

  it('as the hop: starts the supervisor, lets it go, exits 0, and runs no supervisor code itself', async () => {
    silenceLogger();
    const harness = commandHarness();
    expect(await runAutoUpdateApplyCommand(hopArgs, harness.deps)).toBe(0);
    expect(harness.calls).toEqual([`start-supervisor ${JSON.stringify(attempt)}`]);
    expect(harness.unrefs()).toBe(1);
  });

  it('as the hop: exits 1 when the supervisor cannot be started', async () => {
    const logs = silenceLogger();
    const harness = commandHarness({ startSupervisor: async () => { throw new Error('could not start bun: spawn ENOENT'); } });
    expect(await runAutoUpdateApplyCommand(hopArgs, harness.deps)).toBe(1);
    expect(logs.error.mock.calls.map((call) => call[1])).toContain('Auto-update hop could not start the supervisor');
  });

  it('exits 1 on arguments it cannot use, before it starts anything', async () => {
    silenceLogger();
    const harness = commandHarness();
    expect(await runAutoUpdateApplyCommand(['--target-version', 'latest'], harness.deps)).toBe(1);
    expect(harness.calls).toEqual([]);
  });

  it('as the supervisor: runs applyAutoUpdate with its effects and flushes telemetry, exiting 1 when the attempt is not its own', async () => {
    silenceLogger();
    const notClaimedDeps = { readState: () => defaultAutoUpdateState() } as unknown as AutoUpdateApplyDeps;
    const harness = commandHarness({ buildApplyDeps: (supervisorAttempt) => { harness.calls.push(`build-apply-deps ${supervisorAttempt.startedAt}`); return notClaimedDeps; } });
    expect(await runAutoUpdateApplyCommand(supervisorArgs, harness.deps)).toBe(1);
    expect(harness.calls).toEqual([`build-apply-deps ${STARTED_AT}`, 'flush-telemetry']);
  });

  it('as the supervisor: exits 1, still flushing telemetry, when the outcome cannot be recorded', async () => {
    silenceLogger();
    const unreadableState = { readState: () => { throw new Error('EACCES'); } } as unknown as AutoUpdateApplyDeps;
    const harness = commandHarness({ buildApplyDeps: () => unreadableState });
    expect(await runAutoUpdateApplyCommand(supervisorArgs, harness.deps)).toBe(1);
    expect(harness.calls).toEqual(['flush-telemetry']);
  });
});

describe('autoUpdateAttemptLogPath', () => {
  it('is one file per attempt in the logs dir', () => {
    expect(autoUpdateAttemptLogPath(STARTED_AT, '/data/logs')).toBe(path.join('/data/logs', `auto-update-${STARTED_AT}.log`));
  });
});

// What the supervisor reads before each proof, to start a worker only when none runs.
describe('readRunningWorker', () => {
  /** Any port number: both readers are injected, so nothing is dialed or bound. */
  const PORT = 37777;
  const pidFileWorker = (pid: number, port?: number) => ({ pid, port, startedAt: '2026-11-08T10:00:00.000Z' }) as PidInfo;

  it('a worker answering on the port runs, with the pid it reports, read with the pid read\'s own budget', async () => {
    const reads: Array<[number, number | undefined]> = [];
    const read = await readRunningWorker(PORT, {
      getCurrentWorkerPid: async (port, timeoutMs) => { reads.push([port, timeoutMs]); return 4100; },
      readOwnedWorker: () => { throw new Error('the PID file is read only when nothing answers'); },
    });
    expect(read).toEqual({ kind: 'answering', pid: 4100 });
    expect(reads).toEqual([[PORT, WORKER_PID_CAPTURE_TIMEOUT_MS]]);
  });

  it('a live claude-mem worker in the PID file runs even when it answers nothing (a migration holds its event loop)', async () => {
    for (const port of [PORT, undefined]) {
      const read = await readRunningWorker(PORT, { getCurrentWorkerPid: async () => null, readOwnedWorker: () => pidFileWorker(4200, port) });
      expect(read).toEqual({ kind: 'alive-not-answering', pid: 4200 });
    }
  });

  it('none runs when nothing answers and the PID file names no live worker, or a worker meant for another port', async () => {
    expect(await readRunningWorker(PORT, { getCurrentWorkerPid: async () => null, readOwnedWorker: () => null })).toEqual({ kind: 'none' });
    expect(await readRunningWorker(PORT, { getCurrentWorkerPid: async () => null, readOwnedWorker: () => pidFileWorker(4300, PORT + 1) })).toEqual({ kind: 'none' });
  });
});

describe('previousVersionSchemaKnownToCode (gate 3\'s fix rule, in the worker)', () => {
  it('is this code\'s newest schema only when this code is the previous version\'s, and unknown otherwise', () => {
    expect(previousVersionSchemaKnownToCode(PREVIOUS, PREVIOUS)).toBe(LATEST_SCHEMA_VERSION);
    expect(previousVersionSchemaKnownToCode(PREVIOUS, PREVIOUS, 74)).toBe(74);
    // A worker Pi or DSH started from a marketplace copy already at the target runs the target's code.
    expect(previousVersionSchemaKnownToCode(TARGET, PREVIOUS)).toBeNull();
  });
});

// The supervisor's real proof (productionAutoUpdateApplyDeps.proveWorkerOnVersion)
// against the worker's real GET /api/ready, driven by a real InitPhaseTracker.
// A worker that only answers with its pid and version, as one whose startup
// failed or hangs still does on /api/health, must never count.
describe('autoUpdateWorkerProof (the supervisor\'s proof)', () => {
  /** Several reads of the stream fit in it; the production ceiling is 6 min (auto-update-deadlines.ts). */
  const TEST_CEILING_MS = 1500;
  let servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      // Under Bun, close() after closeAllConnections() can report ERR_SERVER_NOT_RUNNING (tests/server/ready-stream.test.ts).
      await server.close().catch((error: NodeJS.ErrnoException) => {
        if (error?.code !== 'ERR_SERVER_NOT_RUNNING') throw error;
      });
    }
  });

  async function startWorker(tracker: InitPhaseTracker): Promise<{ port: number; version: string }> {
    const options: ServerOptions = {
      getInitializationComplete: () => tracker.getInitPhase().phase === 'ready',
      initPhaseSource: tracker,
      // The real server pings every 2 s; this keeps a quiet stream alive in a short test.
      readyStreamPingIntervalMs: 40,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({ provider: 'claude', authMethod: 'cli', lastInteraction: null }),
    };
    const server = new Server(options);
    servers.push(server);
    const port = await listenOnEphemeralPort(server);
    const version = (await (await fetch(`http://127.0.0.1:${port}/api/version`)).json() as { version: string }).version;
    return { port, version };
  }

  it('does not prove a worker that reports its pid and version but has not finished starting', async () => {
    silenceLogger();
    const tracker = new InitPhaseTracker();
    tracker.setInitPhase('routes_ready');
    const { port, version } = await startWorker(tracker);
    // /api/health already reports this worker's pid and version.
    expect(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).toMatchObject({ pid: process.pid, version, initialized: false });

    const proof = await autoUpdateWorkerProof(port, TEST_CEILING_MS)(null, version);

    expect(proof).toEqual({ ok: false, startupFailed: false, detail: expect.stringContaining('"phase":"routes_ready"') });
  });

  it('proves it once it reports ready, and stops at once on a failed startup', async () => {
    silenceLogger();
    const startingThenReady = new InitPhaseTracker();
    const ready = await startWorker(startingThenReady);
    setTimeout(() => startingThenReady.setInitPhase('ready'), 200);
    expect(await autoUpdateWorkerProof(ready.port, TEST_CEILING_MS)(null, ready.version)).toEqual({ ok: true, pid: process.pid });

    const startingThenFailed = new InitPhaseTracker();
    const failed = await startWorker(startingThenFailed);
    setTimeout(() => startingThenFailed.setInitPhase('failed', 'SchemaNewerThanBinaryError: SQLite database has schema v75'), 200);
    expect(await autoUpdateWorkerProof(failed.port, 60_000)(null, failed.version)).toEqual({
      ok: false,
      startupFailed: true,
      detail: `pid ${process.pid}: SchemaNewerThanBinaryError: SQLite database has schema v75`,
    });
  });
});
