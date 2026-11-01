import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('retrieves delayed observations and a Stop summary on their capture day', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hook-spool-timestamps-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Optional integration mocks stay in this child rather than leaking to the suite.
    child = Bun.spawn([process.execPath, 'tests/fixtures/worker/hook-spool-timestamps.ts'], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: join(dataDir, 'claude') },
      stdout: 'pipe', stderr: 'pipe',
    });
    const exitCode = await Promise.race([child.exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Hook-spool timestamp fixture exceeded 8 seconds')), 8000);
    })]);
    const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
    expect(exitCode, output).toBe(0);
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 10000);
