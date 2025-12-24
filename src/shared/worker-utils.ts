import path from "path";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";

// Directory paths
const MARKETPLACE_ROOT = path.join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const CACHE_BASE = path.join(homedir(), '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');

/**
 * Find the cache directory with the highest version number
 * Cache directories are named like: ~/.claude/plugins/cache/thedotmack/claude-mem/7.0.10/
 */
function findLatestCacheDir(): string | null {
  try {
    if (!existsSync(CACHE_BASE)) {
      return null;
    }
    const versions = readdirSync(CACHE_BASE)
      .filter(name => /^\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => {
        const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
        const [bMajor, bMinor, bPatch] = b.split('.').map(Number);
        if (aMajor !== bMajor) return bMajor - aMajor;
        if (aMinor !== bMinor) return bMinor - aMinor;
        return bPatch - aPatch;
      });
    return versions.length > 0 ? path.join(CACHE_BASE, versions[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Find PM2 executable - checks cache directory first, then marketplace, then global
 */
function findPm2(): { command: string; cwd: string } | null {
  // Check cache directory first (most likely location for marketplace installs)
  const cacheDir = findLatestCacheDir();
  if (cacheDir) {
    const cachePm2 = path.join(cacheDir, 'node_modules', '.bin', 'pm2');
    if (existsSync(cachePm2)) {
      return { command: cachePm2, cwd: cacheDir };
    }
  }

  // Check marketplace directory
  const marketplacePm2 = path.join(MARKETPLACE_ROOT, 'node_modules', '.bin', 'pm2');
  if (existsSync(marketplacePm2)) {
    return { command: marketplacePm2, cwd: MARKETPLACE_ROOT };
  }

  // Check global PM2
  const globalPm2Check = spawnSync('which', ['pm2'], {
    encoding: 'utf-8',
    stdio: 'pipe'
  });
  if (globalPm2Check.status === 0) {
    return { command: 'pm2', cwd: MARKETPLACE_ROOT };
  }

  return null;
}

/**
 * Find worker script - checks cache directory first, then marketplace
 */
function findWorkerScript(): { script: string; cwd: string } | null {
  // Check cache directory first
  const cacheDir = findLatestCacheDir();
  if (cacheDir) {
    const cacheWorker = path.join(cacheDir, 'scripts', 'worker-service.cjs');
    if (existsSync(cacheWorker)) {
      return { script: cacheWorker, cwd: cacheDir };
    }
  }

  // Check marketplace directory
  const marketplaceWorker = path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs');
  if (existsSync(marketplaceWorker)) {
    return { script: marketplaceWorker, cwd: MARKETPLACE_ROOT };
  }

  return null;
}

/**
 * Find ecosystem config - checks cache first (has correct relative paths for cache structure)
 * Returns both the config path and the directory (cwd) where PM2 should run from
 */
function findEcosystemConfig(): { configPath: string; cwd: string } | null {
  // Check cache directory first - it has ecosystem config with correct paths for cache structure
  const cacheDir = findLatestCacheDir();
  if (cacheDir) {
    const cacheEcosystem = path.join(cacheDir, 'ecosystem.config.cjs');
    if (existsSync(cacheEcosystem)) {
      return { configPath: cacheEcosystem, cwd: cacheDir };
    }
  }

  // Fallback to marketplace (for development/direct installs)
  const marketplaceEcosystem = path.join(MARKETPLACE_ROOT, 'ecosystem.config.cjs');
  if (existsSync(marketplaceEcosystem)) {
    return { configPath: marketplaceEcosystem, cwd: MARKETPLACE_ROOT };
  }
  return null;
}

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
    // Find worker script (checks cache first, then marketplace)
    const workerInfo = findWorkerScript();
    if (!workerInfo) {
      throw new Error('Worker script not found in cache or marketplace directory');
    }

    const { script: workerScript, cwd: workerCwd } = workerInfo;

    if (process.platform === 'win32') {
      // On Windows, use PowerShell Start-Process with -WindowStyle Hidden
      // This avoids visible console windows that PM2 creates on Windows
      // Escape single quotes for PowerShell by doubling them
      const escapedScript = workerScript.replace(/'/g, "''");
      const escapedWorkingDir = workerCwd.replace(/'/g, "''");

      const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process -FilePath 'node' -ArgumentList '${escapedScript}' -WorkingDirectory '${escapedWorkingDir}' -WindowStyle Hidden`
      ], {
        cwd: workerCwd,
        stdio: 'pipe',
        encoding: 'utf-8',
        windowsHide: true
      });

      if (result.status !== 0) {
        throw new Error(result.stderr || 'PowerShell Start-Process failed');
      }
    } else {
      // On Unix, use PM2 for process management
      const ecosystemInfo = findEcosystemConfig();

      if (!ecosystemInfo) {
        throw new Error('Ecosystem config not found');
      }

      // Find PM2 (checks cache first, then marketplace, then global)
      const pm2Info = findPm2();

      if (!pm2Info) {
        const cacheDir = findLatestCacheDir();
        throw new Error(
          'PM2 not found. Install it locally with:\n' +
          `  cd ${cacheDir || MARKETPLACE_ROOT}\n` +
          '  npm install\n\n' +
          'Or install globally with: npm install -g pm2'
        );
      }

      // IMPORTANT: Use ecosystem config's cwd, not pm2's cwd
      // PM2 resolves relative script paths from cwd, and ecosystem config
      // has paths relative to its own directory
      const result = spawnSync(pm2Info.command, ['start', ecosystemInfo.configPath], {
        cwd: ecosystemInfo.cwd,
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
    const workerInfo = findWorkerScript();
    logger.error('SYSTEM', 'Failed to start worker', {
      platform: process.platform,
      workerScript: workerInfo?.script || 'not found',
      error: error instanceof Error ? error.message : String(error),
      cacheDir: findLatestCacheDir(),
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
    const ecosystemInfo = findEcosystemConfig();
    const installDir = ecosystemInfo?.cwd || findLatestCacheDir() || MARKETPLACE_ROOT;
    const ecosystemPath = ecosystemInfo?.configPath || path.join(MARKETPLACE_ROOT, 'ecosystem.config.cjs');
    throw new Error(
      `Worker service failed to start on port ${port}.\n\n` +
      `To start manually, run:\n` +
      `  cd ${installDir}\n` +
      `  npx pm2 start ${ecosystemPath}\n\n` +
      `If already running, try: npx pm2 restart claude-mem-worker`
    );
  }
}
