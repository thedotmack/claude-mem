import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

/**
 * scripts/resolve-data-dir.cjs is a CommonJS copy of resolveDataDir() from
 * src/shared/paths.ts, so standalone scripts like worker-logs.cjs read the
 * worker's own data directory without importing TypeScript. This resolves the
 * directory through both copies under the same HOME and environment, for every
 * settings shape the worker accepts, so the copy cannot drift from the source.
 */

const SCRIPT_RESOLVER = join(import.meta.dir, '../../scripts/resolve-data-dir.cjs');
const WORKER_PATHS = pathToFileURL(join(import.meta.dir, '../../src/shared/paths.ts')).href;

type ParityCase = {
  name: string;
  dataDirEnv?: (home: string) => string;
  settings?: (home: string) => string;
  expected: (home: string) => string;
};

const CASES: ParityCase[] = [
  { name: 'no settings file', expected: home => join(home, '.claude-mem') },
  {
    name: 'an absolute environment directory',
    dataDirEnv: home => join(home, 'env-data'),
    expected: home => join(home, 'env-data'),
  },
  {
    name: 'a home-relative environment directory',
    dataDirEnv: () => '~/env-data',
    expected: home => join(home, 'env-data'),
  },
  {
    name: 'BOM-prefixed flat settings',
    settings: home => '\uFEFF' + JSON.stringify({ CLAUDE_MEM_DATA_DIR: join(home, 'flat-data') }),
    expected: home => join(home, 'flat-data'),
  },
  {
    name: 'nested settings over a stale root copy',
    settings: home => JSON.stringify({ CLAUDE_MEM_DATA_DIR: join(home, 'stale-data'), env: { CLAUDE_MEM_DATA_DIR: '~/nested-data' } }),
    expected: home => join(home, 'nested-data'),
  },
  {
    name: 'the environment over settings',
    dataDirEnv: home => join(home, 'env-data'),
    settings: home => JSON.stringify({ env: { CLAUDE_MEM_DATA_DIR: join(home, 'stale-data') } }),
    expected: home => join(home, 'env-data'),
  },
  { name: 'an array settings document', settings: () => '[]', expected: home => join(home, '.claude-mem') },
  { name: 'corrupt settings JSON', settings: () => '{"CLAUDE_MEM_DATA_DIR": ', expected: home => join(home, '.claude-mem') },
];

describe('scripts/resolve-data-dir.cjs matches resolveDataDir() in src/shared/paths.ts', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'claude-mem-data-dir-parity-'));
    mkdirSync(join(home, '.claude-mem'), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function resolveThrough(command: string, script: string, dataDirEnv: string | undefined): string {
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.CLAUDE_MEM_DATA_DIR;
    if (dataDirEnv !== undefined) env.CLAUDE_MEM_DATA_DIR = dataDirEnv;
    const result = spawnSync(command, ['-e', script], { env, encoding: 'utf-8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }

  for (const parityCase of CASES) {
    it(`resolves ${parityCase.name} the same way`, () => {
      if (parityCase.settings) {
        writeFileSync(join(home, '.claude-mem', 'settings.json'), parityCase.settings(home));
      }
      const dataDirEnv = parityCase.dataDirEnv?.(home);

      const fromScript = resolveThrough(
        'node',
        `process.stdout.write(require(${JSON.stringify(SCRIPT_RESOLVER)}).resolveDataDir())`,
        dataDirEnv,
      );
      const fromWorker = resolveThrough(
        process.execPath,
        `const { resolveDataDir } = await import(${JSON.stringify(WORKER_PATHS)}); process.stdout.write(resolveDataDir());`,
        dataDirEnv,
      );

      expect(fromScript).toBe(fromWorker);
      expect(fromScript).toBe(parityCase.expected(home));
    });
  }
});
