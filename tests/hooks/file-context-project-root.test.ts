import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const cwd of ['root', 'nested', 'linked']) {
  for (const inputPath of cwd === 'linked' ? ['relative', 'absolute', 'physical'] : ['relative', 'absolute']) {
    it(`injects project-relative file history from ${cwd} cwd with ${inputPath} input`, async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'file-context-root-'));
      let child: ReturnType<typeof Bun.spawn> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The transport mock stays in a child; the hook, Git resolver and
        // indexed SQLite lookup run against real checkout paths and rows.
        child = Bun.spawn([process.execPath, 'tests/fixtures/hooks/file-context-project-root.ts', cwd, inputPath], {
          cwd: join(import.meta.dir, '../..'),
          env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: join(dataDir, 'claude'),
            CLAUDE_MEM_PROJECT_NAME_SOURCE: 'path', CLAUDE_MEM_PROJECT_ENVIRONMENTS: '[]',
            CLAUDE_MEM_MEMORY_SEARCH_HOOK_ENABLED: 'false', CLAUDE_MEM_RUNTIME: 'worker',
            CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES: 'false', CLAUDE_MEM_DEDUP_ENABLED: 'false' },
          stdout: 'pipe', stderr: 'pipe',
        });
        const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
        const exitCode = await Promise.race([child.exited, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('File-context project-root fixture exceeded 8 seconds')), 8000);
        })]);
        expect(exitCode, (await output).join('\n')).toBe(0);
      } finally {
        if (timer) clearTimeout(timer);
        if (child && child.exitCode === null) { child.kill(); await child.exited; }
        rmSync(dataDir, { recursive: true, force: true });
      }
    }, 10000);
  }
}
