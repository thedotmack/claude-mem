import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { IS_WINDOWS } from './paths.js';

function bunCandidatePaths(): string[] {
  if (IS_WINDOWS) {
    return [
      join(homedir(), '.bun', 'bin', 'bun.exe'),
      join(process.env.USERPROFILE || homedir(), '.bun', 'bin', 'bun.exe'),
    ];
  }

  return [
    join(homedir(), '.bun', 'bin', 'bun'),
    '/usr/local/bin/bun',
    '/opt/homebrew/bin/bun',
    '/home/linuxbrew/.linuxbrew/bin/bun',
  ];
}

export function resolveBunBinaryPath(): string | null {
  const whichCommand = IS_WINDOWS ? 'where' : 'which';
  const pathCheck = spawnSync(whichCommand, ['bun'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: IS_WINDOWS,
  });

  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    return 'bun'; 
  }

  for (const candidatePath of bunCandidatePaths()) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

