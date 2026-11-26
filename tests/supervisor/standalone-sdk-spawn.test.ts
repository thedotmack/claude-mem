import { afterEach, describe, expect, it } from 'bun:test';
import path from 'path';
import {
  STANDALONE_SDK_PROCESS_TYPE,
  TOTAL_PROCESS_HARD_CAP,
  createSdkSpawnFactory,
  createStandaloneSdkSpawnFactory,
  getProcessRegistry,
  isPidAlive,
  waitForSlot,
  type SpawnedSdkProcess,
} from '../../src/supervisor/process-registry.js';
import { runShutdownCascade } from '../../src/supervisor/shutdown.js';
import { scratchDir } from '../helpers/scratch-dir.js';
import { removeTempDir } from '../helpers/temp-dir.js';
import { guardSharedProcessRegistrySingleton } from './process-registry-singleton-guard.js';

// The spawn factories and waitForSlot use the module-level registry singleton.
guardSharedProcessRegistrySingleton('standalone-sdk-spawn.test.ts');

// The key a standalone observer call registers under (the session id negated,
// see standaloneObserverRegistrySessionId). The generation case below reuses
// it on purpose, to show the record type, not the key, keeps them apart.
const REGISTRY_KEY = -(process.pid + 7_000_000);
const STAY_ALIVE = { command: process.execPath, args: ['--eval', 'setInterval(() => {}, 1000)'] };

const children: Array<{ child: SpawnedSdkProcess; exit: Promise<void> }> = [];
const exits = new WeakMap<SpawnedSdkProcess, Promise<void>>();
const tempDirs: string[] = [];

function spawnWith(factory: (options: typeof STAY_ALIVE) => SpawnedSdkProcess): SpawnedSdkProcess {
  const child = factory({ ...STAY_ALIVE });
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  exits.set(child, exit);
  children.push({ child, exit });
  return child;
}

function recordsUnderKey() {
  return getProcessRegistry().getBySession(REGISTRY_KEY);
}

function exited(child: SpawnedSdkProcess): Promise<void> {
  return exits.get(child)!;
}

describe('standalone observer SDK children in the process registry', () => {
  // Inside the describe, so it runs before the top-level singleton guard checks.
  afterEach(async () => {
    for (const { child, exit } of children.splice(0)) {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      await exit;
    }
    for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
  });

  it('lets two standalone calls for one session run at once', async () => {
    const first = spawnWith(createStandaloneSdkSpawnFactory(REGISTRY_KEY));
    const second = spawnWith(createStandaloneSdkSpawnFactory(REGISTRY_KEY));

    // Long enough for a SIGTERM sent at spawn time to have landed.
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(first.exitCode).toBeNull();
    expect(second.exitCode).toBeNull();
    const records = recordsUnderKey();
    expect(records).toHaveLength(2);
    expect(records.every(record => record.type === STANDALONE_SDK_PROCESS_TYPE)).toBe(true);
    expect(records.every(record => isPidAlive(record.pid))).toBe(true);
  });

  it('neither stops nor is stopped by a generation SDK child under the same key', async () => {
    const generation = spawnWith(createSdkSpawnFactory(REGISTRY_KEY));
    const standalone = spawnWith(createStandaloneSdkSpawnFactory(REGISTRY_KEY));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(generation.exitCode).toBeNull();

    // A new generation stops the old one, as before, and leaves the standalone child alone.
    const nextGeneration = spawnWith(createSdkSpawnFactory(REGISTRY_KEY));
    await exited(generation);
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(standalone.exitCode).toBeNull();
    expect(nextGeneration.exitCode).toBeNull();
    expect(recordsUnderKey().map(record => record.type).sort()).toEqual(['sdk', STANDALONE_SDK_PROCESS_TYPE]);
  });

  it('is stopped and unregistered by the shutdown cascade', async () => {
    const registry = getProcessRegistry();
    spawnWith(createStandaloneSdkSpawnFactory(REGISTRY_KEY));
    spawnWith(createStandaloneSdkSpawnFactory(REGISTRY_KEY));
    const pids = recordsUnderKey().map(record => record.pid);
    expect(pids).toHaveLength(2);

    // The cascade stops every record in the registry. Refuse to run it over
    // anything this test did not start.
    expect(registry.getAll().filter(record => !pids.includes(record.pid))).toEqual([]);

    const tempDir = scratchDir('standalone-sdk-shutdown');
    tempDirs.push(tempDir);
    await runShutdownCascade({ registry, pidFilePath: path.join(tempDir, 'worker.pid') });

    expect(pids.some(pid => isPidAlive(pid))).toBe(false);
    expect(recordsUnderKey()).toEqual([]);
  });

  it('applies env overrides after stripping the host CLAUDE_CODE_* variables (#6503)', async () => {
    const printEnv = {
      command: process.execPath,
      args: ['--eval', "process.stdout.write([process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, process.env.CLAUDE_CODE_EFFORT_LEVEL].map(v => v ?? '<unset>').join(','))"],
      env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '99999', CLAUDE_CODE_EFFORT_LEVEL: 'high' },
    };
    const read = async (child: SpawnedSdkProcess): Promise<string> => {
      let out = '';
      child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      await new Promise(resolve => child.once('exit', resolve));
      return out;
    };

    const capped = createStandaloneSdkSpawnFactory(REGISTRY_KEY, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '3200' })(printEnv as never);
    expect(await read(capped)).toBe('3200,<unset>');

    const uncapped = createStandaloneSdkSpawnFactory(REGISTRY_KEY)(printEnv as never);
    expect(await read(uncapped)).toBe('<unset>,<unset>');
  });

  it('takes no generation slot, even past the registry hard cap', async () => {
    for (let i = 0; i <= TOTAL_PROCESS_HARD_CAP; i += 1) {
      spawnWith(createStandaloneSdkSpawnFactory(REGISTRY_KEY));
    }
    expect(recordsUnderKey()).toHaveLength(TOTAL_PROCESS_HARD_CAP + 1);

    // With a limit of one, a counted child would park this call or, over the
    // hard cap, make it throw. The slot must be granted at once.
    const reservation = await waitForSlot(1);
    reservation.release();
  });
});
