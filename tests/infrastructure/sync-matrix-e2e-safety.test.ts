import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dir, '../..');
const script = readFileSync(join(root, 'scripts/sync-matrix-e2e.ts'), 'utf8');
const supabaseScript = readFileSync(join(root, 'scripts/sync-matrix-e2e-supabase.ts'), 'utf8');

describe('sync matrix E2E safety contract', () => {
  it('uses only the local sync-api and explicit loopback guards', () => {
    expect(script).toContain("const SYNC_API_DIR = resolve(import.meta.dir, '../services/sync-api')");
    expect(script).toContain("const SYNC_API_ENTRY = resolve(SYNC_API_DIR, 'src/index.ts')");
    expect(script).toContain("'bun'");
    expect(script).toContain('SYNC_API_ENTRY');
    expect(script).toContain("hostname: '127.0.0.1'");
    expect(script).toContain('refused non-loopback URL');
    expect(script).not.toContain('wrangler');
    expect(script).not.toContain('cmem.ai');
    expect(script).not.toContain('https://');
    expect(script).not.toContain('run-miniflare-pro-e2e.mjs');
  });

  it('spawns the Hub with an allowlisted environment instead of inherited secrets or code selectors', () => {
    expect(script).toContain("const CHILD_ENV_ALLOWLIST = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']");
    expect(script).toContain('env: childEnvironment({');
    expect(script).not.toContain('...process.env');
    expect(script).not.toContain('CMEM_HUB_WORKER_ROOT: process.env');
  });

  it('defines exactly two real client identities and canonical protocol-v2 pushes', () => {
    expect(script).toContain("const DEVICE_IDS = { a: 'matrix-device-a', b: 'matrix-device-b' }");
    expect(script).not.toContain('matrix-device-c');
    expect(script).not.toContain('rawPush');
    expect(script).toContain('SessionStore');
    expect(script).toContain('CloudSync');
    expect(script).toContain('SyncApply');
    expect(script).toContain('SyncClient');
    expect(script).toContain('protocol v2');
  });

  it('is exposed as the package E2E command', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['e2e:sync-matrix']).toBe('bun scripts/sync-matrix-e2e.ts');
  });
});

describe('sync matrix E2E (Supabase cmem-sync) safety contract', () => {
  it('targets only the local Supabase Edge Function behind explicit loopback guards', () => {
    expect(supabaseScript).toContain("const DEFAULT_HUB_URL = 'http://127.0.0.1:54321/functions/v1/cmem-sync'");
    expect(supabaseScript).toContain("guardedUrl(hubUrl, 'Hub')");
    expect(supabaseScript).toContain('refused non-loopback URL');
    expect(supabaseScript).not.toContain('loopbackUrl(');
    expect(supabaseScript).not.toContain('https://');
    expect(supabaseScript).not.toContain('cmem.ai');
    expect(supabaseScript).not.toContain('supabase.co');
    expect(supabaseScript).not.toContain('wrangler');
  });

  it('allows a remote Hub only for one exact opted-in host, over TLS, and only when the Hub URL is on it', () => {
    expect(supabaseScript).toContain("process.env.CMEM_SYNC_E2E_ALLOW_REMOTE_HUB ?? ''");
    expect(supabaseScript).toContain("url.hostname === ALLOWED_REMOTE_HUB_HOST");
    expect(supabaseScript).toContain("const TLS_OF: Record<string, string> = { 'http:': 'https:', 'ws:': 'wss:' }");
    expect(supabaseScript).toContain("ALLOWED_REMOTE_HUB_HOST !== ''");
    expect(supabaseScript).toContain('CMEM_SYNC_E2E_ALLOW_REMOTE_HUB is set but the Hub URL is not on that host');
    expect(supabaseScript).not.toContain('endsWith(ALLOWED_REMOTE_HUB_HOST');
    expect(supabaseScript).not.toMatch(/ALLOWED_REMOTE_HUB_HOST\s*=\s*['"]/);
  });

  it('refuses every non-loopback host when the remote opt-in is unset or names another host', async () => {
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
    ]) {
      const result = run(env);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toMatch(/refused non-loopback URL|must be one exact hostname|not on that host/);
    }
  }, 60_000);

  it('spawns nothing and inherits no credentials beyond the two explicit test variables', () => {
    expect(supabaseScript).not.toContain('Bun.spawn');
    expect(supabaseScript).not.toContain('...process.env');
    expect(supabaseScript).toContain("requiredEnv('CMEM_SYNC_E2E_USER_ID')");
    expect(supabaseScript).toContain("requiredEnv('CMEM_SYNC_E2E_TOKEN')");
  });

  it('defines exactly two real client identities and canonical protocol-v2 pushes', () => {
    expect(supabaseScript).toContain("const DEVICE_IDS = { a: 'matrix-device-a', b: 'matrix-device-b' }");
    expect(supabaseScript).not.toContain('matrix-device-c');
    expect(supabaseScript).not.toContain('rawPush');
    expect(supabaseScript).toContain('SessionStore');
    expect(supabaseScript).toContain('CloudSync');
    expect(supabaseScript).toContain('SyncApply');
    expect(supabaseScript).toContain('SyncClient');
    expect(supabaseScript).toContain('protocol v2');
    expect(supabaseScript).toContain('finalStatus.projected_seq === finalStatus.head_seq');
  });
});
