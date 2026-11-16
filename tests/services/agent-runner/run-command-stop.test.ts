// runCommand's stop (CommandOptions.signal), with real processes: a launcher script that holds SIGINT, as an agent
// wrapper installed ahead of the real CLI on PATH can, and a stand-in CLI behind it. The stop tests run on macOS and
// Linux only: on Windows a stop goes to the command alone (see CommandOptions.signal in detect.ts).
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { join } from 'path';
import { runCommand, type CommandOptions } from '../../../src/services/agent-runner/detect.js';
import { scratchDir } from '../../helpers/scratch-dir.js';
import { isRunning, pidWrittenTo } from '../../helpers/stand-in-process.js';
import { removeTempDir } from '../../helpers/temp-dir.js';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'conversation-continuation');
const LAUNCHER_THAT_HOLDS_SIGINT = join(FIXTURES, 'launcher-that-holds-sigint.sh');
const STAND_IN_CLI = join(FIXTURES, 'cli-that-ends-its-turn-on-sigint.mjs');
const LAUNCHER_THAT_EXITS_BEFORE_ITS_CLI = join(FIXTURES, 'launcher-that-exits-before-its-cli.mjs');
const CLI_TURN_THAT_ENDS_A_MOMENT_AFTER_ITS_STOP = join(FIXTURES, 'cli-turn-that-ends-a-moment-after-its-stop.sh');
/**
 * How long the stand-in CLI's turn lasts when no stop reaches it. The tests stop it the moment it prints "ready", and a
 * stop that reaches it ends it within a few milliseconds (measured on macOS with Bun 1.3.9 and Node 24), so the two
 * endings cannot be taken for each other. It is under bun test's default 5 s timeout, so a stop that never arrives
 * fails on the assertions, not on the timeout.
 */
const STAND_IN_TURN_LENGTH_MS = 3_000;

/** The real spawn, which also aborts `stop` as soon as the command prints "ready". */
function spawnThatStopsWhenReady(stop: AbortController): typeof spawn {
  return ((command: string, args: string[], options: SpawnOptions) => {
    const child = spawn(command, args, options);
    child.stdout?.on('data', (chunk: unknown) => {
      if (String(chunk).includes('ready')) stop.abort();
    });
    return child;
  }) as unknown as typeof spawn;
}

const describeOnMacOsAndLinux = process.platform === 'win32' ? describe.skip : describe;

