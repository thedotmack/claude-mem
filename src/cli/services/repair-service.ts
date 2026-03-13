import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { paths } from '../utils/paths';
import { workerService } from './worker-service';
import type { HealthCheckResult, RepairResult } from '../types';

export class RepairService {
  async repairAll(checks: HealthCheckResult[]): Promise<RepairResult[]> {
    const results: RepairResult[] = [];
    for (const check of checks) {
      if (!check.ok && check.fixable) {
        results.push(await this.repairIssue(check));
      }
    }
    return results;
  }

  async repairIssue(check: HealthCheckResult): Promise<RepairResult> {
    switch (check.name) {
      case 'Plugin Configuration':
        return this.fixPluginDisabled();
      case 'Worker Service':
        return this.fixWorkerNotRunning();
      case 'Bun Runtime':
        if (check.message.includes('outdated')) {
          return this.fixBunOutdated();
        }
        return { issue: check.name, fixed: false, message: 'Bun installation requires manual setup' };
      default:
        return { issue: check.name, fixed: false, message: 'No automatic fix available' };
    }
  }

  private async fixPluginDisabled(): Promise<RepairResult> {
    try {
      const settings = JSON.parse(readFileSync(paths.claudeSettings, 'utf-8'));
      settings.enabledPlugins = settings.enabledPlugins || {};
      settings.enabledPlugins['claude-mem@thedotmack'] = true;
      writeFileSync(paths.claudeSettings, JSON.stringify(settings, null, 2));
      return { issue: 'Plugin Configuration', fixed: true, message: 'Re-enabled plugin in settings' };
    } catch (e) {
      return { issue: 'Plugin Configuration', fixed: false, message: `Failed: ${(e as Error).message}` };
    }
  }

  private async fixWorkerNotRunning(): Promise<RepairResult> {
    const result = await workerService.start();
    return {
      issue: 'Worker Service',
      fixed: result.success,
      message: result.success ? 'Worker service started' : `Failed: ${result.error}`
    };
  }

  private async fixBunOutdated(): Promise<RepairResult> {
    try {
      execSync('bun upgrade', { stdio: 'pipe', timeout: 60000 });
      return { issue: 'Bun Runtime', fixed: true, message: 'Bun upgraded successfully' };
    } catch (e) {
      return { issue: 'Bun Runtime', fixed: false, message: `Upgrade failed: ${(e as Error).message}` };
    }
  }
}

export const repairService = new RepairService();
