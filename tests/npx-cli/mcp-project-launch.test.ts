import { afterAll, beforeAll, expect, it } from 'bun:test';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'cmem-mcp-'));
const project = join(root, 'workspace');
const pkg = join(root, 'package');
const scripts = join(pkg, 'plugin', 'scripts');
const server = join(scripts, 'mcp-server.cjs');
const cli = join(pkg, 'dist', 'npx-cli', 'index.mjs');

beforeAll(() => {
  mkdirSync(project);
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{}');
  buildSync({
    stdin: {
      contents: "import { runMcpCommand } from './runtime.ts'; runMcpCommand();",
      resolveDir: resolve('src/npx-cli/commands'),
    },
    external: ['bun:*'], platform: 'node', format: 'esm', bundle: true, outfile: cli, logLevel: 'silent',
    banner: { js: "import { createRequire as createFixtureRequire } from 'node:module'; const require = createFixtureRequire(import.meta.url);" },
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

it('launches the packaged MCP script in the checkout that invoked the CLI', () => {
  writeFileSync(server, 'console.log(process.cwd())');
  const run = spawnSync(process.argv0, [cli], { cwd: project, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr || String(run.error));
  expect(realpathSync(run.stdout.trim())).toBe(realpathSync(project));
});

it.skipIf(process.platform === 'win32')('does not report a signaled MCP process as successful', () => {
  for (const [code, expected] of [
    ['process.exit(0)', 0], ['process.exit(7)', 7], ["process.kill(process.pid, 'SIGTERM')", 1],
  ] as const) {
    writeFileSync(server, code);
    const child = spawnSync('node', [cli], { encoding: 'utf8' });
    expect(child.status).toBe(expected);
  }
});
