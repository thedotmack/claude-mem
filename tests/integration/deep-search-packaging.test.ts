import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { configureToolUseIndex } from '../../src/services/sqlite/tool-use-search.js';

describe('deep search release artifacts', () => {
  for (const format of ['cjs', 'standalone']) {
    it(`runs real queries and recovers from a deadline using the ${format} artifact`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'cm-deep-package-'));
      const dbPath = join(dir, 'memory.db');
      const store = new SessionStore(dbPath);
      try {
        mkdirSync(join(dir, 'node_modules')); // disable implicit dependency installation
        store.upsertToolUse({ toolUseId: 'one', contentSessionId: 's', project: 'one', toolName: 'Read', toolResponse: 'unique_marker 中文' });
        configureToolUseIndex(store.db, true);
        const output = join(dir, format === 'cjs' ? 'probe.cjs' : process.platform === 'win32' ? 'probe.exe' : 'probe');
        const entry = resolve('tests/fixtures/deep-search-host.ts');
        const buildScript = join(dir, 'build.mjs');
        writeFileSync(buildScript, `
          import { workerBinaryBuildOptions } from ${JSON.stringify(pathToFileURL(resolve('scripts/worker-binary-build-options.js')).href)};
          import { deepSearchBuildPlugin } from ${JSON.stringify(pathToFileURL(resolve('scripts/deep-search-build.js')).href)};
          import { build } from ${JSON.stringify(pathToFileURL(resolve('node_modules/esbuild/lib/main.js')).href)};
          ${format === 'standalone' ? `
            const result = await Bun.build({...workerBinaryBuildOptions({root:${JSON.stringify(process.cwd())},outfile:${JSON.stringify(output)}}),entrypoints:[${JSON.stringify(entry)}]});
            if (!result.success) throw new Error(String(result.logs));
          ` : `
            await build({entryPoints:[${JSON.stringify(entry)}], outfile:${JSON.stringify(output)}, bundle:true, platform:'node', format:'cjs',
              external:['bun:sqlite'], minify:true, plugins:[deepSearchBuildPlugin(${JSON.stringify(process.cwd())})]});
          `}
        `);
        const build = spawnSync(process.execPath, [buildScript], { encoding: 'utf8', timeout: 30_000 });
        expect(build.status).toBe(0);
        rmSync(buildScript);
        const run = (query: string, deadlineMs = 1000, runtimeVersion?: string) => {
          const result = spawnSync(format === 'standalone' ? output : process.execPath, format === 'cjs' ? [output] : [], {
            cwd: dir, encoding: 'utf8', timeout: 5000,
            env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), DO_NOT_TRACK: '1' },
            input: JSON.stringify({ dbPath, query, deadlineMs, runtimeVersion, options: { project: 'one' } }),
          });
          expect(result.status).toBe(0);
          expect(result.stderr).toBe('');
          if (!result.stdout.trim()) throw new Error(`No probe reply (${format}, status=${result.status}, signal=${result.signal})`);
          return JSON.parse(result.stdout);
        };
        for (let attempt = 0; attempt < 3; attempt++) expect(run('unique_marker').toolUses).toHaveLength(1);
        expect(run('中文').toolUses[0].snippet).toContain('中文');
        expect(run('unique_marker', 1).deep.status).toBe('timeout');
        expect(run('unique_marker').deep.complete).toBe(true);
        if (format === 'standalone') expect(run('unique_marker', 1000, '1.2.15').deep.status).toBe('unsupported');
        expect((store.db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as any).busy).toBe(0);
      } finally {
        store.close();
        Bun.gc(true); // Finalize fixture statements before unlinking SQLite files on Windows.
        rmSync(dir, { recursive: true, force: true });
      }
    }, 40_000);
  }
});
