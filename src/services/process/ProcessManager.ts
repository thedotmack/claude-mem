import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { spawn, spawnSync } from 'child_process';
import { homedir } from 'os';
import { DATA_DIR } from '../../shared/paths.js';
import { getBunPath, isBunAvailable } from '../../utils/bun-path.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

const PID_FILE = join(DATA_DIR, 'worker.pid');
const LOG_DIR = join(DATA_DIR, 'logs');
const MARKETPLACE_ROOT = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');

interface PidInfo {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
}

export class ProcessManager {
  static async start(port: number): Promise<{ success: boolean; pid?: number; error?: string }> {
    // Validate port range
    if (isNaN(port) || port < 1024 || port > 65535) {
      return {
        success: false,
        error: `Invalid port ${port}. Must be between 1024 and 65535`
      };
    }

    // Check if already running
    if (await this.isRunning()) {
      const info = this.getPidInfo();
      return { success: true, pid: info?.pid };
    }

    // Ensure log directory exists
    mkdirSync(LOG_DIR, { recursive: true });

    // On Windows, use the wrapper script to solve zombie port problem
    // On Unix, use the worker directly
    const scriptName = process.platform === 'win32' ? 'worker-wrapper.cjs' : 'worker-service.cjs';
    const workerScript = join(MARKETPLACE_ROOT, 'plugin', 'scripts', scriptName);

    if (!existsSync(workerScript)) {
      return { success: false, error: `Worker script not found at ${workerScript}` };
    }

    const logFile = this.getLogFilePath();

    // Use Bun on all platforms with PowerShell workaround for Windows console popups
    return this.startWithBun(workerScript, logFile, port);
  }

  private static isBunAvailable(): boolean {
    return isBunAvailable();
  }

