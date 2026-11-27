import { expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('a managed worker completes import and explains missing local Codex capture without restarting it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cmem-managed-sync-'));
  const workspace = join(home, 'project');
  const data = join(home, 'data');
  mkdirSync(workspace); mkdirSync(data);
  const posts: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const route = new URL(req.url).pathname;
    if (req.method === 'POST') posts.push(route);
    if (route === '/api/sync/status') return Response.json({ configured: true, hub: { reachable: true } });
    if (route === '/api/sync/setup/import-prompts') return Response.json({ eligible: 2, confirmed: 2, queued: 0, failed: 0, skippedSources: 0, detectedAgents: ['Codex'] });
    return Response.json({ status: 'ok' });
  } });
  try {
    const account = randomUUID();
    writeFileSync(join(data, 'settings.json'), JSON.stringify({ CLAUDE_MEM_PRO_PLAN: 'cloud_sync', CLAUDE_MEM_CLOUD_SYNC_USER_ID: account }));
    const entry = join(import.meta.dir, '../../src/npx-cli/index.ts');
    const child = Bun.spawn([process.execPath, entry, 'sync', 'setup', '--agent', 'codex-cli', '--account', account], {
      cwd: workspace, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HOME: home, USERPROFILE: home,
        CLAUDE_CONFIG_DIR: join(home, 'claude'), CLAUDE_MEM_DATA_DIR: data, CLAUDE_MEM_TELEMETRY: '0', DO_NOT_TRACK: '1',
        CLAUDE_MEM_WORKER_URL: '', CLAUDE_MEM_WORKER_SCRIPT_PATH: '', CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
        CLAUDE_MEM_WORKER_PORT: String(server.port), CLAUDE_MEM_WORKER_AUTOSTART: 'false',
      },
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    expect(posts).toEqual(['/api/sync/setup/import-prompts']);
    expect(stdout).toContain('2 confirmed synced');
    expect(stdout).toContain('Future capture still needs the local agent plugin');
    expect(stdout).toContain('--setup defer --no-auto-start');
  } finally {
    await server.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
