import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const command = fileURLToPath(new URL('../../src/npx-cli/commands/backup.ts', import.meta.url));

function runBackup(status: number, body: object) {
  return spawnSync(process.execPath, ['-e', `
    import { runBackupCommand } from ${JSON.stringify(command)};
    globalThis.fetch = async () => Response.json(${JSON.stringify(body)}, { status: ${status} });
    await runBackupCommand(['run']);
  `], {
    env: { ...process.env, CLAUDE_MEM_WORKER_URL: 'http://127.0.0.1:1' },
    encoding: 'utf8',
    timeout: 5_000,
  });
}

it('fails when a backup request is rejected because another snapshot is running', () => {
  const result = runBackup(409, { error: 'A snapshot is already running' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('A snapshot is already running');
  expect(result.stdout).not.toContain('Snapshot created');
});

it('reports success when the worker creates a snapshot', () => {
  const result = runBackup(200, { success: true, snapshot: { path: '/fixture/snapshot.db', bytes: 1024 } });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Snapshot created');
});
