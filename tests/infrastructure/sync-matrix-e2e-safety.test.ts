import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dir, '../..');
const script = readFileSync(join(root, 'scripts/sync-matrix-e2e.ts'), 'utf8');

describe('sync matrix E2E safety contract', () => {
  it('uses only the local Miniflare runner and explicit loopback guards', () => {
    expect(script).toContain('test/run-miniflare-pro-e2e.mjs');
    expect(script).toContain("const HUB_DIR = resolve(import.meta.dir, '../workers/sync-hub')");
    expect(script).toContain("'--worker-root', HUB_DIR");
    expect(script).toContain("hostname: '127.0.0.1'");
    expect(script).toContain('refused non-loopback URL');
    expect(script).not.toContain('wrangler');
    expect(script).not.toContain('cmem.ai');
    expect(script).not.toContain('https://');
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
