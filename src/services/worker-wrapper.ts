/**
 * Worker Wrapper - Manages worker process lifecycle
 *
 * This wrapper exists to solve the Windows zombie port problem.
 * The wrapper spawns the actual worker as a child process.
 * When restart/shutdown is requested, the wrapper kills the child
 * and respawns it (or exits), ensuring clean socket cleanup.
 *
 * The wrapper itself has no sockets, so Bun's socket cleanup bug
 * doesn't affect it.
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { getBunPath } from '../utils/bun-path.js';

const execAsync = promisify(require('child_process').exec);

const isWindows = process.platform === 'win32';

const SCRIPT_DIR = __dirname;
const INNER_SCRIPT = path.join(SCRIPT_DIR, 'worker-service.cjs');

let inner: ChildProcess | null = null;
let isShuttingDown = false;

function log(msg: string) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [wrapper] ${msg}`);
}

function spawnInner() {
  log(`Spawning inner worker: ${INNER_SCRIPT}`);

  // Resolve Bun executable path (handles cases where Bun not in PATH)
  const bunPath = getBunPath();
  if (!bunPath) {
    log('ERROR: Bun not found in PATH or common locations');
    process.exit(1);
  }
  log(`Using Bun executable: ${bunPath}`);

  inner = spawn(bunPath, [INNER_SCRIPT], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, CLAUDE_MEM_MANAGED: 'true' },
    cwd: path.dirname(INNER_SCRIPT),
  });

  inner.on('message', async (msg: { type: string }) => {
    if (msg.type === 'restart' || msg.type === 'shutdown') {
      // Both restart and shutdown: kill inner and exit wrapper
      // The hooks will start a fresh wrapper+inner if needed
      log(`${msg.type} requested by inner`);
      isShuttingDown = true;
      await killInner();
      log('Exiting wrapper');
      process.exit(0);
    }
  });

  inner.on('exit', (code, signal) => {
    log(`Inner exited with code=${code}, signal=${signal}`);
    inner = null;

    // If inner crashed unexpectedly (not during shutdown), respawn it
    if (!isShuttingDown && code !== 0) {
      log('Inner crashed, respawning in 1 second...');
      setTimeout(() => spawnInner(), 1000);
    }
  });

  inner.on('error', (err) => {
    log(`Inner error: ${err.message}`);
  });
}

/**
 * Recursively enumerate all descendant process IDs on Windows
 * Returns all child PIDs and their descendants
 */
async function getDescendantPids(parentPid: number): Promise<number[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  try {
    const cmd = `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${parentPid} } | Select-Object -ExpandProperty ProcessId"`;
    const { stdout } = await execAsync(cmd, { timeout: 5000 });
    const childPids = stdout
      .trim()
      .split('\n')
      .map((s: string) => parseInt(s.trim(), 10))
      .filter((n: number) => !isNaN(n));

    // Recursively get descendants of each child
    const allDescendants = [...childPids];
    for (const childPid of childPids) {
      const subDescendants = await getDescendantPids(childPid);
      allDescendants.push(...subDescendants);
    }

    return allDescendants;
  } catch (error) {
    log(`Failed to enumerate descendants of PID ${parentPid}: ${error}`);
    return [];
  }
}

async function killInner(): Promise<void> {
  if (!inner || !inner.pid) {
    log('No inner process to kill');
    return;
  }

  const pid = inner.pid;
  log(`Killing inner process tree (pid=${pid})`);

  if (isWindows) {
    // CRITICAL: Enumerate ALL descendants before killing to ensure complete cleanup
    // This prevents socket leaks by ensuring all child processes (ChromaSync, MCP, etc.) are terminated
    const descendantPids = await getDescendantPids(pid);
    log(`Process tree enumeration: root=${pid}, descendants=[${descendantPids.join(', ')}]`);

    // Kill root + all descendants with /T (tree) flag
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { timeout: 10000, stdio: 'ignore' });
      log(`taskkill completed for pid=${pid}`);
    } catch (error) {
      log(`taskkill failed, trying individual kills: ${error}`);
      // Fallback: kill each descendant individually in reverse order (children before parents)
      for (let i = descendantPids.length - 1; i >= 0; i--) {
        const dpid = descendantPids[i];
        try {
          execSync(`taskkill /PID ${dpid} /F`, { timeout: 2000, stdio: 'ignore' });
          log(`Killed descendant PID ${dpid}`);
        } catch (killError) {
          log(`Failed to kill descendant PID ${dpid} (may already be dead)`);
        }
      }
      // Finally try to kill the root process
      try {
        execSync(`taskkill /PID ${pid} /F`, { timeout: 2000, stdio: 'ignore' });
      } catch {
        log(`Failed to kill root PID ${pid} (may already be dead)`);
      }
    }
  } else {
    // On Unix, SIGTERM then SIGKILL
    inner.kill('SIGTERM');

    // Wait for exit with timeout
    const exitPromise = new Promise<void>(resolve => {
      if (!inner) {
        resolve();
        return;
      }
      inner.on('exit', () => resolve());
    });

    const timeoutPromise = new Promise<void>(resolve =>
      setTimeout(() => resolve(), 5000)
    );

    await Promise.race([exitPromise, timeoutPromise]);

    // Force kill if still alive
    if (inner && !inner.killed) {
      log('Inner did not exit gracefully, force killing');
      inner.kill('SIGKILL');
    }
  }

  // Wait for the process to fully exit
  await waitForProcessExit(pid, 5000);

  inner = null;
  log('Inner process terminated');
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0); // Check if process exists
      await new Promise(r => setTimeout(r, 100));
    } catch {
      // Process is dead
      return;
    }
  }

  log(`Timeout waiting for process ${pid} to exit`);
}

// Handle wrapper signals
process.on('SIGTERM', async () => {
  log('Wrapper received SIGTERM');
  isShuttingDown = true;
  await killInner();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('Wrapper received SIGINT');
  isShuttingDown = true;
  await killInner();
  process.exit(0);
});

// Start the inner worker
log('Wrapper starting');
spawnInner();
