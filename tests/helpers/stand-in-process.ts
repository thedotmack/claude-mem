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
