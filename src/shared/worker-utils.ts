import path from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { getPackageRoot } from "./paths.js";

// Named constants for health checks
const HEALTH_CHECK_TIMEOUT_MS = 100;
const HEALTH_CHECK_POLL_INTERVAL_MS = 100;
const HEALTH_CHECK_MAX_WAIT_MS = 10000;

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
 * Wait for worker to become healthy
 */
async function waitForWorkerHealth(): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < HEALTH_CHECK_MAX_WAIT_MS) {
    if (await isWorkerHealthy()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Ensure worker service is running
 * If unhealthy, restarts PM2 and waits for health
 */
export async function ensureWorkerRunning(): Promise<void> {
  if (await isWorkerHealthy()) {
    return;
  }

  const packageRoot = getPackageRoot();
  const pm2Path = path.join(packageRoot, "node_modules", ".bin", "pm2");
  const ecosystemPath = path.join(packageRoot, "ecosystem.config.cjs");

  execSync(`"${pm2Path}" start "${ecosystemPath}"`, {
    cwd: packageRoot,
    stdio: 'pipe'
  });

  if (!await waitForWorkerHealth()) {
    throw new Error("Worker failed to become healthy after restart");
  }
}
