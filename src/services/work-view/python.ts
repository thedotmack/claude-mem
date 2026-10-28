import { spawn } from 'child_process';
import { runCommand } from '../agent-runner/detect.js';

/** Resolve a real Python 3 interpreter, not a Windows Store alias or Python 2. */
export async function resolvePythonCommand(spawnImpl: typeof spawn = spawn, platform: NodeJS.Platform = process.platform): Promise<{ command: string; args: string[] }> {
  const candidates = [
    { command: 'python3', args: [] as string[] },
    { command: 'python', args: [] as string[] },
    ...(platform === 'win32' ? [{ command: 'py', args: ['-3'] }] : []),
  ];
  for (const candidate of candidates) {
    const result = await runCommand(spawnImpl, candidate.command, [...candidate.args, '-c', 'import sys; sys.exit(sys.version_info < (3, 9))']);
    if (!result.spawnError && result.exitCode === 0) return candidate;
  }
  throw new Error(`My Work refresh requires Python 3.9 or newer on PATH (tried ${candidates.map(candidate => [candidate.command, ...candidate.args].join(' ')).join(', ')}).`);
}
