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
    const workerPath = path.join(packageRoot, 'plugin', 'scripts', 'worker-service.cjs');

    if (!existsSync(workerPath)) {
      console.error(`[claude-mem] Worker service not found at ${workerPath}`);
      return false;
    }

    // Start worker with PM2 (bundled dependency)
    const ecosystemPath = path.join(packageRoot, 'ecosystem.config.cjs');
    const pm2Path = path.join(packageRoot, 'node_modules', '.bin', 'pm2');

    // Fail loudly if bundled pm2 is missing
    if (!existsSync(pm2Path)) {
      throw new Error(
        `PM2 binary not found at ${pm2Path}. ` +
        `This is a bundled dependency - try running: npm install`
      );
    }

    if (!existsSync(ecosystemPath)) {
      throw new Error(
        `PM2 ecosystem config not found at ${ecosystemPath}. ` +
        `Plugin installation may be corrupted.`
      );
    }

    // Spawn worker with PM2
    const proc = spawn(pm2Path, ['start', ecosystemPath], {
      detached: true,
      stdio: 'ignore',
      cwd: packageRoot
    });

    // Fail loudly on spawn errors
    proc.on('error', (err) => {
      throw new Error(`Failed to spawn PM2: ${err.message}`);
    });

    proc.unref();
    console.error('[claude-mem] Worker started with PM2');

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
