import { describe, expect, it } from 'bun:test';
import { join } from 'path';

const root = join(import.meta.dir, '../..');

describe('sync matrix E2E safety contract', () => {
  it('refuses non-loopback PostgreSQL before starting the matrix', () => {
    const result = Bun.spawnSync(['bun', join(root, 'scripts/sync-matrix-e2e.ts')], {
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgres://postgres:postgres@database.example.test/sync_api_test' },
      stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('sync matrix refuses non-loopback PostgreSQL');
  });
});

describe('sync matrix E2E (Supabase cmem-sync) safety contract', () => {
  it('refuses every non-loopback host when the remote opt-in is unset, names other hosts, has an empty entry, or puts the Hub second', async () => {
    const run = (env: Record<string, string>) => Bun.spawnSync(['bun', join(root, 'scripts/sync-matrix-e2e-supabase.ts')], {
      env: { PATH: process.env.PATH ?? '', CMEM_SYNC_E2E_USER_ID: 'u', CMEM_SYNC_E2E_TOKEN: 't', ...env },
      stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
    });
    const remote = 'https://hub.example.test/functions/v1/cmem-sync';
    for (const env of [
      { CMEM_SYNC_E2E_HUB_URL: remote },
      { CMEM_SYNC_E2E_HUB_URL: remote, CMEM_SYNC_E2E_ALLOW_REMOTE_HUB: 'other.example.test' },
      { CMEM_SYNC_E2E_HUB_URL: 'http://hub.example.test/functions/v1/cmem-sync', CMEM_SYNC_E2E_ALLOW_REMOTE_HUB: 'hub.example.test' },
      { CMEM_SYNC_E2E_HUB_URL: remote, CMEM_SYNC_E2E_ALLOW_REMOTE_HUB: '*.example.test' },
      { CMEM_SYNC_E2E_HUB_URL: remote, CMEM_SYNC_E2E_ALLOW_REMOTE_HUB: 'other.example.test,hub.example.test' },
      { CMEM_SYNC_E2E_HUB_URL: remote, CMEM_SYNC_E2E_ALLOW_REMOTE_HUB: 'hub.example.test,*.example.test' },
      { CMEM_SYNC_E2E_HUB_URL: remote, CMEM_SYNC_E2E_ALLOW_REMOTE_HUB: 'hub.example.test,,other.example.test' },
      { CMEM_SYNC_E2E_HUB_URL: remote, CMEM_SYNC_E2E_ALLOW_REMOTE_HUB: 'hub.example.test,' },
    ]) {
      const result = run(env);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/refused non-loopback URL|must be exact hostnames|not on its first host/);
    }
  }, 60_000);

  it('fails the run on a 3xx from the Hub without contacting the redirect target', async () => {
    let targetHits = 0;
    const target = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { targetHits++; return Response.json({}); } });
    const hub = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: (request) => Response.redirect(`http://127.0.0.1:${target.port}${new URL(request.url).pathname}`, 302),
    });
    try {
      const child = Bun.spawn(['bun', join(root, 'scripts/sync-matrix-e2e-supabase.ts')], {
        env: {
          PATH: process.env.PATH ?? '', CMEM_SYNC_E2E_USER_ID: 'u', CMEM_SYNC_E2E_TOKEN: 't',
          CMEM_SYNC_E2E_HUB_URL: `http://127.0.0.1:${hub.port}/functions/v1/cmem-sync`,
        },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('refused redirect 302');
      expect(targetHits).toBe(0);
    } finally {
      hub.stop(true);
      target.stop(true);
    }
  }, 30_000);
});
