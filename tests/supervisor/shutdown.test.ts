import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createProcessRegistry } from '../../src/supervisor/process-registry.js';
import { removeOwnedPidFile, runShutdownCascade, terminateThenForceKillProcessGroups, type ProcessGroupRecord } from '../../src/supervisor/shutdown.js';
import { scratchDir } from '../helpers/scratch-dir.js';
import { isRunning, nonCollectingParentAndZombieWrittenTo, pidWrittenTo, stateAndProcessGroupOf } from '../helpers/stand-in-process.js';
import { removeTempDir } from '../helpers/temp-dir.js';

function makeTempDir(): string {
  return path.join(tmpdir(), `claude-mem-shutdown-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const tempDirs: string[] = [];

describe('supervisor shutdown cascade', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('removes child records and pid file', async () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    mkdirSync(tempDir, { recursive: true });

    const registryPath = path.join(tempDir, 'supervisor.json');
    const pidFilePath = path.join(tempDir, 'worker.pid');

    writeFileSync(pidFilePath, JSON.stringify({
      pid: process.pid,
      port: 37777,
      startedAt: new Date().toISOString()
    }));

    const registry = createProcessRegistry(registryPath);
    registry.register('worker', {
      pid: process.pid,
      type: 'worker',
      startedAt: '2026-03-15T00:00:00.000Z'
    });
    registry.register('dead-child', {
      pid: 2147483647,
      type: 'mcp',
      startedAt: '2026-03-15T00:00:01.000Z'
    });

    await runShutdownCascade({
      registry,
      currentPid: process.pid,
      pidFilePath
    });

    const persisted = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(Object.keys(persisted.processes)).toHaveLength(0);
    expect(() => readFileSync(pidFilePath, 'utf-8')).toThrow();
  });

  it('terminates tracked children in reverse spawn order', async () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    mkdirSync(tempDir, { recursive: true });

    const registry = createProcessRegistry(path.join(tempDir, 'supervisor.json'));
    registry.register('oldest', {
      pid: 41001,
      type: 'sdk',
      startedAt: '2026-03-15T00:00:00.000Z'
    });
    registry.register('middle', {
      pid: 41002,
      type: 'mcp',
      startedAt: '2026-03-15T00:00:01.000Z'
    });
    registry.register('newest', {
      pid: 41003,
      type: 'chroma',
      startedAt: '2026-03-15T00:00:02.000Z'
    });

    const originalKill = process.kill;
    const alive = new Set([41001, 41002, 41003]);
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];

    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      const normalizedSignal = signal ?? 'SIGTERM';
      if (normalizedSignal === 0) {
        if (!alive.has(pid)) {
          const error = new Error(`kill ESRCH ${pid}`) as NodeJS.ErrnoException;
          error.code = 'ESRCH';
          throw error;
        }
        return true;
      }

      calls.push({ pid, signal: normalizedSignal });
      alive.delete(pid);
      return true;
    }) as typeof process.kill;

    try {
      await runShutdownCascade({
        registry,
        currentPid: process.pid,
          pidFilePath: path.join(tempDir, 'worker.pid')
      });
    } finally {
      process.kill = originalKill;
    }

    expect(calls).toEqual([
      { pid: 41003, signal: 'SIGTERM' },
      { pid: 41002, signal: 'SIGTERM' },
      { pid: 41001, signal: 'SIGTERM' }
    ]);
  });

  // Phase 5 (worker-restart plan): the dying worker's shutdown cascade runs
  // AFTER the restart successor has written its own PID file. Blind deletion
  // here clobbered the successor's file and made `worker status` report a
  // healthy worker as not running.
  it('old-worker cleanup spares the successor\'s PID file (owner guard)', async () => {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    mkdirSync(tempDir, { recursive: true });

    const registryPath = path.join(tempDir, 'supervisor.json');
    const pidFilePath = path.join(tempDir, 'worker.pid');

    // A successor (NOT this process) already owns the PID file.
    const successorContent = JSON.stringify({
      pid: 99999847,
      port: 37777,
      startedAt: new Date().toISOString()
    });
    writeFileSync(pidFilePath, successorContent);

    const registry = createProcessRegistry(registryPath);
    registry.register('worker', {
      pid: process.pid,
      type: 'worker',
      startedAt: '2026-03-15T00:00:00.000Z'
    });

    await runShutdownCascade({
      registry,
      currentPid: process.pid,
      pidFilePath
    });

    // The successor's file must survive the old worker's dying breath, byte
    // for byte.
    expect(existsSync(pidFilePath)).toBe(true);
    expect(readFileSync(pidFilePath, 'utf-8')).toBe(successorContent);
  });
});

describe('removeOwnedPidFile (owner guard, Phase 5)', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function makePidFilePath(): string {
    const tempDir = makeTempDir();
    tempDirs.push(tempDir);
    mkdirSync(tempDir, { recursive: true });
    return path.join(tempDir, 'worker.pid');
  }

  it('leaves a corrupt file in place (ownership cannot be proven)', () => {
    const pidFilePath = makePidFilePath();
    writeFileSync(pidFilePath, 'not valid json {{{');

    removeOwnedPidFile(pidFilePath, process.pid);

    expect(existsSync(pidFilePath)).toBe(true);
  });

  it('leaves a pid-less JSON file in place (no recorded owner)', () => {
    const pidFilePath = makePidFilePath();
    writeFileSync(pidFilePath, JSON.stringify({ port: 37777 }));

    removeOwnedPidFile(pidFilePath, process.pid);

    expect(existsSync(pidFilePath)).toBe(true);
  });

  it('does not throw when the file is missing', () => {
    const pidFilePath = makePidFilePath();

    expect(() => removeOwnedPidFile(pidFilePath, process.pid)).not.toThrow();
    expect(existsSync(pidFilePath)).toBe(false);
  });
});

// A child that leads a process group of its own and exits before what it started, as a launcher found on PATH can:
// terminateThenForceKillProcessGroups goes by the group. Real processes, on macOS and Linux only: Windows has no process
// groups, and no sh.
(process.platform === 'win32' ? describe.skip : describe)('terminateThenForceKillProcessGroups, with real processes', () => {
  const FIXTURES = path.join(import.meta.dir, '..', 'fixtures', 'conversation-continuation');
  const LAUNCHER_THAT_EXITS_BEFORE_ITS_CLI = path.join(FIXTURES, 'launcher-that-exits-before-its-cli.mjs');
  const TURN_THAT_LEAVES_ONLY_A_ZOMBIE_IN_ITS_GROUP = path.join(FIXTURES, 'turn-that-leaves-only-a-zombie-in-its-group.pl');
  const folders: string[] = [];
  const processGroups: number[] = [];
  /** The parents that never collect their zombie: ended after each test, so that the zombie is collected. */
  const nonCollectingParents: number[] = [];
  afterEach(async () => {
    for (const processGroup of processGroups.splice(0)) if (isRunning(-processGroup)) process.kill(-processGroup, 'SIGKILL');
    for (const pid of nonCollectingParents.splice(0)) if (isRunning(pid)) process.kill(pid, 'SIGKILL');
    for (const folder of folders.splice(0)) await removeTempDir(folder);
  });

  /**
   * The launcher, leading a process group of its own, which exits as soon as it has started `cli` in that group. Answers
   * once it has exited, with the group's record as runCommand's commands are recorded (pgid: the leader's pid), and the
   * pid `cli` wrote.
   */
  async function groupWhoseLeaderHasExited(cli: string) {
    const folder = scratchDir('process-group-whose-leader-exited');
    folders.push(folder);
    const pidFile = path.join(folder, 'cli.pid');
    const leader = spawn(LAUNCHER_THAT_EXITS_BEFORE_ITS_CLI, [], {
      detached: true, stdio: 'ignore',
      env: { PATH: process.env.PATH, STAND_IN_LAUNCHER_RUNS: cli, STAND_IN_LAUNCHER_EXITS_AT_ONCE: '1', STAND_IN_TURN_WRITES_ITS_PID_TO: pidFile },
    });
    processGroups.push(leader.pid!);
    await new Promise<void>(resolve => leader.once('exit', () => resolve()));
    const cliPid = await pidWrittenTo(pidFile);
    const record: ProcessGroupRecord = { id: `conversation-turn:${leader.pid}`, pid: leader.pid!, pgid: leader.pid!, type: 'conversation-turn', startedAt: new Date().toISOString() };
    expect(isRunning(record.pid)).toBe(false);
    expect(isRunning(cliPid)).toBe(true);
    return { record, cliPid };
  }

  it('sends SIGTERM to what is left in the group of a leader that has exited, and needs no SIGKILL when that ends it', async () => {
    const { record, cliPid } = await groupWhoseLeaderHasExited(path.join(FIXTURES, 'cli-turn-that-ignores-sigint.sh'));

    expect(await terminateThenForceKillProcessGroups([record])).toEqual([]);
    expect(isRunning(cliPid)).toBe(false);
    expect(isRunning(-record.pgid)).toBe(false);
  });

  /**
   * The CLI ignores SIGTERM too, so the escalation runs whole: the cascade's 5 s grace window after SIGTERM, then up to
   * 1 s after SIGKILL. 15 s leaves room for a slow machine on top of the 6 s; bun's default of 5 s would end the test
   * inside that grace window.
   */
  it('SIGKILLs what is left once the grace window after SIGTERM runs out, and answers that record', async () => {
    const { record, cliPid } = await groupWhoseLeaderHasExited(path.join(FIXTURES, 'cli-turn-that-ignores-its-stop.sh'));

    expect(await terminateThenForceKillProcessGroups([record])).toEqual([record]);
    expect(isRunning(cliPid)).toBe(false);
    expect(isRunning(-record.pgid)).toBe(false);
  }, 15_000);

  it('signals no group that has emptied', async () => {
    const { record, cliPid } = await groupWhoseLeaderHasExited(path.join(FIXTURES, 'cli-turn-that-ignores-sigint.sh'));
    process.kill(cliPid, 'SIGKILL');
    while (isRunning(-record.pgid)) await Bun.sleep(10);
    const signalsSent: Array<string | number | undefined> = [];
    const realProcessKill = process.kill.bind(process);
    const processKill = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      signalsSent.push(signal);
      return realProcessKill(pid, signal);
    }) as typeof process.kill);
    try {
      expect(await terminateThenForceKillProcessGroups([record])).toEqual([]);
    } finally {
      processKill.mockRestore();
    }
    // Only the question whether any process is left in it (signal 0).
    expect(signalsSent).toEqual([0]);
  });

  it('signals no group left holding only a zombie, which no signal ends, and answers no record', async () => {
    const folder = scratchDir('process-group-with-only-a-zombie');
    folders.push(folder);
    const pidsFile = path.join(folder, 'pids.txt');
    // Not among processGroups: once the leader has exited, nothing is left in its group that a signal could end, and on
    // macOS kill(2) answers a SIGKILL to the group with EPERM. The leader exits by itself, or fails, on every path.
    const leader = spawn(TURN_THAT_LEAVES_ONLY_A_ZOMBIE_IN_ITS_GROUP, [], {
      detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, STAND_IN_TURN_WRITES_ITS_PIDS_TO: pidsFile },
    });
    expect(await new Promise<number | null>(resolve => leader.once('exit', code => resolve(code)))).toBe(0);
    const { nonCollectingParent, zombie } = nonCollectingParentAndZombieWrittenTo(pidsFile);
    nonCollectingParents.push(nonCollectingParent);
    const record: ProcessGroupRecord = { id: `conversation-turn:${leader.pid}`, pid: leader.pid!, pgid: leader.pid!, type: 'conversation-turn', startedAt: new Date().toISOString() };
    // kill(2) still finds the group, which holds the zombie and nothing else.
    expect(isRunning(-record.pgid)).toBe(true);
    expect(stateAndProcessGroupOf(zombie)).toEqual({ state: 'Z', processGroupId: record.pgid });
    const signalsSent: Array<string | number | undefined> = [];
    const realProcessKill = process.kill.bind(process);
    const processKill = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === -record.pgid) signalsSent.push(signal);
      return realProcessKill(pid, signal);
    }) as typeof process.kill);
    try {
      expect(await terminateThenForceKillProcessGroups([record])).toEqual([]);
    } finally {
      processKill.mockRestore();
    }
    // Only the question whether any process is left in it (signal 0): no SIGTERM, so no grace window waited out, and no SIGKILL.
    expect(signalsSent).toEqual([0]);
  });
});
