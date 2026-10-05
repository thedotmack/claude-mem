import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

for (const scenario of ['normal', 'stalled']) {
it(`spaces concurrent Gemini sessions with ${scenario} timers`, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'owned-gemini-pacing-'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([process.execPath, 'tests/fixtures/gemini/concurrent-pacing.ts', scenario], {
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir }, stdout: 'pipe', stderr: 'pipe',
    });
    const exit = await Promise.race([child.exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned pacing fixture exceeded 18 seconds')), 18000);
    })]);
    const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
    expect(exit, output).toBe(0);
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null) { child.kill(); await child.exited; }
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 20000);
}
