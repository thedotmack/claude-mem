import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const mode of ['claude', 'codex', 'same-millisecond']) {
  it(`saves new manual memories after session deletion (${mode})`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'manual-memory-delete-'));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child = Bun.spawn([process.execPath, 'tests/fixtures/worker/manual-memory-after-session-delete.ts', mode], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_MEM_DEDUP_ENABLED: 'false' },
        stdout: 'pipe', stderr: 'pipe',
      });
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const exitCode = await Promise.race([child.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Manual-memory ${mode} fixture exceeded 8 seconds`)), 8000);
      })]);
      expect(exitCode, (await output).join('\n')).toBe(0);
    } finally {
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null) { child.kill(); await child.exited; }
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 10000);
}
