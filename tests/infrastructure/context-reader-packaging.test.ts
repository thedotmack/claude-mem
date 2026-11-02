import { describe, expect, it } from 'bun:test';
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertContextReadResponsive } from '../helpers/context-read-http-probe.js';

const banner = [
  'var __CM_FILENAME__ = typeof __filename !== "undefined" ? __filename : require("node:path").resolve(process.argv[1] || "");',
  'var __CM_DIRNAME__ = typeof __dirname !== "undefined" ? __dirname : require("node:path").dirname(__CM_FILENAME__);',
  'var __IMPORT_META_URL__ = require("node:url").pathToFileURL(__CM_FILENAME__).href;',
].join('\n');

describe('context reader packaging', () => {
  it('serves context from the built reader without a node_modules directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-mem-reader-bundle-'));
    try {
      const entry = join(directory, 'http-fixture.cjs');
      await build({
        absWorkingDir: process.cwd(),
        entryPoints: ['tests/fixtures/context-read-http-server.ts'],
        outfile: entry,
        bundle: true, platform: 'node', target: 'node18', format: 'cjs', minify: true,
        alias: { 'zod/v4': 'zod' },
        external: ['bun:sqlite', 'bun:ffi', 'better-auth', 'better-auth/node', 'better-auth/plugins', '@better-auth/api-key', '@opentelemetry/*'],
        define: { __dirname: '__CM_DIRNAME__', __filename: '__CM_FILENAME__', 'import.meta.url': '__IMPORT_META_URL__' },
        banner: { js: banner },
        logLevel: 'silent',
      });
      copyFileSync(join(process.cwd(), 'plugin/scripts/context-read-worker.cjs'), join(directory, 'context-read-worker.cjs'));
      expect(existsSync(join(directory, 'node_modules'))).toBe(false);
      await assertContextReadResponsive({ entry, cwd: directory });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it('loads its embedded reader in a standalone executable from an empty working directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-mem-reader-executable-'));
    try {
      const entry = join(directory, process.platform === 'win32' ? 'http-fixture.exe' : 'http-fixture');
      const result = Bun.spawnSync([
        process.execPath, 'build', '--compile', '--entry-naming', '[name].js',
        './tests/fixtures/context-read-http-server.ts', './src/services/context/context-read-worker.ts',
        '--external', 'better-auth', '--external', 'better-auth/node', '--external', 'better-auth/plugins',
        '--external', '@better-auth/api-key', '--external', '@opentelemetry/*',
        '--outfile', entry,
      ], { cwd: process.cwd(), env: process.env });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      expect(existsSync(join(directory, 'context-read-worker.ts'))).toBe(false);
      expect(existsSync(join(directory, 'context-read-worker.cjs'))).toBe(false);
      expect(existsSync(join(directory, 'node_modules'))).toBe(false);
      await assertContextReadResponsive({ entry, cwd: directory, executable: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
