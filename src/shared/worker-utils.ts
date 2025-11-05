import path from "path";
import { spawn } from "child_process";
import { getPackageRoot } from "./paths.js";

const FIXED_PORT = parseInt(process.env.CLAUDE_MEM_WORKER_PORT || "37777", 10);

/**
 * Check if worker is responsive by trying the health endpoint
 */
async function isWorkerHealthy(timeoutMs: number = 3000): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${FIXED_PORT}/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for worker to become healthy
 */
async function waitForWorkerHealth(maxWaitMs: number = 10000): Promise<boolean> {
  const start = Date.now();
  const checkInterval = 100; // Check every 100ms
  
  while (Date.now() - start < maxWaitMs) {
    // Use shorter timeout (300ms) for faster failure detection during polling
    if (await isWorkerHealthy(300)) {
      return true;
    }
    // Wait before next check
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  return false;
}

/**
 * Ensure worker service is running
 * Checks if worker is already running before attempting to start
 * This prevents unnecessary restarts that could interrupt mid-action processing
 */
export async function ensureWorkerRunning(): Promise<void> {
  // First, check if worker is already healthy
  if (await isWorkerHealthy(1000)) {
    return; // Worker is already running and responsive
  }

  const packageRoot = getPackageRoot();
  const pm2Path = path.join(packageRoot, "node_modules", ".bin", "pm2");
  const ecosystemPath = path.join(packageRoot, "ecosystem.config.cjs");

  // Check PM2 status to see if worker process exists
  const checkProcess = spawn(pm2Path, ["list", "--no-color"], {
    cwd: packageRoot,
    stdio: ["ignore", "pipe", "ignore"],
  });

  let output = "";
  checkProcess.stdout?.on("data", (data) => {
    output += data.toString();
  });

  // Wait for PM2 list to complete
  await new Promise<void>((resolve, reject) => {
    checkProcess.on("error", (error) => reject(error));
    checkProcess.on("close", (code) => {
      // PM2 list can fail, but we should still continue - just assume worker isn't running
      // This handles cases where PM2 isn't installed yet
      resolve();
    });
  });

  // Check if 'claude-mem-worker' is in the PM2 list output and is 'online'
  const isRunning = output.includes("claude-mem-worker") && output.includes("online");

  if (!isRunning) {
    // Start the worker
    const startProcess = spawn(pm2Path, ["start", ecosystemPath], {
      cwd: packageRoot,
      stdio: "ignore",
    });

    // Wait for PM2 start command to complete
    await new Promise<void>((resolve, reject) => {
      startProcess.on("error", (error) => reject(error));
      startProcess.on("close", (code) => {
        // Exit code 0 means success, null means process terminated abnormally
        // but PM2 sometimes returns null for successful daemon starts
        if (code !== 0 && code !== null) {
          reject(new Error(`PM2 start command failed with exit code ${code}`));
        } else {
          resolve();
        }
      });
    });
  }

  // Wait for worker to become healthy (either just started or was starting)
  const healthy = await waitForWorkerHealth(10000);
  if (!healthy) {
    throw new Error("Worker failed to become healthy after starting");
  }
}

/**
 * Get the worker port number (fixed port)
 */
export function getWorkerPort(): number {
  return FIXED_PORT;
}
