import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const WORKER_SPAWNER_PATH = join(import.meta.dir, '../../src/services/worker-spawner.ts');
const WORKER_SERVICE_PATH = join(import.meta.dir, '../../src/services/worker-service.ts');
const spawnerSource = readFileSync(WORKER_SPAWNER_PATH, 'utf-8');
const workerServiceSource = readFileSync(WORKER_SERVICE_PATH, 'utf-8');

describe('worker spawner stale-socket recovery (#3112)', () => {
  it('probes port bindability before spawning a daemon', () => {
    expect(spawnerSource).toContain('probePortBind(port)');
    expect(spawnerSource.indexOf('probePortBind(port)')).toBeLessThan(
      spawnerSource.indexOf('spawnDaemon(workerScriptPath, port)')
    );
  });

  it('treats EADDRINUSE without a healthy worker as a stale socket', () => {
    expect(spawnerSource).toContain("bindError === 'EADDRINUSE'");
    expect(spawnerSource).toContain('Worker port is still bound but no healthy worker responded');
    expect(spawnerSource).toContain('CLAUDE_MEM_WORKER_PORT/CLAUDE_MEM_WORKER_HOST');
  });

  it('preserves non-EADDRINUSE bind errors as configuration diagnostics', () => {
    expect(spawnerSource).toContain('Worker port bind probe failed before spawn');
    expect(spawnerSource).toContain('bindError');
  });
});

describe('worker-service start root convergence (#3134)', () => {
  it('uses the canonical worker script resolver for start lifecycle launches', () => {
    expect(workerServiceSource).toContain('ensureWorkerStartedShared(port, resolveWorkerScriptPath() ?? __filename)');
  });
});
