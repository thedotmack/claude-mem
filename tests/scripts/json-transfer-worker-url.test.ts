import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scripts = [
  { name: 'export', args: ['needle', 'output.json'], routes: ['/api/search', '/api/sdk-sessions/batch'] },
  { name: 'import', args: ['input.json'], routes: ['/api/stats', '/api/import'] },
];

const destinations = [
  {
    name: 'selects the URL in settings',
    fileUrl: 'https://worker.example/mem/',
    expected: 'https://worker.example/mem',
  },
  {
    name: 'prefers the environment URL even with an invalid fallback port',
    fileUrl: 'https://worker.example/mem/',
    envUrl: 'http://127.0.0.1:41002/proxy/',
    port: 'invalid',
    expected: 'http://127.0.0.1:41002/proxy',
  },
  { name: 'uses the host and port when the URL is unset', expected: 'http://[::1]:41001' },
  { name: 'rejects an invalid explicit URL before making a request', fileUrl: 'http://worker.example', expected: null },
];

// Exercise both CLI entry points. Record each destination before replying with synthetic rows.
const fetchStub = `
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    console.log('REQUEST ' + url.origin + url.pathname);
    if (url.pathname.endsWith('/api/search')) return Response.json({ observations: [{ memory_session_id: 'parent' }] });
    if (url.pathname.endsWith('/api/sdk-sessions/batch')) return Response.json([]);
    if (url.pathname.endsWith('/api/stats')) return Response.json({});
    if (url.pathname.endsWith('/api/import')) return Response.json({ stats: {} });
    throw new Error('Unexpected route ' + url.pathname);
  };
`;

for (const { name, args, routes } of scripts) {
  describe(`${name}-memories worker URL`, () => {
    for (const { name: behavior, fileUrl, envUrl, port, expected } of destinations) {
      it(behavior, () => {
        const dir = mkdtempSync(join(tmpdir(), 'json-transfer-url-'));
        try {
          writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_URL: fileUrl }));
          writeFileSync(join(dir, 'input.json'), JSON.stringify({ observations: [{ title: 'fixture' }] }));
          const preload = join(dir, 'fetch.mjs');
          writeFileSync(preload, fetchStub);
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            CLAUDE_MEM_DATA_DIR: dir,
            CLAUDE_CONFIG_DIR: join(dir, 'config'),
            CLAUDE_MEM_WORKER_HOST: '::1',
            CLAUDE_MEM_WORKER_PORT: port ?? '41001',
            CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN: '0',
          };
          if (envUrl === undefined) delete env.CLAUDE_MEM_WORKER_URL;
          else env.CLAUDE_MEM_WORKER_URL = envUrl;

          const script = join(import.meta.dir, '../../scripts', `${name}-memories.ts`);
          const child = Bun.spawnSync([process.execPath, '--preload', preload, script, ...args], { cwd: dir, env });
          const requests = child.stdout.toString().split(/\r?\n/).filter(line => line.startsWith('REQUEST '));
          expect(requests).toEqual(expected === null ? [] : routes.map(route => 'REQUEST ' + expected + route));
          expect(child.exitCode, child.stderr.toString()).toBe(expected === null ? 1 : 0);
          if (expected === null) expect(child.stderr.toString()).toContain('CLAUDE_MEM_WORKER_URL');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });
}
