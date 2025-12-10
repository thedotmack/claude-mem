import path from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";

// CRITICAL: Always use marketplace directory for PM2/ecosystem
// This ensures cross-platform compatibility and avoids cache directory confusion
const MARKETPLACE_ROOT = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');

// Named constants for health checks
// Windows needs longer timeouts due to startup overhead
const HEALTH_CHECK_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.HEALTH_CHECK);
const WORKER_STARTUP_WAIT_MS = HOOK_TIMEOUTS.WORKER_STARTUP_WAIT;
const WORKER_STARTUP_RETRIES = HOOK_TIMEOUTS.WORKER_STARTUP_RETRIES;

/**
 * Get the worker port number
 * Priority: ~/.claude-mem/settings.json > env var > default
 */
export function getWorkerPort(): number {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
}

/**
 * Check if worker is responsive by trying the health endpoint
 */
async function isWorkerHealthy(): Promise<boolean> {
  try {
    const port = getWorkerPort();
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS)
    });
    return response.ok;
  } catch (error) {
    logger.debug('SYSTEM', 'Worker health check failed', {
      error: error instanceof Error ? error.message : String(error),
      errorType: error?.constructor?.name
    });
    return false;
  }
}

/**
 * Start the worker service
 * On Windows: Uses PowerShell Start-Process with hidden window to avoid console flash
 * On Unix: Uses PM2 for process management
 */
async function startWorker(): Promise<boolean> {
  try {
    const workerScript = path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs');

    if (!existsSync(workerScript)) {
      throw new Error(`Worker script not found at ${workerScript}`);
    }

    if (process.platform === 'win32') {
      // On Windows, use PowerShell Start-Process with -WindowStyle Hidden
      // This avoids visible console windows that PM2 creates on Windows
      // Escape single quotes for PowerShell by doubling them
      const escapedScript = workerScript.replace(/'/g, "''");
      const escapedWorkingDir = MARKETPLACE_ROOT.replace(/'/g, "''");

      const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process -FilePath 'node' -ArgumentList '${escapedScript}' -WorkingDirectory '${escapedWorkingDir}' -WindowStyle Hidden`
      ], {
        cwd: MARKETPLACE_ROOT,
        stdio: 'pipe',
        encoding: 'utf-8',
        windowsHide: true
      });

      if (result.status !== 0) {
        throw new Error(result.stderr || 'PowerShell Start-Process failed');
      }
    } else {
      // On Unix, use PM2 for process management
      const ecosystemPath = path.join(MARKETPLACE_ROOT, 'ecosystem.config.cjs');

      if (!existsSync(ecosystemPath)) {
        throw new Error(`Ecosystem config not found at ${ecosystemPath}`);
      }

      const localPm2Base = path.join(MARKETPLACE_ROOT, 'node_modules', '.bin', 'pm2');
      let pm2Command: string;

      if (existsSync(localPm2Base)) {
        pm2Command = localPm2Base;
      } else {
        // Check if global pm2 exists
        const globalPm2Check = spawnSync('which', ['pm2'], {
          encoding: 'utf-8',
          stdio: 'pipe'
        });

        if (globalPm2Check.status !== 0) {
          throw new Error(
            'PM2 not found. Install it locally with:\n' +
            `  cd ${MARKETPLACE_ROOT}\n` +
            '  npm install\n\n' +
            'Or install globally with: npm install -g pm2'
          );
        }

        pm2Command = 'pm2';
      }

      const result = spawnSync(pm2Command, ['start', ecosystemPath], {
        cwd: MARKETPLACE_ROOT,
        stdio: 'pipe',
        encoding: 'utf-8'
      });

      if (result.status !== 0) {
        throw new Error(result.stderr || 'PM2 start failed');
      }
    }

    // Wait for worker to become healthy
    for (let i = 0; i < WORKER_STARTUP_RETRIES; i++) {
      await new Promise(resolve => setTimeout(resolve, WORKER_STARTUP_WAIT_MS));
      if (await isWorkerHealthy()) {
        return true;
      }
    }

    return false;
  } catch (error) {
    logger.error('SYSTEM', 'Failed to start worker', {
      platform: process.platform,
      workerScript: path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs'),
      error: error instanceof Error ? error.message : String(error),
      marketplaceRoot: MARKETPLACE_ROOT
    });
    return false;
  }
}

/**
 * Ensure worker service is running
 * Checks health and auto-starts if not running
 */
export async function ensureWorkerRunning(): Promise<void> {
  // Check if already healthy
  if (await isWorkerHealthy()) {
    return;
  }

  // Try to start the worker
  const started = await startWorker();

  // Final health check before throwing error
  // Worker might be already running but was temporarily unresponsive
  if (!started && await isWorkerHealthy()) {
    return;
  }

  if (!started) {
    const port = getWorkerPort();
    throw new Error(
      `Worker service failed to start on port ${port}.\n\n` +
      `To start manually, run:\n` +
      `  cd ${MARKETPLACE_ROOT}\n` +
      `  npx pm2 start ecosystem.config.cjs\n\n` +
      `If already running, try: npx pm2 restart claude-mem-worker`
    );
  }
}
