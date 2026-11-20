import { expect, it } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { workerBinaryBuildOptions } from '../../scripts/worker-binary-build-options.js';

for (const format of ['cjs', 'standalone']) {
  it(`uses current data/config directories across processes sharing a cache (${format})`, async () => {
    const root = resolve(process.env.CM_RELEASE_TEST_ROOT ?? '.');
    const artifact = join(root, 'plugin/scripts/context-read-worker.cjs');
    if (!existsSync(artifact)) throw new Error('Run npm run build before release E2E tests');
    const dir = mkdtempSync(join(tmpdir(), 'cm-context-cache-'));
    try {
      const binary = join(dir, process.platform === 'win32' ? 'probe.exe' : 'probe');
      if (format === 'standalone') {
        // Actual context reader + production binary build options. Only the host
        // is a fixture; neither the Worker entry nor the protocol is replaced.
        const build = await Bun.build({ ...workerBinaryBuildOptions({ outfile: binary }), entrypoints: [
          resolve('tests/fixtures/context-environment-host.ts'), resolve('src/services/context/context-read-worker.ts'),
        ] } as any);
        expect(build.success).toBe(true);
      }
      for (const name of ['first', 'second']) {
        const data = join(dir, name); mkdirSync(data);
        const config = join(data, 'config'); const marked = join(config, 'marked'); const leaf = join(marked, 'leaf');
        mkdirSync(leaf, { recursive: true }); writeFileSync(join(marked, '.claude-mem-project'), '');
        const store = new SessionStore(join(data, 'claude-mem.db'));
        try {
          const session = store.createSDKSession('session', 'app', 'fixture');
          store.ensureMemorySessionIdRegistered(session, 'memory');
          store.storeObservation('memory', 'app', { type: 'discovery', title: name,
            subtitle: null, narrative: name, facts: [], concepts: [], files_read: [], files_modified: [] }, 1);
          new SessionSearch(store.db);
        } finally { store.close(); }
        const entry = join(data, 'context-read-worker.cjs');
        if (format === 'cjs') cpSync(artifact, entry);
        const program = `
          import {Worker} from 'node:worker_threads';
          const worker = new Worker(${JSON.stringify(entry)});
          const replies = [];
          worker.on('message', async reply => {
            replies.push(reply);
            if (replies.length === 2) { console.log(JSON.stringify({replies})); await worker.terminate(); }
          });
          worker.on('error', error => { console.error(error); process.exitCode = 1; });
          worker.postMessage({id:1, method:'searchObservations', input:{options:{project:'app'}}});
          worker.postMessage({id:2, method:'projectsForCwd', input:{cwd:${JSON.stringify(leaf)}}});
        `;
        const env = { ...process.env, DO_NOT_TRACK: '1', CLAUDE_MEM_DATA_DIR: data, CLAUDE_CONFIG_DIR: config,
          CM_PROBE_CWD: leaf, BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(dir, 'cache') };
        delete (env as Record<string, string | undefined>).BUN_BE_BUN;
        const run = spawnSync(format === 'cjs' ? process.execPath : binary, format === 'cjs' ? ['-e', program] : [],
          { encoding: 'utf8', timeout: 10_000, env });
        expect(run.status).toBe(0);
        const output = JSON.parse(run.stdout);
        let observations, projects;
        if (format === 'cjs') {
          expect(output.replies.every((reply: any) => reply.ok)).toBe(true);
          observations = output.replies.find((reply: any) => reply.id === 1).result;
          projects = output.replies.find((reply: any) => reply.id === 2).result;
        } else {
          ({ observations, projects } = output);
          expect(output.runtime.main).toMatch(/^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/);
          expect(output.runtime.version).toBe(process.versions.bun);
        }
        expect(observations.map((row: {title: string}) => row.title)).toEqual([name]);
        // A marker inside the CURRENT config directory must be ignored. A stale
        // config directory instead returns "marked", exposing env contamination.
        expect(projects).toEqual(['leaf']);
      }
      const cacheEntries = existsSync(join(dir, 'cache')) ? readdirSync(join(dir, 'cache')).length : 0;
      if (format === 'cjs' && process.versions.bun === '1.3.13') expect(cacheEntries).toBeGreaterThan(0);
      console.log(JSON.stringify({ format, cacheEntries, bun: process.versions.bun }));
    } finally {
      // SessionStore's uncached statements are finalized by GC even after close.
      // Windows cannot unlink the fixture DB until those native handles release.
      Bun.gc(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
}
