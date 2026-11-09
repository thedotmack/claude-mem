import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const currentKey = 'fixture-existing-key';

// Bundle the public CLI entry with only its database and side-effecting
// lifecycle dependencies replaced. Each invocation runs in its own process,
// so process.exit and module mocks cannot leak into other test files.
async function rotate(mode: string) {
  const directory = mkdtempSync(join(tmpdir(), 'server-key-lookup-'));
  const outfile = join(directory, 'rotate.mjs');
  const stubs: Record<string, string> = {
    './runtime.js': [
      'runServerRestartCommand', 'runServerStartCommand', 'runServerStatusCommand',
      'runServerStopCommand', 'runServerWorkerStartCommand', 'runRestartCommand',
      'runServerApiKeyCommand', 'runStartCommand', 'runStatusCommand', 'runStopCommand',
    ].map(name => `export function ${name}() { throw new Error('unexpected lifecycle command'); }`).join('\n'),
    './server-jobs.js': 'export async function runServerJobsCommand() {}',
    '../../services/hooks/server-bootstrap.js': `
      export function readServerKeyRotationState(flat) {
        return { pendingRevocationKeyId: null,
          currentApiKey: flat?.CLAUDE_MEM_SERVER_API_KEY ?? null,
          currentProjectId: flat?.CLAUDE_MEM_SERVER_PROJECT_ID ?? null };
      }
      export async function revokeServerApiKey() { throw new Error('unexpected resume'); }
      export function persistServerSettings() { console.log('SETTINGS_WRITTEN'); return true; }
      export async function rotateServerApiKey(options) {
        console.log('ROTATION_CREATED:' + options.previousApiKeyId);
        const result = { rawKey: 'replacement', apiKeyId: 'replacement-id', teamId: 'team', projectId: 'project' };
        await options.beforeRevoke(result);
        return result;
      }
    `,
    '../../storage/postgres/pool.js': `
      export function createPostgresPool() {
        return {
          async query(sql) {
            if (process.env.LOOKUP_TEST_MODE === 'query-failure') throw new Error('temporary database failure');
            return { rows: sql.includes('key_hash =') && process.env.LOOKUP_TEST_MODE === 'matched'
              ? [{ id: 'previous-id' }] : [] };
          },
          async end() { console.log('LOOKUP_POOL_CLOSED'); },
        };
      }
    `,
    '../../storage/postgres/schema.js': `
      export async function ensureApiKeySchema() {
        if (process.env.LOOKUP_TEST_MODE === 'schema-failure') throw new Error('schema unavailable');
      }
    `,
  };
  try {
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({
      CLAUDE_MEM_SERVER_API_KEY: currentKey,
      CLAUDE_MEM_SERVER_PROJECT_ID: 'project',
    }));
    await build({
      stdin: { contents: "import { runServerCommand } from './src/npx-cli/commands/server.ts'; await runServerCommand(['keys', 'rotate']);", resolveDir: repositoryRoot },
      bundle: true, platform: 'node', format: 'esm', outfile,
      plugins: [{ name: 'isolated-rotation-backend', setup(builder) {
        builder.onResolve({ filter: /.*/ }, args =>
          args.importer.replaceAll('\\', '/').endsWith('/src/npx-cli/commands/server.ts') && Object.hasOwn(stubs, args.path)
            ? { path: args.path, namespace: 'rotation-fixture' } : undefined);
        builder.onLoad({ filter: /.*/, namespace: 'rotation-fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }));
      } }],
    });
    return spawnSync(process.execPath, [outfile], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: directory,
        CLAUDE_MEM_SERVER_DATABASE_URL: 'postgres://fixture@localhost/fixture', LOOKUP_TEST_MODE: mode },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const mode of ['query-failure', 'schema-failure']) {
  test(`rotation stops before creating credentials when ${mode} prevents key lookup`, async () => {
    const result = await rotate(mode);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /current API key could not be looked up/i);
    assert.match(result.stdout, /LOOKUP_POOL_CLOSED/);
    assert.doesNotMatch(result.stdout, /ROTATION_CREATED|SETTINGS_WRITTEN|"rotated"/);
    assert.ok(!result.stderr.includes(currentKey));
  });
}

test('a successful lookup still passes the old key id into rotation', async () => {
  const result = await rotate('matched');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ROTATION_CREATED:previous-id/);
  assert.match(result.stdout, /"rotated": true/);
});

test('a successful lookup with no matching key can still create a replacement', async () => {
  const result = await rotate('absent');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ROTATION_CREATED:null/);
});
