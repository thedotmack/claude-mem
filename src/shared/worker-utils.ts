import path from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { SettingsDefaultsManager } from "../services/worker/settings/SettingsDefaultsManager.js";

// CRITICAL: Always use marketplace directory for PM2/ecosystem
// This ensures cross-platform compatibility and avoids cache directory confusion
const MARKETPLACE_ROOT = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');

// Named constants for health checks
const HEALTH_CHECK_TIMEOUT_MS = 100;
const WORKER_STARTUP_WAIT_MS = 500;
const WORKER_STARTUP_RETRIES = 10;

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
  } catch {
    return false;
  }
}

/**
 * Start the worker using PM2
 */
async function startWorker(): Promise<boolean> {
  try {
    // CRITICAL: Always use marketplace directory for ecosystem.config.cjs
    // This ensures PM2 starts from the correct location regardless of where hooks run from
    const ecosystemPath = path.join(MARKETPLACE_ROOT, 'ecosystem.config.cjs');

    if (!existsSync(ecosystemPath)) {
      throw new Error(`Ecosystem config not found at ${ecosystemPath}`);
    }

    // Try to use local PM2 from node_modules first, fall back to global PM2
    // On Windows, PM2 executable is pm2.cmd, not pm2
    const localPm2Base = path.join(MARKETPLACE_ROOT, 'node_modules', '.bin', 'pm2');
    const localPm2Cmd = process.platform === 'win32' ? localPm2Base + '.cmd' : localPm2Base;
    const pm2Command = existsSync(localPm2Cmd) ? localPm2Cmd : 'pm2';

    // Start using PM2 with the ecosystem config
    // CRITICAL: Must set cwd to MARKETPLACE_ROOT so PM2 starts from marketplace directory
    // Using spawnSync with array args to avoid command injection risks
    const result = spawnSync(pm2Command, ['start', ecosystemPath], {
      cwd: MARKETPLACE_ROOT,
      stdio: 'pipe',
      encoding: 'utf-8',
      windowsHide: true
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || 'PM2 start failed');
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
    // Failed to start worker
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