  /**
   * Escapes a string for safe use in PowerShell single-quoted strings.
   * In PowerShell single quotes, the only special character is the single quote itself,
   * which must be doubled to escape it.
   */
  private static escapePowerShellString(str: string): string {
    return str.replace(/'/g, "''");
  }

  private static async startWithBun(script: string, logFile: string, port: number): Promise<{ success: boolean; pid?: number; error?: string }> {
    const bunPath = getBunPath();
    if (!bunPath) {
      return {
        success: false,
        error: 'Bun is required but not found in PATH or common installation paths. Install from https://bun.sh'
      };
    }
    try {
      const isWindows = process.platform === 'win32';

      if (isWindows) {
        // Windows: Use PowerShell Start-Process with -WindowStyle Hidden
        // This properly hides the console window (affects both Bun and Node.js)
        // Note: windowsHide: true doesn't work with detached: true (Bun inherits Node.js process spawning semantics)
        // See: https://github.com/nodejs/node/issues/21825 and PR #315 for detailed testing
        //
        // On Windows, we start worker-wrapper.cjs which manages the actual worker-service.cjs.
        // This solves the zombie port problem: the wrapper has no sockets, so when it kills
        // and respawns the inner worker, the socket is properly released.
        //
        // Security: All paths (bunPath, script, MARKETPLACE_ROOT) are application-controlled system paths,
        // not user input. If an attacker could modify these paths, they would already have full filesystem
        // access including direct access to ~/.claude-mem/claude-mem.db. Nevertheless, we properly escape
        // all values for PowerShell to follow security best practices.
        const escapedBunPath = this.escapePowerShellString(bunPath);
        const escapedScript = this.escapePowerShellString(script);
        const escapedWorkDir = this.escapePowerShellString(MARKETPLACE_ROOT);
        const escapedLogFile = this.escapePowerShellString(logFile);
        const envVars = `$env:CLAUDE_MEM_WORKER_PORT='${port}'`;
        const psCommand = `${envVars}; Start-Process -FilePath '${escapedBunPath}' -ArgumentList '${escapedScript}' -WorkingDirectory '${escapedWorkDir}' -WindowStyle Hidden -RedirectStandardOutput '${escapedLogFile}' -RedirectStandardError '${escapedLogFile}.err' -PassThru | Select-Object -ExpandProperty Id`;

        const result = spawnSync('powershell', ['-Command', psCommand], {
          stdio: 'pipe',
          timeout: 10000,
          windowsHide: true
        });

        if (result.status !== 0) {
          return {
            success: false,
            error: `PowerShell spawn failed: ${result.stderr?.toString() || 'unknown error'}`
          };
        }

        const pid = parseInt(result.stdout.toString().trim(), 10);
        if (isNaN(pid)) {
          return { success: false, error: 'Failed to get PID from PowerShell' };
        }

        // Write PID file
        this.writePidFile({
          pid,
          port,
          startedAt: new Date().toISOString(),
          version: process.env.npm_package_version || 'unknown'
        });

        // Wait for health
        return this.waitForHealth(pid, port);
      } else {
        // Unix: Use standard spawn with detached
        const child = spawn(bunPath, [script], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, CLAUDE_MEM_WORKER_PORT: String(port) },
          cwd: MARKETPLACE_ROOT
        });

        // Write logs
        const logStream = createWriteStream(logFile, { flags: 'a' });
        child.stdout?.pipe(logStream);
        child.stderr?.pipe(logStream);

        child.unref();

        if (!child.pid) {
          return { success: false, error: 'Failed to get PID from spawned process' };
        }

        // Write PID file
        this.writePidFile({
          pid: child.pid,
          port,
          startedAt: new Date().toISOString(),
          version: process.env.npm_package_version || 'unknown'
        });

        // Wait for health
        return this.waitForHealth(child.pid, port);
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  static async stop(timeout: number = 5000): Promise<boolean> {
    const info = this.getPidInfo();

    if (process.platform === 'win32') {
      // Windows: Try graceful HTTP shutdown first - this works regardless of PID file state
      // because the worker shuts itself down from the inside (via wrapper IPC)
      const port = info?.port ?? this.getPortFromSettings();
      const httpShutdownSucceeded = await this.tryHttpShutdown(port);

      if (httpShutdownSucceeded) {
        // HTTP shutdown succeeded - worker confirmed down, safe to remove PID file
        this.removePidFile();
        return true;
      }

      // HTTP shutdown failed (worker not responding), fall back to taskkill
      if (!info) {
        // No PID file and HTTP failed - nothing more we can do
        return true;
      }

      const { execSync } = await import('child_process');
      try {
        // Use taskkill /T /F to kill entire process tree
        // This ensures the wrapper AND all its children (inner worker, MCP, ChromaSync) are killed
        // which is necessary to properly release the socket and avoid zombie ports
        execSync(`taskkill /PID ${info.pid} /T /F`, { timeout: 10000, stdio: 'ignore' });
      } catch {
        // Process may already be dead
      }

      // Wait for process to actually exit before removing PID file
      try {
        await this.waitForExit(info.pid, timeout);
      } catch {
        // Timeout waiting - process may still be alive
      }

      // Only remove PID file if process is confirmed dead
      if (!this.isProcessAlive(info.pid)) {
        this.removePidFile();
      }
      return true;
    } else {
      // Unix: Use signals (unchanged behavior)
      if (!info) return true;

      try {
        process.kill(info.pid, 'SIGTERM');
        await this.waitForExit(info.pid, timeout);
      } catch {
        try {
          process.kill(info.pid, 'SIGKILL');
        } catch {
          // Process already dead
        }
      }

      this.removePidFile();
      return true;
    }
  }

  static async restart(port: number): Promise<{ success: boolean; pid?: number; error?: string }> {
    await this.stop();
    return this.start(port);
  }

  static async status(): Promise<{ running: boolean; pid?: number; port?: number; uptime?: string }> {
    const info = this.getPidInfo();
    if (!info) return { running: false };

    const running = this.isProcessAlive(info.pid);
    return {
      running,
      pid: running ? info.pid : undefined,
      port: running ? info.port : undefined,
      uptime: running ? this.formatUptime(info.startedAt) : undefined
    };
  }

  static async isRunning(): Promise<boolean> {
    const info = this.getPidInfo();
    if (!info) return false;
    const alive = this.isProcessAlive(info.pid);
    if (!alive) {
      this.removePidFile(); // Clean up stale PID file
    }
    return alive;
  }

  /**
   * Get worker port from settings file
   */
  private static getPortFromSettings(): number {
    try {
      const settingsPath = join(DATA_DIR, 'settings.json');
      const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
      return parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
    } catch {
      return parseInt(SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT'), 10);
    }
  }

  /**
   * Try to shut down the worker via HTTP endpoint
   * Returns true if shutdown succeeded, false if worker not responding
   */
  private static async tryHttpShutdown(port: number): Promise<boolean> {
    try {
      // Send shutdown request
      const response = await fetch(`http://127.0.0.1:${port}/api/admin/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(2000)
      });

      if (!response.ok) {
        return false;
      }

      // Wait for worker to actually stop responding
      return await this.waitForWorkerDown(port, 5000);
    } catch {
      // Worker not responding to HTTP - it may be dead or hung
      return false;
    }
  }

  /**
   * Wait for worker to stop responding on the given port
   */
  private static async waitForWorkerDown(port: number, timeout: number): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(500)
        });
        // Still responding, wait and retry
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch {
        // Worker stopped responding - success
        return true;
      }
    }

    // Timeout - worker still responding
    return false;
  }

  // Helper methods
  private static getPidInfo(): PidInfo | null {
    try {
      if (!existsSync(PID_FILE)) return null;
      const content = readFileSync(PID_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      // Validate required fields have correct types
      if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') {
        logger.warn('PROCESS', 'Malformed PID file: missing or invalid pid/port fields', {}, { parsed });
        return null;
      }
      return parsed as PidInfo;
    } catch (error) {
      logger.warn('PROCESS', 'Failed to read PID file', {}, {
        error: error instanceof Error ? error.message : String(error),
        path: PID_FILE
      });
      return null;
    }
  }

  private static writePidFile(info: PidInfo): void {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PID_FILE, JSON.stringify(info, null, 2));
  }

  private static removePidFile(): void {
    try {
      if (existsSync(PID_FILE)) {
        unlinkSync(PID_FILE);
      }
    } catch {
      // Ignore errors
    }
  }

  private static isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private static async waitForHealth(pid: number, port: number, timeoutMs: number = 10000): Promise<{ success: boolean; pid?: number; error?: string }> {
    const startTime = Date.now();
    const isWindows = process.platform === 'win32';
    // Increase timeout on Windows to account for slower process startup
    const adjustedTimeout = isWindows ? timeoutMs * 2 : timeoutMs;

    while (Date.now() - startTime < adjustedTimeout) {
      // Check if process is still alive
      if (!this.isProcessAlive(pid)) {
        const errorMsg = isWindows
          ? `Process died during startup\n\nTroubleshooting:\n1. Check Task Manager for zombie 'bun.exe' or 'node.exe' processes\n2. Verify port ${port} is not in use: netstat -ano | findstr ${port}\n3. Check worker logs in ~/.claude-mem/logs/\n4. See GitHub issues: #363, #367, #371, #373\n5. Docs: https://docs.claude-mem.ai/troubleshooting/windows-issues`
          : 'Process died during startup';
        return { success: false, error: errorMsg };
      }

      // Try readiness check (changed from /health to /api/readiness)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/readiness`, {
          signal: AbortSignal.timeout(1000)
        });
        if (response.ok) {
          return { success: true, pid };
        }
      } catch {
        // Not ready yet, continue polling
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    const timeoutMsg = isWindows
      ? `Worker failed to start on Windows (readiness check timed out after ${adjustedTimeout}ms)\n\nTroubleshooting:\n1. Check Task Manager for zombie 'bun.exe' or 'node.exe' processes\n2. Verify port ${port} is not in use: netstat -ano | findstr ${port}\n3. Check worker logs in ~/.claude-mem/logs/\n4. See GitHub issues: #363, #367, #371, #373\n5. Docs: https://docs.claude-mem.ai/troubleshooting/windows-issues`
      : `Readiness check timed out after ${adjustedTimeout}ms`;

    return { success: false, error: timeoutMsg };
  }

  private static async waitForExit(pid: number, timeout: number): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (!this.isProcessAlive(pid)) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error('Process did not exit within timeout');
  }

  private static getLogFilePath(): string {
    const date = new Date().toISOString().slice(0, 10);
    return join(LOG_DIR, `worker-${date}.log`);
  }

  private static formatUptime(startedAt: string): string {
    const startTime = new Date(startedAt).getTime();
    const now = Date.now();
    const diffMs = now - startTime;

    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}
