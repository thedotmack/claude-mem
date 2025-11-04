import path from 'path';
import { spawn } from 'child_process';
import { getPackageRoot } from './paths.js';

const FIXED_PORT = parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777', 10);

/**
 * Ensure worker service is running
 * Checks if worker is already running before attempting to start
 * This prevents unnecessary restarts that could interrupt mid-action processing
 */
export function ensureWorkerRunning(): void {
  const packageRoot = getPackageRoot();
  const pm2Path = path.join(packageRoot, 'node_modules', '.bin', 'pm2');
  const ecosystemPath = path.join(packageRoot, 'ecosystem.config.cjs');

  // Check if worker is already running
  const checkProcess = spawn(pm2Path, ['list', '--no-color'], {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'ignore']
  });

  let output = '';
  checkProcess.stdout?.on('data', (data) => {
    output += data.toString();
  });

  checkProcess.on('close', (code) => {
    // Check if 'claude-mem-worker' is in the PM2 list output and is 'online'
    const isRunning = output.includes('claude-mem-worker') && output.includes('online');

    if (!isRunning) {
      // Only start if not already running
      spawn(pm2Path, ['start', ecosystemPath], {
        cwd: packageRoot,
        stdio: 'ignore'
      });
    }
  });
}

/**
 * Get the worker port number (fixed port)
 */
export function getWorkerPort(): number {
  return FIXED_PORT;
}
