/**
 * ProcessRegistry: Track spawned Claude subprocesses
 *
 * Fixes Issue #737: Claude haiku subprocesses don't terminate properly,
 * causing zombie process accumulation (user reported 155 processes / 51GB RAM).
 *
 * Root causes:
 * 1. SDK's SpawnedProcess interface hides subprocess PIDs
 * 2. deleteSession() doesn't verify subprocess exit before cleanup
 * 3. abort() is fire-and-forget with no confirmation
 *
 * Solution:
 * - Use SDK's spawnClaudeCodeProcess option to capture PIDs
 * - Track all spawned processes with session association
 * - Verify exit on session deletion with timeout + SIGKILL escalation
 * - Safety net orphan reaper runs every 5 minutes
 */

import { spawn, exec, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { getSupervisor } from '../../supervisor/index.js';

const execAsync = promisify(exec);

interface TrackedProcess {
  pid: number;
  sessionDbId: number;
  spawnedAt: number;
  process: ChildProcess;
}

function getTrackedProcesses(): TrackedProcess[] {
  return getSupervisor().getRegistry()
    .getAll()
    .filter(record => record.type === 'sdk')
    .map((record) => {
      const processRef = getSupervisor().getRegistry().getRuntimeProcess(record.id);
      if (!processRef) {
        return null;
      }

      return {
        pid: record.pid,
        sessionDbId: Number(record.sessionId),
        spawnedAt: Date.parse(record.startedAt),
        process: processRef
      };
    })
    .filter((value): value is TrackedProcess => value !== null);
}

/**
 * Register a spawned process in the registry
 */
export function registerProcess(pid: number, sessionDbId: number, process: ChildProcess): void {
  getSupervisor().registerProcess(`sdk:${sessionDbId}:${pid}`, {
    pid,
    type: 'sdk',
    sessionId: sessionDbId,
    startedAt: new Date().toISOString()
  }, process);
  logger.info('PROCESS', `Registered PID ${pid} for session ${sessionDbId}`, { pid, sessionDbId });
}

/**
 * Unregister a process from the registry and notify pool waiters
 */
export function unregisterProcess(pid: number): void {
  for (const record of getSupervisor().getRegistry().getByPid(pid)) {
    if (record.type === 'sdk') {
      getSupervisor().unregisterProcess(record.id);
    }
  }
  logger.debug('PROCESS', `Unregistered PID ${pid}`, { pid });
  // Notify waiters that a pool slot may be available
  notifySlotAvailable();
}

/**
 * Get process info by session ID
 * Warns if multiple processes found (indicates race condition)
 */
export function getProcessBySession(sessionDbId: number): TrackedProcess | undefined {
  const matches = getTrackedProcesses().filter(info => info.sessionDbId === sessionDbId);
  if (matches.length > 1) {
    logger.warn('PROCESS', `Multiple processes found for session ${sessionDbId}`, {
      count: matches.length,
      pids: matches.map(m => m.pid)
    });
  }
  return matches[0];
}

/**
 * Get count of active processes in the registry
 */
export function getActiveCount(): number {
  return getSupervisor().getRegistry().getAll().filter(record => record.type === 'sdk').length;
}

// Waiters for pool slots - resolved when a process exits and frees a slot
const slotWaiters: Array<() => void> = [];

/**
 * Notify waiters that a slot has freed up
 */
function notifySlotAvailable(): void {
  const waiter = slotWaiters.shift();
  if (waiter) waiter();
}

/**
 * Wait for a pool slot to become available (promise-based, not polling)
 * @param maxConcurrent Max number of concurrent agents
 * @param timeoutMs Max time to wait before giving up
 * @param evictIdleSession Optional callback to evict an idle session when all slots are full (#1868)
 */
const TOTAL_PROCESS_HARD_CAP = 10;

export async function waitForSlot(
  maxConcurrent: number,
  timeoutMs: number = 60_000,
  evictIdleSession?: () => boolean
): Promise<void> {
  // Hard cap: refuse to spawn if too many processes exist regardless of pool accounting
  const activeCount = getActiveCount();
  if (activeCount >= TOTAL_PROCESS_HARD_CAP) {
    throw new Error(`Hard cap exceeded: ${activeCount} processes in registry (cap=${TOTAL_PROCESS_HARD_CAP}). Refusing to spawn more.`);
  }

  if (activeCount < maxConcurrent) return;

  // Try to evict an idle session before waiting (#1868)
  // Idle sessions hold pool slots during their 3-min idle timeout, blocking new sessions
  // that would timeout after 60s. Eviction aborts the idle session asynchronously —
  // the freed slot is picked up by the waiter mechanism below.
  if (evictIdleSession) {
    const evicted = evictIdleSession();
    if (evicted) {
      logger.info('PROCESS', 'Evicted idle session to free pool slot for waiting request');
    }
  }

  logger.info('PROCESS', `Pool limit reached (${activeCount}/${maxConcurrent}), waiting for slot...`);

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const idx = slotWaiters.indexOf(onSlot);
      if (idx >= 0) slotWaiters.splice(idx, 1);
      reject(new Error(`Timed out waiting for agent pool slot after ${timeoutMs}ms`));
    }, timeoutMs);

    const onSlot = () => {
      clearTimeout(timeout);
      if (getActiveCount() < maxConcurrent) {
        resolve();
      } else {
        // Still full, re-queue
        slotWaiters.push(onSlot);
      }
    };

    slotWaiters.push(onSlot);
  });
}

