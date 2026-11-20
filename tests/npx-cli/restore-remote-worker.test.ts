import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('refuses a remote-worker restore before replacing a pending local restore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmem-remote-restore-'));
  try {
    const name = 'claude-mem-next.db';
    const backup = join(dir, 'backups');
    mkdirSync(join(backup, 'auto'), { recursive: true });
    writeFileSync(join(backup, 'auto', name), 'local fixture');
    const marker = join(backup, 'restore-pending.json');
    const existing = JSON.stringify({ snapshot: 'claude-mem-previous.db', requestedAt: 123 });
    writeFileSync(marker, existing);
    const workerUrl = 'https://worker.example.test';
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_URL: workerUrl }));
    const modulePath = resolve('src/npx-cli/commands/restore.ts');
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_MEM_DATA_DIR: dir, CLAUDE_CONFIG_DIR: dir };
    delete env.CLAUDE_MEM_WORKER_URL;
    const child = spawnSync(process.execPath, ['-e',
      `import { runRestoreCommand } from ${JSON.stringify(modulePath)}; runRestoreCommand([${JSON.stringify(name)}]);`,
    ], { env, encoding: 'utf8' });
    expect(child.status).toBe(1);
    expect(readFileSync(marker, 'utf8')).toBe(existing);
    expect(child.stderr).toContain('CLAUDE_MEM_WORKER_URL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
