import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
for (const kind of ['read', 'write', 'edit', 'string-result', 'canonical-read', 'memory-control']) {
  it(`OpenClaw actual completion preserves ${kind}`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'owned-openclaw-tools-'));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child = Bun.spawn([process.execPath, 'tests/fixtures/openclaw/tool-completion.ts', kind], {
        cwd: process.cwd(), env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_MEM_WORKER_HOST: '127.0.0.1' }, stdout: 'pipe', stderr: 'pipe',
      });
      const exit = await Promise.race([child.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned OpenClaw fixture exceeded 8 seconds')), 8000);
      })]);
      const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
      console.log(output);
      expect(exit, output).toBe(0);
    } finally {
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null) { child.kill(); await child.exited; }
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 10000);
}
