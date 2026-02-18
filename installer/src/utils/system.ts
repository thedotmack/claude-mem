import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

export type OSType = 'macos' | 'linux' | 'windows';

export function detectOS(): OSType {
  switch (process.platform) {
    case 'darwin': return 'macos';
    case 'win32': return 'windows';
    default: return 'linux';
  }
}

export function commandExists(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runCommand(command: string, args: string[] = []): CommandResult {
  try {
    const fullCommand = [command, ...args].join(' ');
    const stdout = execSync(fullCommand, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout?.toString().trim() ?? '',
      stderr: error.stderr?.toString().trim() ?? '',
      exitCode: error.status ?? 1,
    };
  }
}

export function expandHome(filepath: string): string {
  if (filepath.startsWith('~')) {
    return join(homedir(), filepath.slice(1));
  }
  return filepath;
}
