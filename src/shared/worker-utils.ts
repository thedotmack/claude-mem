import path from 'path';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { getPackageRoot } from './paths.js';

const FIXED_PORT = parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777', 10);
const HEALTH_CHECK_URL = `http://127.0.0.1:${FIXED_PORT}/health`;

/**
 * Check if worker is responding by hitting health endpoint
 */
async function checkWorkerHealth(): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_CHECK_URL, {
      signal: AbortSignal.timeout(500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure worker service is running with retry logic
 * Auto-starts worker if not running (v4.0.0 feature)
 *
 * @returns true if worker is responding, false if failed to start
 */
export async function ensureWorkerRunning(): Promise<boolean> {
  try {
    // Check if worker is already responding
    if (await checkWorkerHealth()) {
      return true;
    }

    console.error('[claude-mem] Worker not responding, starting...');

    // Find worker service path
    const packageRoot = getPackageRoot();
    const workerPath = path.join(packageRoot, 'dist', 'worker-service.cjs');

    if (!existsSync(workerPath)) {
      console.error(`[claude-mem] Worker service not found at ${workerPath}`);
      return false;
    }

    // Try to start with PM2 first (preferred for production)
    const ecosystemPath = path.join(packageRoot, 'ecosystem.config.cjs');
    if (existsSync(ecosystemPath)) {
      try {
        spawn('pm2', ['start', ecosystemPath], {
          detached: true,
          stdio: 'ignore',
          cwd: packageRoot
        }).unref();
        console.error('[claude-mem] Worker started with PM2');
      } catch (pm2Error) {
        console.error('[claude-mem] PM2 not available, using direct spawn');
        // Fallback: spawn worker directly
        spawn('node', [workerPath], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, NODE_ENV: 'production', CLAUDE_MEM_WORKER_PORT: FIXED_PORT.toString() }
        }).unref();
        console.error('[claude-mem] Worker started in background');
      }
    } else {
      // No PM2 config, spawn directly
      spawn('node', [workerPath], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, NODE_ENV: 'production', CLAUDE_MEM_WORKER_PORT: FIXED_PORT.toString() }
      }).unref();
      console.error('[claude-mem] Worker started in background');
    }

    // Wait for worker to become healthy (retry 3 times with 500ms delay)
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (await checkWorkerHealth()) {
        console.error('[claude-mem] Worker is healthy');
        return true;
      }
    }

    console.error('[claude-mem] Worker failed to become healthy after startup');
    return false;

  } catch (error: any) {
    console.error(`[claude-mem] Failed to start worker: ${error.message}`);
    return false;
  }
}

/**
 * Check if worker is currently running
 */
export async function isWorkerRunning(): Promise<boolean> {
  return checkWorkerHealth();
}

/**
 * Get the worker port number (fixed port)
 */
export function getWorkerPort(): number {
  return FIXED_PORT;
}
