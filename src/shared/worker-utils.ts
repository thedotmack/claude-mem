import path from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";

// Named constants for health checks
const HEALTH_CHECK_TIMEOUT_MS = 100;

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
 * Ensure worker service is running
 * Checks health and fails with instructions if not healthy
 * PM2's watch mode handles auto-restarts automatically
 */
export async function ensureWorkerRunning(): Promise<void> {
  if (await isWorkerHealthy()) {
    return;
  }

  const port = getWorkerPort();
  throw new Error(
    `Worker service is not responding on port ${port}.\n\n` +
    `If you just updated the plugin, PM2's watch mode should restart automatically.\n` +
    `If the problem persists, run: pm2 restart claude-mem-worker`
  );
}
