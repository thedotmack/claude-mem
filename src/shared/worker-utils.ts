import path from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { getPackageRoot } from "./paths.js";

// Named constants for health checks
const HEALTH_CHECK_TIMEOUT_MS = 100;
const WORKER_STARTUP_WAIT_MS = 500;
const WORKER_STARTUP_RETRIES = 10;

/**
 * Get the worker port number
 * Priority: ~/.claude-mem/settings.json > env var > default
 */
export function getWorkerPort(): number {
  try {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const port = parseInt(settings.env?.CLAUDE_MEM_WORKER_PORT, 10);
      if (!isNaN(port)) return port;
    }
  } catch {
    // Fall through to env var or default
  }
  return parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777', 10);
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
    // Find the ecosystem config file (built version in plugin/)
    const pluginRoot = getPackageRoot();
    const ecosystemPath = path.join(pluginRoot, 'ecosystem.config.cjs');

    if (!existsSync(ecosystemPath)) {
      throw new Error(`Ecosystem config not found at ${ecosystemPath}`);
    }

    // Try to use local PM2 from node_modules first, fall back to global PM2
    // On Windows, PM2 executable is pm2.cmd, not pm2
    const localPm2Base = path.join(pluginRoot, 'node_modules', '.bin', 'pm2');
    const localPm2Cmd = process.platform === 'win32' ? localPm2Base + '.cmd' : localPm2Base;
    const pm2Command = existsSync(localPm2Cmd) ? localPm2Cmd : 'pm2';

    // Start using PM2 with the ecosystem config
    // CRITICAL: Must set cwd to pluginRoot so PM2 starts from marketplace directory
    // Using spawnSync with array args to avoid command injection risks
    const result = spawnSync(pm2Command, ['start', ecosystemPath], {
      cwd: pluginRoot,
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
    const pluginRoot = getPackageRoot();
    throw new Error(
      `Worker service failed to start on port ${port}.\n\n` +
      `To start manually, run:\n` +
      `  cd ${pluginRoot}\n` +
      `  npx pm2 start ecosystem.config.cjs\n\n` +
      `If already running, try: npx pm2 restart claude-mem-worker`
    );
  }
}
