/**
 * ProcessManager - PID files, signal handlers, and child process lifecycle management
 *
 * Extracted from worker-service.ts monolith to provide centralized process management.
 * Handles:
 * - PID file management for daemon coordination
 * - Signal handler registration for graceful shutdown
 * - Child process enumeration and cleanup (especially for Windows zombie port fix)
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { HOOK_TIMEOUTS } from '../../shared/hook-constants.js';

const execAsync = promisify(exec);

// Standard paths for PID file management
const DATA_DIR = path.join(homedir(), '.claude-mem');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');

export interface PidInfo {
  pid: number;
  port: number;
  startedAt: string;
}

/**
 * Write PID info to the standard PID file location
 */
export function writePidFile(info: PidInfo): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify(info, null, 2));
}

/**
 * Read PID info from the standard PID file location
 * Returns null if file doesn't exist or is corrupted
 */
export function readPidFile(): PidInfo | null {
  if (!existsSync(PID_FILE)) return null;

  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf-8'));
  } catch (error) {
    logger.warn('SYSTEM', 'Failed to parse PID file', { path: PID_FILE }, error as Error);
    return null;
  }
}

/**
 * Remove the PID file (called during shutdown)
 */
export function removePidFile(): void {
  if (!existsSync(PID_FILE)) return;

  try {
    unlinkSync(PID_FILE);
  } catch (error) {
    // [ANTI-PATTERN IGNORED]: Cleanup function - PID file removal failure is non-critical
    logger.warn('SYSTEM', 'Failed to remove PID file', { path: PID_FILE }, error as Error);
  }
}

/**
 * Get platform-adjusted timeout (Windows socket cleanup is slower)
 */
export function getPlatformTimeout(baseMs: number): number {
  const WINDOWS_MULTIPLIER = 2.0;
  return process.platform === 'win32' ? Math.round(baseMs * WINDOWS_MULTIPLIER) : baseMs;
}

/**
 * Get all child process PIDs
 * Used for cleanup to prevent zombie ports when parent exits
 * Now supports both Windows and Unix/Linux platforms
 */
export async function getChildProcesses(parentPid: number): Promise<number[]> {
  // SECURITY: Validate PID is a positive integer to prevent command injection
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    logger.warn('SYSTEM', 'Invalid parent PID for child process enumeration', { parentPid });
    return [];
  }

  const isWindows = process.platform === 'win32';

  try {
    if (isWindows) {
      // PowerShell Get-Process instead of WMIC (deprecated in Windows 11)
      const cmd = `powershell -NoProfile -NonInteractive -Command "Get-Process | Where-Object { \\$_.ParentProcessId -eq ${parentPid} } | Select-Object -ExpandProperty Id"`;
      const { stdout } = await execAsync(cmd, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });
      // PowerShell outputs just numbers (one per line), simpler than WMIC's "ProcessId=1234" format
      return stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && /^\d+$/.test(line))
        .map(line => parseInt(line, 10))
        .filter(pid => pid > 0);
    } else {
      // Unix/Linux: Use pgrep to find child processes
      const { stdout } = await execAsync(`pgrep -P ${parentPid} || true`, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });
      if (!stdout.trim()) {
        return [];
      }
      return stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && /^\d+$/.test(line))
        .map(line => parseInt(line, 10))
        .filter(pid => pid > 0);
    }
  } catch (error) {
    // Shutdown cleanup - failure is non-critical, continue without child process cleanup
    logger.error('SYSTEM', 'Failed to enumerate child processes', { parentPid }, error as Error);
    return [];
  }
}

/**
 * Force kill a process by PID
 * Windows: uses taskkill /F /T to kill process tree
 * Unix: uses SIGKILL
 */