/**
 * Get all active PIDs (for debugging)
 */
export function getActiveProcesses(): Array<{ pid: number; sessionDbId: number; ageMs: number }> {
  const now = Date.now();
  return getTrackedProcesses().map(info => ({
    pid: info.pid,
    sessionDbId: info.sessionDbId,
    ageMs: now - info.spawnedAt
  }));
}

/**
 * Wait for a process to exit with timeout, escalating to SIGKILL if needed
 * Uses event-based waiting instead of polling to avoid CPU overhead
 */
export async function ensureProcessExit(tracked: TrackedProcess, timeoutMs: number = 5000): Promise<void> {
  const { pid, process: proc } = tracked;

  // Already exited? Only trust exitCode, NOT proc.killed
  // proc.killed only means Node sent a signal — the process can still be alive
  if (proc.exitCode !== null) {
    unregisterProcess(pid);
    return;
  }

  // Wait for graceful exit with timeout using event-based approach
  const exitPromise = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
  });

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });

  await Promise.race([exitPromise, timeoutPromise]);

  // Check if exited gracefully — only trust exitCode
  if (proc.exitCode !== null) {
    unregisterProcess(pid);
    return;
  }

  // Timeout: escalate to SIGKILL
  logger.warn('PROCESS', `PID ${pid} did not exit after ${timeoutMs}ms, sending SIGKILL`, { pid, timeoutMs });
  try {
    proc.kill('SIGKILL');
  } catch {
    // Already dead
  }

  // Wait for SIGKILL to take effect — use exit event with 1s timeout instead of blind sleep
  const sigkillExitPromise = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
  });
  const sigkillTimeout = new Promise<void>((resolve) => {
    setTimeout(resolve, 1000);
  });
  await Promise.race([sigkillExitPromise, sigkillTimeout]);
  unregisterProcess(pid);
}

/**
 * Kill idle daemon children (claude processes spawned by worker-service)
 *
 * These are SDK-spawned claude processes that completed their work but
 * didn't terminate properly. They remain as children of the worker-service
 * daemon, consuming memory without doing useful work.
 *
 * Criteria for cleanup:
 * - Process name is "claude"
 * - Parent PID is the worker-service daemon (this process)
 * - Process has 0% CPU (idle)
 * - Process has been running for more than 2 minutes
 */
