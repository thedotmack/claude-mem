import { workerBinaryBuildOptions } from '../../scripts/worker-binary-build-options.js';
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const banner = [
  'var __CM_FILENAME__ = typeof __filename !== "undefined" ? __filename : require("node:path").resolve(process.argv[1] || "");',
  'var __CM_DIRNAME__ = typeof __dirname !== "undefined" ? __dirname : require("node:path").dirname(__CM_FILENAME__);',
  'var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__CM_FILENAME__).href;',
].join('\n');

const bundle = (entryPoint: string, outfile: string) => build({
  absWorkingDir: process.cwd(),
  entryPoints: [entryPoint],
  outfile,
  bundle: true, platform: 'node', target: 'node18', format: 'cjs', minify: true,
  external: ['bun:sqlite'],
  define: { __dirname: '__CM_DIRNAME__', __filename: '__CM_FILENAME__', 'import.meta.url': '__IMPORT_META_URL__' },
  banner: { js: banner },
  logLevel: 'silent',
});

/** Reads through the packaged reader with a real lock holding that read open, while the same process answers /health. */
async function assertReadStaysResponsive(command: string[], cwd: string): Promise<void> {
  const databasePath = join(cwd, 'source.db');
  const source = new Database(databasePath);
  source.exec('CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER)');
  source.prepare('INSERT INTO work_state_entries VALUES (1, ?, ?, ?, ?)').run('example-project', 'example-work', JSON.stringify({
    task: 'Build the local viewer', status: 'done', request_id: 'viewer-request', human_request: 'Build a local work viewer',
  }), Date.now());
  const child = spawn(command[0], command.slice(1), {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORK_VIEW_READ_FIXTURE_DB: databasePath, CLAUDE_MEM_DATA_DIR: cwd, CLAUDE_CONFIG_DIR: cwd, CLAUDE_MEM_TELEMETRY_ENABLED: 'false', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
  });
  try {
    let stdout = '', stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout.on('data', chunk => {
        stdout += chunk;
        const match = /READER_HTTP_PORT=(\d+)/.exec(stdout);
        if (match) resolve(Number(match[1]));
      });
      child.once('exit', code => reject(new Error(`Fixture exited ${code}: ${stderr}`)));
    });
    const origin = `http://127.0.0.1:${port}`;
    // Starts the worker, so the next read reaches the lock at once rather than while it loads.
    const warm = await fetch(`${origin}/read`);
    if (!warm.ok) throw new Error(`First read failed: ${await warm.text()}\n${stderr}`);
    expect(await warm.json()).toEqual({ connected: true, requests: 1 });

    source.exec('BEGIN EXCLUSIVE');
    let readFinished = false;
    const held = fetch(`${origin}/read`).then(response => { readFinished = true; return response; });
    await Bun.sleep(100);
    expect((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok).toBe(true);
    expect(readFinished).toBe(false);
    source.exec('ROLLBACK');
    expect(await (await held).json()).toEqual({ connected: true, requests: 1 });
  } finally {
    if (source.inTransaction) source.exec('ROLLBACK');
    source.close();
    child.kill();
  }
}

describe('work view reader packaging', () => {
  it('reads from the built reader beside its bundle, without a node_modules directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'work-view-reader-bundle-'));
    try {
      const entry = join(directory, 'http-fixture.cjs');
      await bundle('tests/fixtures/work-view-read-http-server.ts', entry);
      await bundle('src/services/work-view/work-view-read-worker.ts', join(directory, 'work-view-read-worker.cjs'));
      expect(existsSync(join(directory, 'node_modules'))).toBe(false);
      await assertReadStaysResponsive([process.execPath, entry], directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('loads its embedded reader in a standalone executable from an empty working directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'work-view-reader-executable-'));
    try {
      const entry = join(directory, process.platform === 'win32' ? 'http-fixture.exe' : 'http-fixture');
      const compiled = Bun.spawnSync([
        process.execPath, 'build', '--compile', '--entry-naming', '[name].js',
        './tests/fixtures/work-view-read-http-server.ts', './src/services/work-view/work-view-read-worker.ts',
        '--outfile', entry,
      ], { cwd: process.cwd(), env: process.env });
      if (compiled.exitCode !== 0) throw new Error(new TextDecoder().decode(compiled.stderr));
      expect(existsSync(join(directory, 'work-view-read-worker.ts'))).toBe(false);
      expect(existsSync(join(directory, 'work-view-read-worker.cjs'))).toBe(false);
      await assertReadStaysResponsive([entry], directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('is an entry of every build that packages the worker', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(packageJson.scripts['build:cli-binary']).toContain('scripts/build-native-worker.js');
    expect(workerBinaryBuildOptions({ outfile: 'unused' }).entrypoints.some((entry: string) => entry.endsWith('/src/services/work-view/work-view-read-worker.ts') || entry.endsWith('\\src\\services\\work-view\\work-view-read-worker.ts'))).toBe(true);
    expect(readFileSync('scripts/build-worker-binary.js', 'utf8')).toContain("'./plugin/scripts/work-view-read-worker.cjs'");
    expect(readFileSync('scripts/build-hooks.js', 'utf8')).toContain("source: 'src/services/work-view/work-view-read-worker.ts'");
  });
});