export async function forceKillProcess(pid: number): Promise<void> {
  // SECURITY: Validate PID is a positive integer to prevent command injection
  if (!Number.isInteger(pid) || pid <= 0) {
    logger.warn('SYSTEM', 'Invalid PID for force kill', { pid });
    return;
  }

  try {
    if (process.platform === 'win32') {
      // /T kills entire process tree, /F forces termination
      await execAsync(`taskkill /PID ${pid} /T /F`, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    logger.info('SYSTEM', 'Killed process', { pid });
  } catch (error) {
    // [ANTI-PATTERN IGNORED]: Shutdown cleanup - process already exited, continue
    logger.debug('SYSTEM', 'Process already exited during force kill', { pid }, error as Error);
  }
}

/**
 * Known init-like process names that adopt orphaned processes
 * In containers, the init process may not be PID 1 (e.g., tini, dumb-init)
 */
const KNOWN_INIT_PROCESS_NAMES = ['init', 'systemd', 'tini', 'dumb-init', 'docker-init', 's6-svscan', 'runsv'];

/**
 * Check if a given PID is an init-like process (adopts orphans)
 * This handles containers where init may not be PID 1
 */
async function isInitLikeProcess(ppid: number): Promise<boolean> {
  // PID 1 is always init on Unix
  if (ppid === 1) return true;

  // PID 0 is the kernel scheduler, not a valid parent for user processes
  if (ppid === 0) return true;

  try {
    let comm: string;

    if (process.platform === 'darwin') {
      // macOS: Use ps to get process name (no /proc filesystem)
      const { stdout } = await execAsync(`ps -o comm= -p ${ppid} 2>/dev/null || echo "unknown"`, { timeout: 5000 });
      comm = stdout.trim().toLowerCase();
      // macOS ps returns full path, extract basename
      comm = comm.split('/').pop() || comm;
    } else {
      // Linux: Use /proc filesystem for efficiency
      const { stdout } = await execAsync(`cat /proc/${ppid}/comm 2>/dev/null || echo "unknown"`, { timeout: 5000 });
      comm = stdout.trim().toLowerCase();
    }

    if (KNOWN_INIT_PROCESS_NAMES.includes(comm)) {
      logger.debug('SYSTEM', 'Parent is init-like process', { ppid, comm });
      return true;
    }

    return false;
  } catch {
    // If we can't determine, only consider PID 1 as init (safe default)
    return ppid === 1;
  }
}

/**
 * Check if a process is orphaned (has PPID of 1 or init-like process)
 * On Unix, orphaned processes are adopted by init (PID 1) or container init (tini, dumb-init, etc.)
 * On Windows, we check if the parent process exists
 *
 * CRITICAL FIX: This prevents killing ACTIVE Claude processes that have
 * a valid parent. Only truly orphaned processes (adopted by init) should be killed.
 *
 * SAFETY: On any error or uncertainty, returns FALSE to avoid killing active processes.
 */
export async function isOrphanedProcess(pid: number): Promise<boolean> {
  // SECURITY: Validate PID is a positive integer
  if (!Number.isInteger(pid) || pid <= 0) {
    return false; // Invalid PID, don't kill
  }

  const isWindows = process.platform === 'win32';

  try {
    if (isWindows) {
      // Windows: Check if parent process exists
      const cmd = `powershell -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId"`;
      const { stdout } = await execAsync(cmd, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });
      const ppid = parseInt(stdout.trim(), 10);

      // SAFETY: Can't determine parent = assume NOT orphaned
      if (isNaN(ppid) || ppid <= 0) {
        logger.debug('SYSTEM', 'Cannot determine PPID, assuming not orphaned (safe)', { pid });
        return false;
      }

      // Check if parent is still alive
      try {
        const parentCheck = `powershell -NoProfile -NonInteractive -Command "Get-Process -Id ${ppid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"`;
        const { stdout: parentStdout } = await execAsync(parentCheck, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });
        const parentExists = !!parentStdout.trim();

        if (!parentExists) {
          logger.debug('SYSTEM', 'Parent process does not exist, process is orphaned', { pid, ppid });
          return true;
        }
        return false;
      } catch {
        // SAFETY: Parent check failed = assume NOT orphaned
        logger.debug('SYSTEM', 'Parent check failed, assuming not orphaned (safe)', { pid, ppid });
        return false;
      }
    } else {
      // Unix/Linux: Get PPID and check if it's init or init-like
      const { stdout } = await execAsync(`ps -o ppid= -p ${pid} 2>/dev/null`, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });
      const ppid = parseInt(stdout.trim(), 10);

      // SAFETY: Can't determine PPID = assume NOT orphaned
      if (isNaN(ppid) || ppid < 0) {
        logger.debug('SYSTEM', 'Cannot determine PPID, assuming not orphaned (safe)', { pid });
        return false;
      }

      // Check if parent is init or init-like (handles containers)
      const isOrphaned = await isInitLikeProcess(ppid);
      if (isOrphaned) {
        logger.debug('SYSTEM', 'Process is orphaned (parent is init-like)', { pid, ppid });
      }
      return isOrphaned;
    }
  } catch (error) {
    // SAFETY: Any error = assume NOT orphaned to avoid killing active processes
    logger.debug('SYSTEM', 'Failed to check if process is orphaned, assuming active (safe)', { pid }, error as Error);
    return false;
  }
}

