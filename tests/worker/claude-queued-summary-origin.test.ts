import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

for (const kind of ['next-prompt', 'older-observation', 'spooled-stop', 'legacy-queue', 'control']) {
  it(`SDK queued-summary origin preserves ${kind}`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'queued-summary-origin-'));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Module mocks and SDK process ownership stay in this owned child.
      child = Bun.spawn([process.execPath, 'tests/fixtures/worker/queued-summary-origin.ts', kind], {
        cwd: process.cwd(), env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir }, stdout: 'pipe', stderr: 'pipe',
      });
      const exitCode = await Promise.race([child.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned SDK fixture exceeded 8 seconds')), 8000);
      })]);
      const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
      expect(output).toContain('Owned summary');
      expect(exitCode, output).toBe(0);
    } finally {
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null) { child.kill(); await child.exited; }
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 10000);
}
