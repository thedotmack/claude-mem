import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const mode of ['description', 'type', 'retained-variant', 'provenance']) {
  it(`preserves memory-file import identity (${mode})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-ingest-revision-'));
    const data = join(root, 'data');
    mkdirSync(data);
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      child = Bun.spawn([process.execPath, 'tests/fixtures/worker/memory-ingest-structured-revisions.ts', mode], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
          CLAUDE_MEM_DATA_DIR: data, DO_NOT_TRACK: '1', CLAUDE_MEM_DEDUP_ENABLED: 'true' },
        stdout: 'pipe', stderr: 'pipe',
      });
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const code = await Promise.race([child.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Memory import ${mode} fixture exceeded 15 seconds`)), 15000);
      })]);
      expect(code, (await output).join('\n')).toBe(0);
    } finally {
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null) { child.kill(); await child.exited; }
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
}
