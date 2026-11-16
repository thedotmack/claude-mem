import { describe, it, expect, mock, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import * as realWorkerSpawner from '../../src/services/worker-spawner.js';
import { resolveWorkerScriptPath } from '../../src/shared/worker-utils.js';

/**
 * #6228: the CLI `start` path (worker-service.ts's ensureWorkerStarted
 * wrapper) handed the shared spawner its own __filename, so a bundle invoked
 * from the marketplace clone — e.g. through a leftover pre-12.4.7
 * `alias claude-mem=` — rooted the daemon in that clone, whose plugin/ has no
 * node_modules. `restart` and the dying worker's handoff already spawn
 * `resolveWorkerScriptPath() ?? __filename`; `start` must consult the same
 * single oracle.
 *
 * The whole suite runs in one bun process and `mock.module` mutates the
 * shared module registry, so snapshot the real spawner namespace before the
 * mock is installed and put it back in afterAll — same pattern as
 * tests/services/worker-spawner.test.ts.
 */
const realWorkerSpawnerSnapshot = { ...realWorkerSpawner };

const spawnerCalls: Array<{ port: number; scriptPath: string }> = [];
const workerSpawner = {
  ensureWorkerStarted: mock(async (port: number, scriptPath: string) => {
    spawnerCalls.push({ port, scriptPath });
    return 'ready' as const;
  }),
  getLastWorkerBootFailure: mock((): string | undefined => undefined),
};
mock.module('../../src/services/worker-spawner.js', () => workerSpawner);

afterAll(() => {
  mock.module('../../src/services/worker-spawner.js', () => realWorkerSpawnerSnapshot);
});

const { ensureWorkerStarted } = await import('../../src/services/worker-service.js');

// The wrapper's own __filename: the file the `start` command was invoked as.
// In the bug this is exactly what the spawner received, whatever the resolver
// knew about the real install.
const OWN_FILENAME = resolve(join(import.meta.dir, '..', '..', 'src', 'services', 'worker-service.ts'));

const TEST_PORT = 37777;
const ORIGINAL_OVERRIDE = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
let fakeInstallDir: string;
let fakeResolvedScript: string;

beforeEach(() => {
  spawnerCalls.length = 0;
  workerSpawner.ensureWorkerStarted.mockClear();
  fakeInstallDir = mkdtempSync(join(tmpdir(), 'cmem-start-resolver-'));
  fakeResolvedScript = join(fakeInstallDir, 'worker-service.cjs');
  writeFileSync(fakeResolvedScript, '#!/usr/bin/env bun\n// fake dependency-complete install\n');
});

afterEach(() => {
  if (ORIGINAL_OVERRIDE === undefined) delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
  else process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = ORIGINAL_OVERRIDE;
  rmSync(fakeInstallDir, { recursive: true, force: true });
});

describe('worker-service ensureWorkerStarted (start command) script resolution', () => {
  it('spawns the resolver’s script, not the invoked bundle’s __filename', async () => {
    // The resolver's documented opt-in override stands in for the installed
    // cache copy the resolver would pick on a real machine.
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = fakeResolvedScript;

    const result = await ensureWorkerStarted(TEST_PORT);

    expect(result).toBe('ready');
    expect(spawnerCalls).toEqual([{ port: TEST_PORT, scriptPath: fakeResolvedScript }]);
    expect(spawnerCalls[0].scriptPath).not.toBe(OWN_FILENAME);
  });

  it('without an override, spawns whatever the resolver oracle answers (falling back to __filename only when it has none)', async () => {
    delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;

    const result = await ensureWorkerStarted(TEST_PORT);

    expect(result).toBe('ready');
    expect(spawnerCalls).toEqual([
      { port: TEST_PORT, scriptPath: resolveWorkerScriptPath() ?? OWN_FILENAME },
    ]);
  });

  it('ignores a stale override pointing at a missing file instead of spawning it blindly', async () => {
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = join(fakeInstallDir, 'does-not-exist.cjs');

    const result = await ensureWorkerStarted(TEST_PORT);

    expect(result).toBe('ready');
    expect(spawnerCalls).toEqual([
      { port: TEST_PORT, scriptPath: resolveWorkerScriptPath() ?? OWN_FILENAME },
    ]);
  });
});