async function killIdleDaemonChildren(): Promise<number> {
  if (process.platform === 'win32') {
    // Windows: Different process model, skip for now
    return 0;
  }

  const daemonPid = process.pid;
  let killed = 0;

  try {
    const { stdout } = await execAsync(
      'ps -eo pid,ppid,%cpu,etime,comm 2>/dev/null | grep "claude$" || true'
    );

    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;

      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;

      const [pidStr, ppidStr, cpuStr, etime] = parts;
      const pid = parseInt(pidStr, 10);
      const ppid = parseInt(ppidStr, 10);
      const cpu = parseFloat(cpuStr);

      // Skip if not a child of this daemon
      if (ppid !== daemonPid) continue;

      // Skip if actively using CPU
      if (cpu > 0) continue;

      // Parse elapsed time to minutes
      // Formats: MM:SS, HH:MM:SS, D-HH:MM:SS
      let minutes = 0;
      const dayMatch = etime.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
      const hourMatch = etime.match(/^(\d+):(\d+):(\d+)$/);
      const minMatch = etime.match(/^(\d+):(\d+)$/);

      if (dayMatch) {
        minutes = parseInt(dayMatch[1], 10) * 24 * 60 +
                  parseInt(dayMatch[2], 10) * 60 +
                  parseInt(dayMatch[3], 10);
      } else if (hourMatch) {
        minutes = parseInt(hourMatch[1], 10) * 60 +
                  parseInt(hourMatch[2], 10);
      } else if (minMatch) {
        minutes = parseInt(minMatch[1], 10);
      }

      // Kill if idle for more than 1 minute
      if (minutes >= 1) {
        logger.info('PROCESS', `Killing idle daemon child PID ${pid} (idle ${minutes}m)`, { pid, minutes });
        try {
          process.kill(pid, 'SIGKILL');
          killed++;
        } catch {
          // Already dead or permission denied
        }
      }
    }
  } catch {
    // No matches or command error
  }

  return killed;
}

/**
 * Kill system-level orphans (ppid=1 on Unix)
 * These are Claude processes whose parent died unexpectedly
 */
async function killSystemOrphans(): Promise<number> {
  if (process.platform === 'win32') {
    return 0; // Windows doesn't have ppid=1 orphan concept
  }

  try {
    const { stdout } = await execAsync(
      'ps -eo pid,ppid,args 2>/dev/null | grep -E "claude.*haiku|claude.*output-format" | grep -v grep'
    );

    let killed = 0;
    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;
      const match = line.trim().match(/^(\d+)\s+(\d+)/);
      if (match && parseInt(match[2]) === 1) { // ppid=1 = orphan
        const orphanPid = parseInt(match[1]);
        logger.warn('PROCESS', `Killing system orphan PID ${orphanPid}`, { pid: orphanPid });
        try {
          process.kill(orphanPid, 'SIGKILL');
          killed++;
        } catch {
          // Already dead or permission denied
        }
      }
    }
    return killed;
  } catch {
    return 0; // No matches or error
  }
}

/**
 * Reap orphaned processes - both registry-tracked and system-level
 */
export async function reapOrphanedProcesses(activeSessionIds: Set<number>): Promise<number> {
  let killed = 0;

  // Registry-based: kill processes for dead sessions
  for (const record of getSupervisor().getRegistry().getAll().filter(entry => entry.type === 'sdk')) {
    const pid = record.pid;
    const sessionDbId = Number(record.sessionId);
    const processRef = getSupervisor().getRegistry().getRuntimeProcess(record.id);

    if (activeSessionIds.has(sessionDbId)) continue; // Active = safe

    logger.warn('PROCESS', `Killing orphan PID ${pid} (session ${sessionDbId} gone)`, { pid, sessionDbId });
    try {
      if (processRef) {
        processRef.kill('SIGKILL');
      } else {
        process.kill(pid, 'SIGKILL');
      }
      killed++;
    } catch {
      // Already dead
    }
    getSupervisor().unregisterProcess(record.id);
    notifySlotAvailable();
  }

  // System-level: find ppid=1 orphans
  killed += await killSystemOrphans();

  // Daemon children: find idle SDK processes that didn't terminate
  killed += await killIdleDaemonChildren();

  return killed;
}

/**
 * Create a custom spawn function for SDK that captures PIDs
 *
 * The SDK's spawnClaudeCodeProcess option allows us to intercept subprocess
 * creation and capture the PID before the SDK hides it.
 *
 * NOTE: Session isolation is handled via the `cwd` option in SDKAgent.ts,
 * NOT via CLAUDE_CONFIG_DIR (which breaks authentication).
 */
