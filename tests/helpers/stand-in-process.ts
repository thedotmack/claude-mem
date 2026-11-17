import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Whether a process is still running: kill(2) with signal 0. A negative pid asks about any process of that process
 * group. EPERM means it runs as someone else.
 */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pid a stand-in wrote to `pidFile`, once it has. Bun's per-test timeout ends the wait if it never does. */
export async function pidWrittenTo(pidFile: string): Promise<number> {
  for (;;) {
    const written = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : '';
    if (written !== '') return Number(written);
    await Bun.sleep(10);
  }
}

/**
 * The first letter of a process's state (Z: it has exited, and its parent has not collected it) and its process group,
 * from /proc/<pid>/stat on Linux and ps(1) elsewhere. Null once no such process is left. macOS and Linux only.
 */
export function stateAndProcessGroupOf(pid: number): { state: string; processGroupId: number } | null {
  if (process.platform === 'linux') {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return null;
    }
    // comm (field 2) is in parentheses and may hold spaces: fields 3 (state) and 5 (pgrp) follow the last ") ".
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    return { state: fields[0]!.charAt(0), processGroupId: Number(fields[2]) };
  }
  const [state, processGroupId] = spawnSync('ps', ['-o', 'stat=,pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().split(/\s+/);
  return state ? { state: state.charAt(0), processGroupId: Number(processGroupId) } : null;
}

/**
 * What turn-that-leaves-only-a-zombie-in-its-group.pl wrote to its pids file: the parent that never collects its zombie,
 * and the zombie.
 */
export function nonCollectingParentAndZombieWrittenTo(pidsFile: string): { nonCollectingParent: number; zombie: number } {
  const [nonCollectingParent, zombie] = readFileSync(pidsFile, 'utf8').trim().split(' ').map(Number);
  return { nonCollectingParent: nonCollectingParent!, zombie: zombie! };
}
