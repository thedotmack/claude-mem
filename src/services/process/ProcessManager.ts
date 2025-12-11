import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { DATA_DIR } from '../../shared/paths.js';

const PID_FILE = join(DATA_DIR, 'worker.pid');
const LOG_DIR = join(DATA_DIR, 'logs');
const MARKETPLACE_ROOT = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');

// Timeout constants
const PROCESS_STOP_TIMEOUT_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 10000;
const HEALTH_CHECK_INTERVAL_MS = 200;
const HEALTH_CHECK_FETCH_TIMEOUT_MS = 1000;
const PROCESS_EXIT_CHECK_INTERVAL_MS = 100;

interface PidInfo {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
}

export class ProcessManager {
  static async start(port: number): Promise<{ success: boolean; pid?: number; error?: string }> {
    // Check if already running
    if (await this.isRunning()) {
      const info = this.getPidInfo();
      return { success: true, pid: info?.pid };
    }

    // Ensure log directory exists
    mkdirSync(LOG_DIR, { recursive: true });

    // Get worker script path
    const workerScript = join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs');

    if (!existsSync(workerScript)) {
      return { success: false, error: `Worker script not found at ${workerScript}` };
    }

    const logFile = this.getLogFilePath();

    // Use Bun on all platforms
    return this.startWithBun(workerScript, logFile, port);
  }

  private static async startWithBun(script: string, logFile: string, port: number): Promise<{ success: boolean; pid?: number; error?: string }> {
    try {
      const isWindows = process.platform === 'win32';

      const child = spawn('bun', [script], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_MEM_WORKER_PORT: String(port) },
        cwd: MARKETPLACE_ROOT,
        // Hide console window on Windows
        ...(isWindows && { windowsHide: true })
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
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  static async stop(timeout: number = PROCESS_STOP_TIMEOUT_MS): Promise<boolean> {
    const info = this.getPidInfo();
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
    return this.isProcessAlive(info.pid);
  }

  // Helper methods
  private static getPidInfo(): PidInfo | null {
    try {
      if (!existsSync(PID_FILE)) return null;
      const content = readFileSync(PID_FILE, 'utf-8');
      return JSON.parse(content) as PidInfo;
    } catch {
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

  private static async waitForHealth(pid: number, port: number, timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS): Promise<{ success: boolean; pid?: number; error?: string }> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      // Check if process is still alive
      if (!this.isProcessAlive(pid)) {
        return { success: false, error: 'Process died during startup' };
      }

      // Try health check
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(HEALTH_CHECK_FETCH_TIMEOUT_MS)
        });
        if (response.ok) {
          return { success: true, pid };
        }
      } catch {
        // Not ready yet
      }

      await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
    }

    return { success: false, error: 'Health check timed out' };
  }

  private static async waitForExit(pid: number, timeout: number): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (!this.isProcessAlive(pid)) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, PROCESS_EXIT_CHECK_INTERVAL_MS));
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
