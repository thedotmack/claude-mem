/**
 * Windows Process Utilities
 *
 * PID identity validation using PowerShell for Windows platforms.
 * Used by crash-recovery and orphan-reaper to identify and kill stale
 * Claude subprocesses where ppid=1 orphan detection is unavailable.
 */

import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import { HOOK_TIMEOUTS } from '../shared/hook-constants.js';

const execFileAsync = promisify(execFile);

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * Returns the CommandLine string for a Windows process via PowerShell,
 * or null if the PID is invalid, the process does not exist, or PowerShell fails.
 */
export function getProcessCommandLine(pid: number): string | null {
  if (!isValidPid(pid)) {
    return null;
  }

  const command = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`;

  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', command],
      { encoding: 'utf-8', timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND }
    ) as string;

    const trimmed = output.replace(/\r\n|\r|\n/g, '').trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

/**
 * Checks whether a process is alive using signal-zero.
 * Returns true if signal(0) succeeds or throws EPERM (exists but no permission).
 */
export function isProcessAlive(pid: number): boolean {
  if (!isValidPid(pid)) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return isErrnoException(err) && err.code === 'EPERM';
  }
}

function stripCsvQuotes(field: string): string {
  const trimmed = field.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

/**
 * Finds Claude subprocesses whose parent process is dead (orphaned).
 * Returns an empty array on any error.
 */
export async function findOrphanedClaudeProcesses(): Promise<number[]> {
  const command = [
    "Get-CimInstance Win32_Process",
    "| Where-Object { $_.CommandLine -match 'claude.*(haiku|output-format|stream-json)' }",
    "| Select-Object ProcessId,ParentProcessId",
    "| ConvertTo-Csv -NoTypeInformation",
  ].join(' ');

  let stdout: string;
  try {
    const result = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', command],
      { encoding: 'utf-8', timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND }
    );
    stdout = result.stdout;
  } catch {
    return [];
  }

  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);

  // Need header + at least one data line
  if (lines.length < 2) {
    return [];
  }

  const orphans: number[] = [];

  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    if (parts.length < 2) continue;

    const pid = parseInt(stripCsvQuotes(parts[0]), 10);
    const ppid = parseInt(stripCsvQuotes(parts[1]), 10);

    if (!isValidPid(pid) || !Number.isFinite(ppid)) continue;

    if (!isProcessAlive(ppid)) {
      orphans.push(pid);
    }
  }

  return orphans;
}
