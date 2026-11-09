import { expect, it } from 'bun:test';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it.skipIf(process.platform === 'win32')('does not report a signaled MCP process as successful', () => {
  const pkg = mkdtempSync(join(tmpdir(), 'cmem-signaled-'));
  try {
    const scripts = join(pkg, 'plugin', 'scripts');
    const cli = join(pkg, 'dist', 'npx-cli', 'index.mjs');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{}');
    const server = join(scripts, 'mcp-server.cjs');
    buildSync({
      stdin: { contents: "import { runMcpCommand } from './runtime.ts'; runMcpCommand();",
               resolveDir: resolve('src/npx-cli/commands') },
      external: ['bun:*'], platform: 'node', format: 'esm', bundle: true, outfile: cli, logLevel: 'silent',
      banner: { js: "import { createRequire as fixtureRequire } from 'node:module'; const require=fixtureRequire(import.meta.url);" },
    });
    for (const [code, expected] of [
      ['process.exit(0)', 0], ['process.exit(7)', 7], ["process.kill(process.pid, 'SIGTERM')", 1],
    ] as const) {
      writeFileSync(server, code);
      const child = spawnSync('node', [cli], { encoding: 'utf8' });
      expect(child.status).toBe(expected);
    }
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});