/**
 * Wait for processes to fully exit
 */
export async function waitForProcessesExit(pids: number[], timeoutMs: number): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const stillAlive = pids.filter(pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // [ANTI-PATTERN IGNORED]: Tight loop checking 100s of PIDs every 100ms during cleanup
        return false;
      }
    });

    if (stillAlive.length === 0) {
      logger.info('SYSTEM', 'All child processes exited');
      return;
    }

    logger.debug('SYSTEM', 'Waiting for processes to exit', { stillAlive });
    await new Promise(r => setTimeout(r, 100));
  }

  logger.warn('SYSTEM', 'Timeout waiting for child processes to exit');
}

/**
 * Clean up orphaned chroma-mcp processes from previous worker sessions
 * Prevents process accumulation and memory leaks
 */
export async function cleanupOrphanedProcesses(): Promise<void> {
  const isWindows = process.platform === 'win32';
  const pids: number[] = [];
  const currentPid = process.pid;

  try {
    if (isWindows) {
      // Windows: Use PowerShell Get-CimInstance instead of WMIC (deprecated in Windows 11)
      const cmd = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { \\$_.Name -like '*python*' -and \\$_.CommandLine -like '*chroma-mcp*' } | Select-Object -ExpandProperty ProcessId"`;
      const { stdout } = await execAsync(cmd, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });

      if (!stdout.trim()) {
        logger.debug('SYSTEM', 'No orphaned chroma-mcp processes found (Windows)');
        return;
      }

      // PowerShell outputs just numbers (one per line), simpler than WMIC's "ProcessId=1234" format
      const lines = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && /^\d+$/.test(line));

      for (const line of lines) {
        const pid = parseInt(line, 10);
        // SECURITY: Validate PID is positive integer and not ourselves
        if (!isNaN(pid) && Number.isInteger(pid) && pid > 0 && pid !== currentPid) {
          pids.push(pid);
        }
      }
    } else {
      // Unix: Use pgrep -f for cleaner pattern matching (avoids grep -v grep anti-pattern)
      const { stdout } = await execAsync('pgrep -f "chroma-mcp" || true', { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });

      if (!stdout.trim()) {
        logger.debug('SYSTEM', 'No orphaned chroma-mcp processes found (Unix)');
        return;
      }

      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const pid = parseInt(line.trim(), 10);
        // SECURITY: Validate PID is positive integer and not ourselves
        if (!isNaN(pid) && Number.isInteger(pid) && pid > 0 && pid !== currentPid) {
          pids.push(pid);
        }
      }
    }
  } catch (error) {
    // Orphan cleanup is non-critical - log and continue
    logger.warn('SYSTEM', 'Failed to enumerate orphaned processes', {}, error as Error);
    return;
  }

  if (pids.length === 0) {
    return;
  }

  // CRITICAL FIX: Filter to only truly orphaned processes (PPID === 1)
  // This prevents killing ACTIVE processes that have a valid parent
  const orphanedPids: number[] = [];
  for (const pid of pids) {
    const orphaned = await isOrphanedProcess(pid);
    if (orphaned) {
      orphanedPids.push(pid);
    } else {
      logger.debug('SYSTEM', 'Skipping non-orphaned chroma-mcp process', { pid });
    }
  }

  if (orphanedPids.length === 0) {
    logger.debug('SYSTEM', 'No truly orphaned chroma-mcp processes found', {
      candidateCount: pids.length,
      orphanedCount: 0
    });
    return;
  }

  logger.info('SYSTEM', 'Cleaning up orphaned chroma-mcp processes', {
    platform: isWindows ? 'Windows' : 'Unix',
    candidateCount: pids.length,
    orphanedCount: orphanedPids.length,
    pids: orphanedPids
  });

  // Kill only verified orphaned processes
  if (isWindows) {
    for (const pid of orphanedPids) {
      // SECURITY: Double-check PID validation before using in taskkill command
      if (!Number.isInteger(pid) || pid <= 0) {
        logger.warn('SYSTEM', 'Skipping invalid PID', { pid });
        continue;
      }
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND, stdio: 'ignore' });
      } catch (error) {
        // [ANTI-PATTERN IGNORED]: Cleanup loop - process may have exited, continue to next PID
        logger.debug('SYSTEM', 'Failed to kill process, may have already exited', { pid }, error as Error);
      }
    }
  } else {
    for (const pid of orphanedPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        // [ANTI-PATTERN IGNORED]: Cleanup loop - process may have exited, continue to next PID
        logger.debug('SYSTEM', 'Process already exited', { pid }, error as Error);
      }
    }
  }

  logger.info('SYSTEM', 'Orphaned processes cleaned up', { count: orphanedPids.length });
}

