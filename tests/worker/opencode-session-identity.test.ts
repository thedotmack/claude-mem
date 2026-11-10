import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

for (const version of ['v1', 'v2']) {
  it(`keeps a resumed ${version} native session together across plugin processes`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'owned-opencode-resume-'));
    const child = Bun.spawn([process.execPath, 'tests/fixtures/opencode/session-identity.ts', 'check', version], {
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir }, stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const exit = await child.exited;
      const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
      expect(exit, output).toBe(0);
    } finally { if (child.exitCode === null) { child.kill(); await child.exited; } rmSync(dataDir, { recursive: true, force: true }); }
  }, 15_000);
}
