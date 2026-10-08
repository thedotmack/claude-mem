import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const sourceRoot = resolve(import.meta.dir, '../..');

describe('JSON null observation capture', () => {
  it('durably spools parsed-null input alongside ordinary input controls', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'cmem-null-observation-'));
    const home = join(fixture, 'home');
    mkdirSync(home);
    const childPath = join(fixture, 'consumer.ts');
    writeFileSync(childPath, `
      import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const data = process.env.CLAUDE_MEM_DATA_DIR;
      mkdirSync(data, { recursive: true });
      const requests = [];
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        requests.push(new URL(request.url).pathname);
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      } });
      writeFileSync(join(data, 'settings.json'), JSON.stringify({
        CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
        CLAUDE_MEM_WORKER_PORT: String(server.port), CLAUDE_MEM_LOG_LEVEL: 'ERROR',
      }));
      try {
        const load = path => import(pathToFileURL(join(process.env.SOURCE, path)).href);
        const { rawAdapter } = await load('src/cli/adapters/raw.ts');
        const { observationHandler } = await load('src/cli/handlers/observation.ts');
        const { settleHookSpoolNudges } = await load('src/cli/spool-hook-event.ts');
        const { resolveHookSpoolDirectory } = await load('src/shared/hook-spool.ts');
        const results = [];
        for (const [name, toolInput] of [
          ['json-null', 'null'], ['json-object', '{"command":"owned"}'],
          ['direct-null', null], ['json-number', '12345'],
        ]) {
          const input = rawAdapter.normalizeInput({
            sessionId: name, cwd: process.cwd(), toolName: 'Bash',
            toolInput, toolResponse: 'owned result',
          });
          const count = () => {
            try { return readdirSync(resolveHookSpoolDirectory()).filter(x => x.endsWith('.json')).length; }
            catch { return 0; }
          };
          const before = count();
          const output = await observationHandler.execute(input);
          await settleHookSpoolNudges();
          results.push({ name, output, spooled: count() - before });
        }
        const entries = readdirSync(resolveHookSpoolDirectory())
          .filter(x => x.endsWith('.json'))
          .map(x => JSON.parse(readFileSync(join(resolveHookSpoolDirectory(), x), 'utf8')));
        console.log(JSON.stringify({ results, requests, entries, runtime: Bun.version }));
      } finally { server.stop(true); }
    `);
    try {
      const child = spawnSync(process.execPath, [childPath], {
        cwd: fixture,
        env: {
          HOME: home, PATH: dirname(process.execPath), SOURCE: sourceRoot,
          CLAUDE_MEM_DATA_DIR: join(home, 'data'), CLAUDE_MEM_TELEMETRY: '0',
          CLAUDE_MEM_TELEMETRY_ERRORS: '0', DO_NOT_TRACK: '1',
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
        timeout: 10_000, maxBuffer: 1024 * 1024, shell: false,
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stderr.toString()).toBe('');
      const receipt = JSON.parse(child.stdout.toString());
      expect(receipt.runtime).toBe(Bun.version);
      expect(receipt.results.map((r: { spooled: number }) => r.spooled)).toEqual([1, 1, 1, 1]);
      expect(receipt.results.every((r: { output: { continue: boolean } }) => r.output.continue)).toBe(true);
      expect(receipt.requests).toEqual(Array(4).fill('/api/spool/nudge'));
      expect(receipt.entries).toHaveLength(4);
      const captured = receipt.entries.find((entry: { payload: { contentSessionId: string } }) =>
        entry.payload.contentSessionId === 'json-null');
      expect(captured.payload.toolInput).toBe('null');
      expect(captured.payload.toolResponse).toBe('owned result');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 15_000);
});