describeOnMacOsAndLinux('a stop through runCommand, with real processes', () => {
  it('reaches a CLI behind a launcher that holds SIGINT, and the CLI ends its turn', async () => {
    const stop = new AbortController();
    const result = await runCommand(
      spawnThatStopsWhenReady(stop),
      'bash',
      [LAUNCHER_THAT_HOLDS_SIGINT, process.execPath, STAND_IN_CLI, String(STAND_IN_TURN_LENGTH_MS)],
      { signal: stop.signal, killSignal: 'SIGINT' },
    );
    expect(result.stdout).toBe('ready\nthe CLI got SIGINT\n');
    // The launcher exits with the CLI's code.
    expect(result.exitCode).toBe(130);
  });

  it('reports a stopped command by how it ended, never as one that could not start', async () => {
    const stop = new AbortController();
    const result = await runCommand(
      spawnThatStopsWhenReady(stop),
      process.execPath,
      [STAND_IN_CLI, String(STAND_IN_TURN_LENGTH_MS)],
      { signal: stop.signal, killSignal: 'SIGINT' },
    );
    expect(result.spawnError).toBeUndefined();
    expect(result.exitCode).toBe(130);
    expect(result.stdout).toBe('ready\nthe CLI got SIGINT\n');
  });

  it('tells onStopNotSent at once, throws nothing, when the stop cannot be sent, and the command runs on: its result comes when it ends', async () => {
    const stop = new AbortController();
    // kill(2)'s answer when no process in the group may be signalled, as Node's process.kill throws it.
    const notPermitted = Object.assign(new Error('kill EPERM'), { code: 'EPERM', errno: -1, syscall: 'kill' });
    const stopsNotSent: Error[] = [];
    /** What onStopNotSent had heard each time abort() returned. */
    const stopsNotSentWhenTheAbortReturned: Error[][] = [];
    let commandProcessGroup: number | undefined;
    const realProcessKill = process.kill.bind(process);
    // As kill(2) answers for a group none of whose processes may be signalled: EPERM while any is left, ESRCH once none is.
    const processKill = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (commandProcessGroup !== undefined && pid === -commandProcessGroup) {
        realProcessKill(pid, 0);
        throw notPermitted;
      }
      return realProcessKill(pid, signal);
    }) as typeof process.kill);
    try {
      const result = await runCommand(
        ((command: string, args: string[], options: SpawnOptions) => {
          const child = spawn(command, args, options);
          commandProcessGroup = child.pid;
          child.stdout?.on('data', (chunk: unknown) => {
            if (!String(chunk).includes('ready')) return;
            stop.abort();
            stopsNotSentWhenTheAbortReturned.push([...stopsNotSent]);
            // The failed stop left the CLI running, mid-turn: a stop that does reach it ends it, and that is how it ends.
            realProcessKill(-child.pid!, 'SIGINT');
          });
          return child;
        }) as unknown as typeof spawn,
        process.execPath,
        [STAND_IN_CLI, String(STAND_IN_TURN_LENGTH_MS)],
        { signal: stop.signal, killSignal: 'SIGINT', onStopNotSent: error => { stopsNotSent.push(error); } },
      );
      expect(stopsNotSentWhenTheAbortReturned).toEqual([[notPermitted]]);
      expect(stopsNotSent).toEqual([notPermitted]);
      expect(result.spawnError).toBeUndefined();
      expect(result).toMatchObject({ exitCode: 130, stdout: 'ready\nthe CLI got SIGINT\n' });
    } finally {
      processKill.mockRestore();
    }
  });

  it('tells onSpawn the started pid and its process group, which a stop reaches', async () => {
    const stop = new AbortController();
    const started: Array<{ pid: number; processGroupId: number | undefined }> = [];
    let childPid: number | undefined;
    const result = await runCommand(
      ((command: string, args: string[], options: SpawnOptions) => {
        const child = spawn(command, args, options);
        childPid = child.pid;
        child.stdout?.on('data', (chunk: unknown) => {
          if (String(chunk).includes('ready')) stop.abort();
        });
        return child;
      }) as unknown as typeof spawn,
      process.execPath,
      [STAND_IN_CLI, String(STAND_IN_TURN_LENGTH_MS)],
      { signal: stop.signal, killSignal: 'SIGINT', onSpawn: spawned => { started.push(spawned); } },
    );
    // The command leads a process group of its own: its id is the command's pid.
    expect(started).toEqual([{ pid: childPid!, processGroupId: childPid! }]);
    expect(result).toMatchObject({ exitCode: 130, stdout: 'ready\nthe CLI got SIGINT\n' });
  });

  it('sends nothing when the stop comes after the command has ended', async () => {
    const stop = new AbortController();
    const result = await runCommand(spawn, process.execPath, [STAND_IN_CLI, '0'], { signal: stop.signal, killSignal: 'SIGINT' });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'ready\nthe CLI finished its turn\n' });
    const processKill = spyOn(process, 'kill');
    try {
      stop.abort();
      expect(processKill).not.toHaveBeenCalled();
    } finally {
      processKill.mockRestore();
    }
  });
});

