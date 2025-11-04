import path from 'path';
import { spawn } from 'child_process';
import { getPackageRoot } from './paths.js';

const FIXED_PORT = parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777', 10);

/**
 * Ensure worker service is running
 * Just starts PM2 - no health checks, no retries, no delays
 * PM2 handles the rest (already running = no-op, failures = exit code)
 */
export function ensureWorkerRunning(): void {
  const packageRoot = getPackageRoot();
  const pm2Path = path.join(packageRoot, 'node_modules', '.bin', 'pm2');
  const ecosystemPath = path.join(packageRoot, 'ecosystem.config.cjs');

  spawn(pm2Path, ['start', ecosystemPath], {
    cwd: packageRoot,
    stdio: 'inherit'
  });
}

/**
 * Get the worker port number (fixed port)
 */
export function getWorkerPort(): number {
  return FIXED_PORT;
}
