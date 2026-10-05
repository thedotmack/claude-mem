import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const provider of ['gemini', 'gemini-control', 'claude']) {
  it(`keeps the claimed observation's prompt context during ${provider} field compression`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-compression-context-'));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child = Bun.spawn([process.execPath, join(import.meta.dir, '../fixtures/worker/observation-context-compression.ts'), provider],
        { env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir }, stdout: 'pipe', stderr: 'pipe' });
      const [exitCode, stdout, stderr] = await Promise.race([
        Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned provider fixture timed out')), 8000); }),
      ]);
      expect({ exitCode, output: exitCode ? stdout + stderr : '' }).toEqual({ exitCode: 0, output: '' });
    } finally {
      clearTimeout(timer);
      if (child) { child.kill(); await child.exited; }
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 10000);
}
