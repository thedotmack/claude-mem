import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = join(__dirname, '..', '..');

// printHelp() reads the package version relative to dist/npx-cli/, so run a
// bundle laid out like the published package instead of the TypeScript source.
const packageRoot = mkdtempSync(join(tmpdir(), 'claude-mem-help-pkg-'));
const cliEntry = join(packageRoot, 'dist', 'npx-cli', 'index.js');

beforeAll(() => {
  mkdirSync(join(packageRoot, 'dist', 'npx-cli'), { recursive: true });
  copyFileSync(join(repoRoot, 'package.json'), join(packageRoot, 'package.json'));
  const build = spawnSync(
    process.execPath,
    ['build', join(repoRoot, 'src', 'npx-cli', 'index.ts'), '--target', 'node', '--outfile', cliEntry],
    { encoding: 'utf-8', cwd: repoRoot, timeout: 120_000 },
  );
  if (build.status !== 0) throw new Error(`bundling the CLI failed: ${build.stderr}`);
});

afterAll(() => {
  rmSync(packageRoot, { recursive: true, force: true });
});

function runCli(args: string[]) {
  // Isolated HOME so a regression that runs the real command cannot touch a real install.
  const home = mkdtempSync(join(tmpdir(), 'claude-mem-help-'));
  // Drop inherited pointers at a real install so every path resolves inside the temp home.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CLAUDE_MEM_DATA_DIR: join(home, '.claude-mem'),
    // Bun's transpiler cache lands in ~/Library/Caches/bun on macOS; it is not CLI output.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
  };
  delete env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
  delete env.CLAUDE_PLUGIN_ROOT;
  try {
    const result = spawnSync(process.execPath, [cliEntry, ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdin: 'ignore',
      cwd: home,
      env,
    });
    // Bun itself creates ~/.bun for its runtime cache; that is not CLI output.
    return { ...result, homeEntries: readdirSync(home).filter((entry) => entry !== '.bun') };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('npx CLI subcommand --help', () => {
  for (const sub of ['install', 'update', 'upgrade', 'uninstall', 'remove', 'repair', 'prune', 'start', 'stop', 'restart']) {
    for (const flag of ['--help', '-h']) {
      it(`${sub} ${flag} prints help and does not run the command`, () => {
        const r = runCli([sub, flag]);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('Install Commands');
        expect(r.stdout).not.toContain('Stopped running worker');
        expect(r.stdout).not.toContain('Uninstall');
        expect(r.stdout).not.toContain('Cache root:');
        expect(r.homeEntries).toEqual([]);
      });
    }
  }
});
