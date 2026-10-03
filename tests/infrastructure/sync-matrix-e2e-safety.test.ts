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
    expect(supabaseScript).toContain("loopbackUrl(hubUrl, 'Hub')");
    expect(supabaseScript).toContain('refused non-loopback URL');
    expect(supabaseScript).not.toContain('https://');
    expect(supabaseScript).not.toContain('cmem.ai');
    expect(supabaseScript).not.toContain('supabase.co');
    expect(supabaseScript).not.toContain('wrangler');
  });

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
