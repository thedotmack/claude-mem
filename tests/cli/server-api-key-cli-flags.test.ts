import { expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// `claude-mem server api-key create` must honor --name=<v> / --scope=<v>
// (the Postgres runtime's util.parseArgs does); otherwise a key asked to be
// read-only is minted with the default read+write scopes.
const workerService = join(import.meta.dir, '..', '..', 'src', 'services', 'worker-service.ts');

function runApiKeyCli(root: string, args: string[]) {
  const run = Bun.spawnSync([process.execPath, workerService, 'server', 'api-key', ...args], {
    env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_MEM_DATA_DIR: join(root, 'data'), CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_MEM_TELEMETRY: '0' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const out = new TextDecoder().decode(run.stdout);
  // Skip log lines such as `[SETTINGS] ...` printed before the JSON output.
  const start = out.search(/^(?:\{|\[(?:\]|$))/m);
  return {
    exitCode: run.exitCode,
    stderr: new TextDecoder().decode(run.stderr),
    json: () => JSON.parse(out.slice(start)),
  };
}

it('creates the key with --name= and --scope= values', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmem-api-key-flags-')));
  try {
    const run = runApiKeyCli(root, ['create', '--name=ci-bot', '--scope=memories:read']);
    if (run.exitCode !== 0) throw new Error(run.stderr);
    const created = run.json();
    expect(created.name).toBe('ci-bot');
    expect(created.scopes).toEqual(['memories:read']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

// A bare --scope used to be read as the scope list ["true"], minting an
// active key that no route would ever authorize.
it('rejects create with a --scope that has no value and stores no key', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmem-api-key-flags-')));
  try {
    const bare = runApiKeyCli(root, ['create', '--scope']);
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain('Usage: worker-service server api-key create');

    const list = runApiKeyCli(root, ['list']);
    if (list.exitCode !== 0) throw new Error(list.stderr);
    expect(list.json()).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

// A bare --project must be a usage error: read as the project "true" it is
// wrong, and read as "no project" it would mint an unrestricted key.
it('rejects create with a --project, --team or --name that has no value and stores no key', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmem-api-key-flags-')));
  try {
    for (const args of [['--name', 'ci', '--project'], ['--project=', '--name', 'ci'], ['--team', '--name', 'ci'], ['--name']]) {
      const bare = runApiKeyCli(root, ['create', ...args]);
      expect(bare.exitCode).toBe(1);
      expect(bare.stderr).toContain('Usage: worker-service server api-key create');
    }

    const list = runApiKeyCli(root, ['list']);
    if (list.exitCode !== 0) throw new Error(list.stderr);
    expect(list.json()).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

it('rejects migrate-scopes with a --scope that has no value and keeps the key scopes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmem-api-key-flags-')));
  try {
    const create = runApiKeyCli(root, ['create', '--scope', 'memories:read']);
    if (create.exitCode !== 0) throw new Error(create.stderr);
    const { id } = create.json();

    const bare = runApiKeyCli(root, ['migrate-scopes', id, '--scope']);
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain('Usage: worker-service server api-key migrate-scopes');

    const list = runApiKeyCli(root, ['list']);
    if (list.exitCode !== 0) throw new Error(list.stderr);
    expect(list.json().map((key: { scopes: string[] }) => key.scopes)).toEqual([['memories:read']]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
