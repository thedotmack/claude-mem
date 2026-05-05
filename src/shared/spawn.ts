// F1 foundation: spawn wrapper that hides child windows on Windows by default. See src/shared/spawn.ts.test.ts for invariant.
import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';

export type SpawnHiddenOptions = SpawnOptions;

export function spawnHidden(
  command: string,
  args?: readonly string[],
  options?: SpawnOptions
): ChildProcess {
  return spawn(command, args ?? [], { windowsHide: true, ...options });
}
