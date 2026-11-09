import { expect, it } from 'bun:test';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('launches the packaged MCP script in the checkout that invoked the CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'cmem-mcp-cwd-'));
  try {
    const project = join(root, 'workspace');
    const pkg = join(root, 'package');
    const scripts = join(pkg, 'plugin', 'scripts');
    const cli = join(pkg, 'dist', 'npx-cli', 'index.mjs');
    mkdirSync(project);
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{}');
    writeFileSync(join(scripts, 'mcp-server.cjs'), 'console.log(process.cwd())');
    buildSync({
      stdin: {
        contents: "import { runMcpCommand } from './runtime.ts'; runMcpCommand();",
        resolveDir: resolve('src/npx-cli/commands'),
      },
      external: ['bun:*'], platform: 'node', format: 'esm', bundle: true, outfile: cli, logLevel: 'silent',
      banner: { js: "import { createRequire as createFixtureRequire } from 'node:module'; const require = createFixtureRequire(import.meta.url);" },
    });
    const run = spawnSync(process.argv0, [cli], { cwd: project, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr || String(run.error));
    expect(realpathSync(run.stdout.trim())).toBe(realpathSync(project));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