export function createPidCapturingSpawn(sessionDbId: number) {
  return (spawnOptions: {
    command: string;
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }) => {
    // Kill any existing process for this session before spawning a new one.
    // Multiple processes sharing the same --resume UUID waste API credits and
    // can conflict with each other (Issue #1590).
    const existing = getProcessBySession(sessionDbId);
    if (existing && existing.process.exitCode === null) {
      logger.warn('PROCESS', `Killing duplicate process PID ${existing.pid} before spawning new one for session ${sessionDbId}`, {
        existingPid: existing.pid,
        sessionDbId
      });
      let exited = false;
      try {
        existing.process.kill('SIGTERM');
        exited = existing.process.exitCode !== null;
      } catch (error: unknown) {
        // Already dead — safe to unregister immediately
        if (error instanceof Error) {
          logger.warn('WORKER', `Failed to kill duplicate process PID ${existing.pid}, likely already dead`, { existingPid: existing.pid, sessionDbId }, error);
        }
        exited = true;
      }

      if (exited) {
        unregisterProcess(existing.pid);
      }
      // If still alive, the 'exit' handler (line ~440) will unregister it.
    }

    getSupervisor().assertCanSpawn('claude sdk');

    // On Windows, use cmd.exe wrapper for .cmd files to properly handle paths with spaces
    const useCmdWrapper = process.platform === 'win32' && spawnOptions.command.endsWith('.cmd');
    const env = sanitizeEnv(spawnOptions.env ?? process.env);

    // Filter empty string args AND their preceding flag (Issue #2049).
    // The Agent SDK emits ["--setting-sources", ""] when settingSources defaults to [].
    // Simply dropping "" leaves an orphan --setting-sources that consumes the next
    // flag (e.g. --permission-mode) as its value, crashing Claude Code 2.1.109+ with
    // "Invalid setting source: --permission-mode". Drop the flag too so the SDK
    // default (no setting sources) is preserved by omission.
    const args: string[] = [];
    for (const arg of spawnOptions.args) {
      if (arg === '') {
        if (args.length > 0 && args[args.length - 1].startsWith('--')) {
          args.pop();
        }
        continue;
      }
      args.push(arg);
    }

    const child = useCmdWrapper
      ? spawn('cmd.exe', ['/d', '/c', spawnOptions.command, ...args], {
          cwd: spawnOptions.cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: spawnOptions.signal,
          windowsHide: true
        })
      : spawn(spawnOptions.command, args, {
          cwd: spawnOptions.cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: spawnOptions.signal, // CRITICAL: Pass signal for AbortController integration
          windowsHide: true
        });

    // Capture stderr for debugging spawn failures
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        logger.debug('SDK_SPAWN', `[session-${sessionDbId}] stderr: ${data.toString().trim()}`);
      });
    }

    // Register PID
    if (child.pid) {
      registerProcess(child.pid, sessionDbId, child);

      // Auto-unregister on exit
      child.on('exit', (code: number | null, signal: string | null) => {
        if (code !== 0) {
          logger.warn('SDK_SPAWN', `[session-${sessionDbId}] Claude process exited`, { code, signal, pid: child.pid });
        }
        if (child.pid) {
          unregisterProcess(child.pid);
        }
      });
    }

    // Return SDK-compatible interface
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      get killed() { return child.killed; },
      get exitCode() { return child.exitCode; },
      kill: child.kill.bind(child),
      on: child.on.bind(child),
      once: child.once.bind(child),
      off: child.off.bind(child)
    };
  };
}

/**
 * Start the orphan reaper interval
 * Returns cleanup function to stop the interval
 */
export function startOrphanReaper(getActiveSessionIds: () => Set<number>, intervalMs: number = 30 * 1000): () => void {
  const interval = setInterval(async () => {
    try {
      const activeIds = getActiveSessionIds();
      const killed = await reapOrphanedProcesses(activeIds);
      if (killed > 0) {
        logger.info('PROCESS', `Reaper cleaned up ${killed} orphaned processes`, { killed });
      }
    } catch (error) {
      if (error instanceof Error) {
        logger.error('WORKER', 'Reaper error', {}, error);
      } else {
        logger.error('WORKER', 'Reaper error', { rawError: String(error) });
      }
    }
  }, intervalMs);

  // Return cleanup function
  return () => clearInterval(interval);
}
