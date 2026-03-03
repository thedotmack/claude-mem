import { existsSync, readFileSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { paths } from '../utils/paths';
import { workerService } from './worker-service';
import type { HealthCheckResult } from '../types';

const MIN_BUN_VERSION = '1.1.14';

export class HealthChecker {
  async runAllChecks(): Promise<HealthCheckResult[]> {
    return Promise.all([
      this.checkPluginEnabled(),
      this.checkWorkerRunning(),
      this.checkDatabase(),
      this.checkBunVersion(),
      this.checkNodeVersion(),
    ]);
  }

  async checkPluginEnabled(): Promise<HealthCheckResult> {
    try {
      if (!existsSync(paths.claudeSettings)) {
        return { name: 'Plugin Configuration', ok: true, message: 'No settings file (assuming enabled)', severity: 'info' };
      }
      const settings = JSON.parse(readFileSync(paths.claudeSettings, 'utf-8'));
      const disabled = settings?.enabledPlugins?.['claude-mem@thedotmack'] === false;
      return {
        name: 'Plugin Configuration',
        ok: !disabled,
        message: disabled ? 'Plugin is disabled in Claude Code settings' : 'Plugin is enabled',
        severity: disabled ? 'error' : 'info',
        fixable: disabled
      };
    } catch (e) {
      return { name: 'Plugin Configuration', ok: false, message: `Failed to read settings: ${(e as Error).message}`, severity: 'warning' };
    }
  }

  async checkWorkerRunning(): Promise<HealthCheckResult> {
    const status = await workerService.getStatus();
    return {
      name: 'Worker Service',
      ok: status.running,
      message: status.running ? `Worker running (PID: ${status.pid})` : 'Worker is not running',
      severity: status.running ? 'info' : 'error',
      fixable: !status.running,
      data: status
    };
  }

  async checkDatabase(): Promise<HealthCheckResult> {
    if (!existsSync(paths.database)) {
      return { 
        name: 'Database', 
        ok: false, 
        message: 'Database file not found. Run "npm run worker:start" to initialize the database.', 
        severity: 'error', 
        fixable: false 
      };
    }
    try {
      const stats = statSync(paths.database);
      const integrity = spawnSync('sqlite3', [paths.database, 'PRAGMA integrity_check;'], { encoding: 'utf-8', timeout: 5000 });
      const ok = integrity.stdout?.includes('ok');
      return {
        name: 'Database',
        ok: ok,
        message: `Database accessible (${(stats.size / 1024 / 1024).toFixed(1)} MB)`,
        severity: ok ? 'info' : 'error',
        data: { size: stats.size }
      };
    } catch (e) {
      return { name: 'Database', ok: false, message: `Database check failed: ${(e as Error).message}`, severity: 'error' };
    }
  }

  async checkBunVersion(): Promise<HealthCheckResult> {
    try {
      const result = spawnSync('bun', ['--version'], { encoding: 'utf-8', timeout: 5000 });
      if (result.status !== 0) {
        return { name: 'Bun Runtime', ok: false, message: 'Bun is not installed', severity: 'error', fixable: true };
      }
      const version = result.stdout.trim().replace(/^v/, '');
      const parts1 = version.split('.').map(Number);
      const parts2 = MIN_BUN_VERSION.split('.').map(Number);
      const isValid = parts1[0] > parts2[0] || (parts1[0] === parts2[0] && parts1[1] >= parts2[1]);
      return {
        name: 'Bun Runtime',
        ok: isValid,
        message: isValid ? `Bun ${version}` : `Bun ${version} is outdated (need ${MIN_BUN_VERSION}+)`,
        severity: isValid ? 'info' : 'warning',
        fixable: !isValid,
        data: { version, minimum: MIN_BUN_VERSION }
      };
    } catch {
      return { name: 'Bun Runtime', ok: false, message: 'Bun is not installed', severity: 'error', fixable: true };
    }
  }

  async checkNodeVersion(): Promise<HealthCheckResult> {
    try {
      const result = spawnSync('node', ['--version'], { encoding: 'utf-8', timeout: 5000 });
      const version = result.stdout.trim().replace(/^v/, '');
      const major = parseInt(version.split('.')[0], 10);
      return {
        name: 'Node.js',
        ok: major >= 18,
        message: `Node.js ${version}`,
        severity: major >= 18 ? 'info' : 'warning'
      };
    } catch {
      return { name: 'Node.js', ok: false, message: 'Node.js is not installed', severity: 'error' };
    }
  }

  getSummary(results: HealthCheckResult[]) {
    const errors = results.filter(r => r.severity === 'error').length;
    const warnings = results.filter(r => r.severity === 'warning').length;
    return { healthy: errors === 0, errors, warnings };
  }
}

export const healthChecker = new HealthChecker();
