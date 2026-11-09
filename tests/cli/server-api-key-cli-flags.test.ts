import { expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// `claude-mem server api-key create` must honor --name=<v> / --scope=<v>
// (the Postgres runtime's util.parseArgs does); otherwise a key asked to be
// read-only is minted with the default read+write scopes.
const workerService = join(import.meta.dir, '..', '..', 'src', 'services', 'worker-service.ts');

it('creates the key with --name= and --scope= values', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmem-api-key-flags-')));
  try {
    const run = Bun.spawnSync([process.execPath, workerService, 'server', 'api-key', 'create', '--name=ci-bot', '--scope=memories:read'], {
      env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_MEM_DATA_DIR: join(root, 'data'), CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_MEM_TELEMETRY: '0' },
      stdout: 'pipe', stderr: 'pipe',
    });
    if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
    const out = new TextDecoder().decode(run.stdout);
    const created = JSON.parse(out.slice(out.indexOf('{')));
    expect(created.name).toBe('ci-bot');
    expect(created.scopes).toEqual(['memories:read']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
