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
import path from 'path';
import { getBunPath } from '../utils/bun-path.js';

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

async function killInner(): Promise<void> {
  if (!inner || !inner.pid) {
    log('No inner process to kill');
    return;
  }

  const pid = inner.pid;
  log(`Killing inner process tree (pid=${pid})`);

  if (isWindows) {
    // On Windows, use taskkill /T /F to kill entire process tree
    // This ensures all children (MCP server, ChromaSync, etc.) are killed
    // which is necessary to properly release the socket
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { timeout: 10000, stdio: 'ignore' });
      log(`taskkill completed for pid=${pid}`);
    } catch (error) {
      // Process may already be dead
      log(`taskkill failed (process may be dead): ${error}`);
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