describeOnMacOsAndLinux('a command whose launcher exits before the CLI it started, with real processes', () => {
  const folders: string[] = [];
  /** Process groups the tests started, ended after each test in case it failed before they had. */
  const processGroups: number[] = [];
  afterEach(async () => {
    for (const processGroup of processGroups.splice(0)) if (isRunning(-processGroup)) process.kill(-processGroup, 'SIGKILL');
    for (const folder of folders.splice(0)) await removeTempDir(folder);
  });

  /**
   * runCommand running the launcher in front of the CLI that ends its turn a moment after its stop (six 50 ms naps), with
   * the CLI's output going to a file of its own, so the CLI does not hold the command's stdout and stderr, and with
   * `launcherSettings` added to the launcher's environment.
   */
  function launcherInFrontOfACli(stop: AbortController, launcherSettings: Record<string, string>) {
    const folder = scratchDir('run-command-launcher');
    folders.push(folder);
    const pidFile = join(folder, 'cli.pid');
    const processesLeft: Array<Parameters<NonNullable<CommandOptions['onProcessesLeftInItsGroup']>>[0]> = [];
    let launcher!: ChildProcess;
    let launcherClosed!: Promise<void>;
    const result = runCommand(
      ((command: string, args: string[], options: SpawnOptions) => {
        launcher = spawn(command, args, options);
        processGroups.push(launcher.pid!);
        // Heard before runCommand's own 'close' listener, and answered once everything that one does has run.
        launcherClosed = new Promise<void>(resolve => launcher.once('close', () => setImmediate(resolve)));
        return launcher;
      }) as unknown as typeof spawn,
      LAUNCHER_THAT_EXITS_BEFORE_ITS_CLI,
      [],
      {
        env: {
          PATH: process.env.PATH, STAND_IN_LAUNCHER_RUNS: CLI_TURN_THAT_ENDS_A_MOMENT_AFTER_ITS_STOP, STAND_IN_TURN_WRITES_ITS_PID_TO: pidFile,
          STAND_IN_LAUNCHER_SENDS_CLI_OUTPUT_TO: join(folder, 'cli-output.log'), ...launcherSettings,
        },
        signal: stop.signal, killSignal: 'SIGINT', onProcessesLeftInItsGroup: left => { processesLeft.push(left); },
      },
    );
    return { result, launcher: () => launcher, launcherClosed: () => launcherClosed, cliPid: () => pidWrittenTo(pidFile), processesLeft };
  }

  it('comes back only once the CLI has ended its turn when the launcher died on the stop at once, and says processes were left', async () => {
    const stop = new AbortController();
    const command = launcherInFrontOfACli(stop, {});
    const cliPid = await command.cliPid();
    stop.abort();
    const result = await command.result;
    // The launcher's 'close' came as it died; the CLI was still ending its turn, in the launcher's process group.
    expect(isRunning(cliPid)).toBe(false);
    expect(isRunning(-command.launcher().pid!)).toBe(false);
    // The launcher was ended by the stop's signal.
    expect(result).toMatchObject({ exitCode: null, stdout: '', stderr: '' });
    expect(command.processesLeft).toEqual([{ processGroupId: command.launcher().pid!, exitCode: null }]);
  });

  it('still sends a stop to the CLI that a launcher left running when it exited by itself, and comes back once the CLI has ended', async () => {
    const stop = new AbortController();
    const command = launcherInFrontOfACli(stop, { STAND_IN_LAUNCHER_EXITS_AT_ONCE: '1' });
    let cameBack = false;
    void command.result.then(() => { cameBack = true; });
    const cliPid = await command.cliPid();
    await command.launcherClosed();
    expect(cameBack).toBe(false);
    expect(isRunning(cliPid)).toBe(true);

    stop.abort();
    const result = await command.result;
    expect(isRunning(cliPid)).toBe(false);
    expect(isRunning(-command.launcher().pid!)).toBe(false);
    // The launcher exited 0 by itself, before the stop.
    expect(result.exitCode).toBe(0);
    expect(command.processesLeft).toEqual([{ processGroupId: command.launcher().pid!, exitCode: 0 }]);
  });
});

describe('a command run without a signal', () => {
  it('is spawned with the same options as before Stop existed: no process group of its own, no abort', async () => {
    const spawnOptionsSeen: SpawnOptions[] = [];
    const recordingSpawn = ((command: string, args: string[], options: SpawnOptions) => {
      spawnOptionsSeen.push(options);
      return spawn(command, args, options);
    }) as unknown as typeof spawn;
    const result = await runCommand(recordingSpawn, process.execPath, ['-e', 'process.stdout.write("ok")'], { cwd: FIXTURES });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'ok' });
    expect(Object.keys(spawnOptionsSeen[0]).sort()).toEqual(['cwd', 'env', 'stdio', 'windowsHide', 'windowsVerbatimArguments']);
  });

  it('tells onSpawn its pid and no process group, and does not tell onSpawn about a command that never started', async () => {
    const started: Array<{ pid: number; processGroupId: number | undefined }> = [];
    const ran = await runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], { onSpawn: spawned => { started.push(spawned); } });
    expect(ran).toMatchObject({ exitCode: 0, stdout: 'ok' });
    expect(started).toHaveLength(1);
    expect(started[0].processGroupId).toBeUndefined();
    expect(started[0].pid).toBeGreaterThan(0);
    const notStarted = await runCommand(join(FIXTURES, 'no-such-cli'), [], { onSpawn: spawned => { started.push(spawned); } });
    expect(notStarted.spawnError).toBeDefined();
    expect(started).toHaveLength(1);
  });
});