/**
 * Clean up orphaned Claude CLI processes spawned by SDK agents
 * These are processes with arguments like "--output-format stream-json"
 * that were spawned for observation generation but not properly terminated
 *
 * FIX: This addresses the memory leak where SDK-spawned Claude processes
 * accumulate over time because they're not terminated when sessions end
 */
export async function cleanupOrphanedClaudeProcesses(): Promise<void> {
  const isWindows = process.platform === 'win32';
  const pids: number[] = [];
  const currentPid = process.pid;

  try {
    if (isWindows) {
      // Windows: Find Claude processes with stream-json output format (SDK signature)
      const cmd = `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { \\$_.Name -like '*claude*' -and \\$_.CommandLine -like '*--output-format*stream-json*' } | Select-Object -ExpandProperty ProcessId"`;
      const { stdout } = await execAsync(cmd, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });

      if (!stdout.trim()) {
        logger.debug('SYSTEM', 'No orphaned Claude processes found (Windows)');
        return;
      }

      const lines = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && /^\d+$/.test(line));

      for (const line of lines) {
        const pid = parseInt(line, 10);
        // SECURITY: Validate PID is positive integer and not ourselves
        if (!isNaN(pid) && Number.isInteger(pid) && pid > 0 && pid !== currentPid) {
          pids.push(pid);
        }
      }
    } else {
      // Unix/Linux: Use pgrep -f for cleaner pattern matching (avoids grep -v grep anti-pattern)
      // These are spawned by @anthropic-ai/claude-agent-sdk for observation generation
      const { stdout } = await execAsync('pgrep -f "claude.*--output-format.*stream-json" || true', { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND });

      if (!stdout.trim()) {
        logger.debug('SYSTEM', 'No orphaned Claude processes found (Unix)');
        return;
      }

      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const pid = parseInt(line.trim(), 10);
        // SECURITY: Validate PID is positive integer and not ourselves
        if (!isNaN(pid) && Number.isInteger(pid) && pid > 0 && pid !== currentPid) {
          pids.push(pid);
        }
      }
    }
  } catch (error) {
    // Orphan cleanup is non-critical - log and continue
    logger.warn('SYSTEM', 'Failed to enumerate orphaned Claude processes', {}, error as Error);
    return;
  }

  if (pids.length === 0) {
    return;
  }

  // CRITICAL FIX: Filter to only truly orphaned processes (PPID === 1)
  // This prevents killing ACTIVE Claude Code processes that the user is interacting with!
  // The bug was: this function was killing ALL Claude processes matching the pattern,
  // including the ones actively being used for the current session.
  const orphanedPids: number[] = [];
  for (const pid of pids) {
    const orphaned = await isOrphanedProcess(pid);
    if (orphaned) {
      orphanedPids.push(pid);
    } else {
      logger.debug('SYSTEM', 'Skipping non-orphaned Claude process (has active parent)', { pid });
    }
  }

  if (orphanedPids.length === 0) {
    logger.debug('SYSTEM', 'No truly orphaned Claude processes found', {
      candidateCount: pids.length,
      orphanedCount: 0
    });
    return;
  }

  logger.info('SYSTEM', 'Cleaning up orphaned Claude processes', {
    platform: isWindows ? 'Windows' : 'Unix',
    candidateCount: pids.length,
    orphanedCount: orphanedPids.length,
    pids: orphanedPids
  });

  // Kill only verified orphaned processes - use SIGTERM first for graceful shutdown, then SIGKILL
  if (isWindows) {
    for (const pid of orphanedPids) {
      if (!Number.isInteger(pid) || pid <= 0) {
        logger.warn('SYSTEM', 'Skipping invalid PID', { pid });
        continue;
      }
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { timeout: HOOK_TIMEOUTS.POWERSHELL_COMMAND, stdio: 'ignore' });
      } catch (error) {
        logger.debug('SYSTEM', 'Failed to kill Claude process, may have already exited', { pid }, error as Error);
      }
    }
  } else {
    for (const pid of orphanedPids) {
      try {
        // Try SIGTERM first for graceful shutdown
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        logger.debug('SYSTEM', 'Claude process already exited', { pid }, error as Error);
      }
    }

    // Wait a moment for graceful shutdown
    await new Promise(r => setTimeout(r, 500));

    // Force kill any remaining processes
    for (const pid of orphanedPids) {
      try {
        process.kill(pid, 0); // Check if still alive
        process.kill(pid, 'SIGKILL'); // Force kill if still running
        logger.debug('SYSTEM', 'Force killed Claude process', { pid });
      } catch (error) {
        // Process already exited, which is expected
      }
    }
  }

  logger.info('SYSTEM', 'Orphaned Claude processes cleaned up', { count: orphanedPids.length });
}

