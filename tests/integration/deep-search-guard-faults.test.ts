import { expect, it } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DeepSearchClient } from '../../src/services/deep-search/DeepSearchClient.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { configureToolUseIndex } from '../../src/services/sqlite/tool-use-search.js';

for (const fault of ['startup-error', 'exit-before-ready', 'terminate-hang']) {
  it(`cleans up a real child after guard ${fault}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-guard-fault-'));
    const file = join(dir, 'db'); const store = new SessionStore(file);
    let child: ReturnType<typeof spawn> | undefined;
    let client: DeepSearchClient | undefined;
    try {
      store.upsertToolUse({ toolUseId: 'one', contentSessionId: 's', project: 'app', toolName: 'Read', toolResponse: 'marker' });
      configureToolUseIndex(store.db, true);
      // Test-only dependency substitution. Keep the production child, guard
      // readiness protocol, SQLite query and parent lifecycle implementation.
      const build = await Bun.build({ entrypoints: [resolve('src/services/deep-search/child.ts')], target: 'bun',
        plugins: [{ name: 'guard-fault', setup(builder) {
          builder.onLoad({ filter: /[/\\]deep-search[/\\]child\.ts$/ }, ({ path }) => ({ loader: 'ts',
            contents: readFileSync(path, 'utf8').replace('main().catch(() => { process.exitCode = 1; });',
              'main().catch(error => { console.error(error); process.exitCode = 1; });') }));
          builder.onResolve({ filter: /^original-guard$/ }, () => ({ path: 'guard-original', namespace: 'original-guard' }));
          builder.onLoad({ filter: /.*/, namespace: 'original-guard' }, () => ({ contents: readFileSync(resolve('src/services/deep-search/guard.ts'), 'utf8'), loader: 'ts' }));
          builder.onLoad({ filter: /[/\\]deep-search[/\\]guard\.ts$/ }, () => ({ loader: 'ts', contents: `
            import {startDeepSearchGuard as start} from 'original-guard';
            import {Worker} from 'node:worker_threads';
            export async function startDeepSearchGuard(parentPid, deadline) {
              ${fault === 'terminate-hang' ? `
                const guard = await start(parentPid, deadline);
                return { underlying: guard, terminate: () => new Promise(() => {}) };
              ` : `return start(parentPid, deadline, (_code, options) => new Worker(${JSON.stringify(fault === 'startup-error'
                ? 'throw new Error("injected guard failure")' : 'process.exit(0)')}, options));`}
            }
          ` }));
        } }] });
      expect(build.success).toBe(true);
      const program = await build.outputs[0].text();
      let output = ''; let errors = '';
      client = new DeepSearchClient(file, { deadlineMs: 2000, program: async () => program,
        spawn: ((...args: Parameters<typeof spawn>) => {
          child = spawn(...args); child.stderr!.on('data', b => { errors += b; }); child.stdout!.on('data', b => { output += b; }); return child;
        }) as typeof spawn });
      const result = await client.search('marker', { project: 'app' });
      await client.close();
      if (fault === 'terminate-hang') {
        if (result.deep.status !== 'timeout') throw new Error(JSON.stringify({ result, output, errors, code: child!.exitCode, signal: child!.signalCode }));
        expect(result.deep.status).toBe('timeout');
        expect(JSON.parse(output).result.deep.status).toBe('ok');
        expect(child!.signalCode).toBe('SIGKILL');
      } else {
        expect(result.deep.status).toBe('error');
        expect(child!.exitCode).toBe(1);
        expect(errors).toContain(fault === 'startup-error' ? 'injected guard failure' : 'Deep search guard exited before readiness');
        expect(output).toBe(''); // readiness failure never reaches the query/reply
      }
      expect((store.db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as any).busy).toBe(0);
      const recovery = new DeepSearchClient(file);
      try { expect((await recovery.search('marker')).deep.status).toBe('ok'); }
      finally { await recovery.close(); }
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await client?.close(); store.close();
      Bun.gc(true); // Finalize fixture statements before unlinking SQLite files on Windows.
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
}
