import { execSync } from 'child_process';
import { join } from 'path';
import { paths, getWorkerPort } from '../utils/paths';
import type { WorkerStatus } from '../types';

const IS_WINDOWS = process.platform === 'win32';

export class WorkerService {
  private port = getWorkerPort();

  async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<WorkerStatus> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      if (!res.ok) return { running: false };
      const data = await res.json();
      return {
        running: true,
        pid: data.pid,
        port: this.port,
        uptime: data.uptime ? this.formatUptime(data.uptime) : undefined
      };
    } catch {
      return { running: false };
    }
  }

  async start(): Promise<{ success: boolean; error?: string }> {
    const script = join(paths.pluginDir, 'plugin', 'scripts', 'worker-service.cjs');
    try {
      await this.stop();
      execSync(`bun "${script}" start`, { stdio: 'ignore', timeout: 10000, shell: IS_WINDOWS });
      await new Promise(r => setTimeout(r, 1000));
      return { success: await this.isRunning() };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  async stop(): Promise<void> {
    try {
      await fetch(`http://127.0.0.1:${this.port}/api/admin/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000)
      });
    } catch {
      // Force kill
      try {
        execSync(IS_WINDOWS ? 'taskkill /F /IM bun.exe 2>nul' : 'pkill -f "worker-service.cjs" 2>/dev/null || true', { stdio: 'ignore' });
      } catch { /* ignore */ }
    }
  }

  private formatUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }
}

export const workerService = new WorkerService();