/**
 * Spawn a detached daemon process
 * Returns the child PID or undefined if spawn failed
 *
 * On Windows, uses WMIC to spawn a truly independent process that
 * survives parent exit without console popups. WMIC creates processes
 * that are not associated with the parent's console.
 *
 * On Unix, uses standard detached spawn.
 *
 * PID file is written by the worker itself after listen() succeeds,
 * not by the spawner (race-free, works on all platforms).
 */
export function spawnDaemon(
  scriptPath: string,
  port: number,
  extraEnv: Record<string, string> = {}
): number | undefined {
  const isWindows = process.platform === 'win32';
  const env = {
    ...process.env,
    CLAUDE_MEM_WORKER_PORT: String(port),
    ...extraEnv
  };

  if (isWindows) {
    // Use WMIC to spawn a process that's independent of the parent console
    // This avoids the console popup that occurs with detached: true
    // Paths must be individually quoted for WMIC when they contain spaces
    const execPath = process.execPath;
    const script = scriptPath;
    // WMIC command format: wmic process call create "\"path1\" \"path2\" args"
    const command = `wmic process call create "\\"${execPath}\\" \\"${script}\\" --daemon"`;

    try {
      execSync(command, {
        stdio: 'ignore',
        windowsHide: true
      });
      // WMIC returns immediately, we can't get the spawned PID easily
      // Worker will write its own PID file after listen()
      return 0;
    } catch {
      return undefined;
    }
  }

  // Unix: standard detached spawn
  const child = spawn(process.execPath, [scriptPath, '--daemon'], {
    detached: true,
    stdio: 'ignore',
    env
  });

  if (child.pid === undefined) {
    return undefined;
  }

  child.unref();

  return child.pid;
}

/**
 * Create signal handler factory for graceful shutdown
 * Returns a handler function that can be passed to process.on('SIGTERM') etc.
 */
export function createSignalHandler(
  shutdownFn: () => Promise<void>,
  isShuttingDownRef: { value: boolean }
): (signal: string) => Promise<void> {
  return async (signal: string) => {
    if (isShuttingDownRef.value) {
      logger.warn('SYSTEM', `Received ${signal} but shutdown already in progress`);
      return;
    }
    isShuttingDownRef.value = true;

    logger.info('SYSTEM', `Received ${signal}, shutting down...`);
    try {
      await shutdownFn();
      process.exit(0);
    } catch (error) {
      // Top-level signal handler - log any shutdown error and exit
      logger.error('SYSTEM', 'Error during shutdown', {}, error as Error);
      // Exit gracefully: Windows Terminal won't keep tab open on exit 0
      // Even on shutdown errors, exit cleanly to prevent tab accumulation
      process.exit(0);
    }
  };
}
