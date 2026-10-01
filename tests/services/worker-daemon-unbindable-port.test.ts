import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const WORKER_SERVICE = join(import.meta.dir, '../../src/services/worker-service.ts');
/** WORKER_BOOT_FAILED_EXIT_CODE in src/services/worker-service.ts. */
const BOOT_FAILED_EXIT_CODE = 78;

function readLogs(dataDir: string): string {
  const logsDir = join(dataDir, 'logs');
  if (!existsSync(logsDir)) return '';
  return readdirSync(logsDir).map((name) => readFileSync(join(logsDir, name), 'utf-8')).join('\n');
}

describe('worker daemon on a host and port the system will not bind', () => {
  it('exits as a boot failure naming the errno, never as a duplicate (exit 0)', () => {
    // #3219 classified every bind error but EADDRINUSE as "port in use", so the
    // daemon's duplicate gate exited 0 with "refusing to start duplicate" and
    // the errno was never reported.
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-unbindable-'));
    try {
      const result = spawnSync('bun', [WORKER_SERVICE, '--daemon'], {
        encoding: 'utf-8',
        timeout: 60_000,
        env: {
          ...process.env,
          CLAUDE_MEM_DATA_DIR: dataDir,
          // TEST-NET-1 (RFC 5737) is never an address of this machine, so
          // bind() fails with EADDRNOTAVAIL on every platform.
          CLAUDE_MEM_WORKER_HOST: '192.0.2.1',
          CLAUDE_MEM_WORKER_PORT: '37988',
          DO_NOT_TRACK: '1',
        },
      });

      const logs = readLogs(dataDir);
      expect(result.status).toBe(BOOT_FAILED_EXIT_CODE);
      expect(logs).toContain('Worker port cannot be bound');
      expect(logs).toContain('EADDRNOTAVAIL');
      expect(logs).not.toContain('refusing to start duplicate');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});
