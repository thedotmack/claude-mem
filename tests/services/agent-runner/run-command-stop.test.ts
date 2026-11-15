// runCommand's stop (CommandOptions.signal), with real processes: a launcher script that holds SIGINT, as an agent
// wrapper installed ahead of the real CLI on PATH can, and a stand-in CLI behind it. The stop tests run on macOS and
// Linux only: on Windows a stop goes to the command alone (see CommandOptions.signal in detect.ts).
import { describe, expect, it, spyOn } from 'bun:test';
import { spawn, type SpawnOptions } from 'child_process';
import { join } from 'path';
import { runCommand } from '../../../src/services/agent-runner/detect.js';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'conversation-continuation');
const LAUNCHER_THAT_HOLDS_SIGINT = join(FIXTURES, 'launcher-that-holds-sigint.sh');
const STAND_IN_CLI = join(FIXTURES, 'cli-that-ends-its-turn-on-sigint.mjs');
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
});
