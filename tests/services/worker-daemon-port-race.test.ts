import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');

describe('Worker daemon port-race guard (#1447)', () => {
  it.each([
    { name: 'EADDRINUSE with a healthy winner', code: 'EADDRINUSE', message: 'listen failed', healthy: true, status: 0 },
    { name: 'Bun port-in-use message with a healthy winner', message: 'Is port 37777 in use?', healthy: true, status: 0 },
    { name: 'address-in-use message with a healthy winner', message: 'Address already in use', healthy: true, status: 0 },
    { name: 'EADDRINUSE without a healthy winner', code: 'EADDRINUSE', message: 'listen failed', healthy: false, status: 78 },
    { name: 'another failure despite a healthy worker', code: 'EACCES', message: 'permission denied', healthy: true, status: 78 },
  ])('exits correctly for $name', ({ code, message, healthy, status }) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cm-worker-port-race-'));
    try {
      const script = `
        import { spyOn } from 'bun:test';
        import * as health from ${JSON.stringify(join(ROOT, 'src/services/infrastructure/HealthMonitor.ts'))};
        import * as processManager from ${JSON.stringify(join(ROOT, 'src/services/infrastructure/ProcessManager.ts'))};
        import * as pluginState from ${JSON.stringify(join(ROOT, 'src/shared/plugin-state.ts'))};
        import { logger } from ${JSON.stringify(join(ROOT, 'src/utils/logger.ts'))};
        const { WorkerService, main } = await import(${JSON.stringify(join(ROOT, 'src/services/worker-service.ts'))});
        spyOn(pluginState, 'isPluginDisabledInClaudeSettings').mockReturnValue(false);
        spyOn(health, 'probePortBind').mockResolvedValue({ occupancy: 'free' });
        spyOn(health, 'isPortInUse').mockResolvedValue(false);
        spyOn(health, 'waitForHealth').mockImplementation(async () => {
          console.log('health checked');
          return ${JSON.stringify(healthy)};
        });
        spyOn(processManager, 'pinDaemonWorkingDirectory').mockReturnValue(null);
        spyOn(processManager, 'readPidFile').mockReturnValue(null);
        spyOn(processManager, 'verifyWorkerPidFileOwnership').mockReturnValue(false);
        spyOn(processManager, 'removePidFileIfOwner').mockReturnValue(false);
        spyOn(WorkerService.prototype, 'registerRoutes').mockImplementation(() => {});
        spyOn(WorkerService.prototype, 'registerSignalHandlers').mockImplementation(() => {});
        spyOn(WorkerService.prototype, 'start').mockRejectedValue(Object.assign(
          new Error(${JSON.stringify(message)}), { code: ${JSON.stringify(code)} },
        ));
        spyOn(logger, 'info').mockImplementation((_category, message) => console.log(message));
        spyOn(logger, 'failure').mockImplementation((_category, message) => console.log(message));
        process.argv = [process.execPath, 'worker-service.ts', '--daemon'];
        await main();
      `;
      const result = spawnSync(process.execPath, ['--eval', script], {
        encoding: 'utf-8',
        timeout: 15_000,
        env: {
          ...process.env,
          CLAUDE_MEM_DATA_DIR: dataDir,
          CLAUDE_CONFIG_DIR: join(dataDir, 'claude'),
          CLAUDE_MEM_MANAGED: 'false',
          DO_NOT_TRACK: '1',
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(status);
      expect(result.stdout.includes('health checked')).toBe(code === 'EADDRINUSE' || /in use/i.test(message));
      if (status === 0) {
        expect(result.stdout).toContain('Duplicate daemon exiting — another worker already claimed port');
        expect(result.stdout).not.toContain('Worker failed to start');
      } else {
        expect(result.stdout).toContain('Worker failed to start');
        expect(result.stdout).not.toContain('Duplicate daemon exiting');
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
