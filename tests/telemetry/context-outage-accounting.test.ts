import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it.each(['first', 'terminal'])('a rejected %s read counts the real outage before consuming its warning', async mode => {
  const directory = mkdtempSync(join(tmpdir(), 'context-outage-accounting-'));
  const child = Bun.spawn([process.execPath, 'tests/fixtures/telemetry/context-outage.ts', mode], {
    cwd: join(import.meta.dir, '../..'),
    env: { ...process.env, CLAUDE_MEM_DATA_DIR: directory, CLAUDE_MEM_RUNTIME: 'worker',
      CLAUDE_MEM_INTERNAL: '', DO_NOT_TRACK: '1', CLAUDE_MEM_TELEMETRY: '0' },
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exit, stderr).toBe(0);
    const steps = JSON.parse(stdout);
    expect(steps[0].state.consecutiveFailures).toBe(1);
    expect(steps[0].result.systemMessage ?? '').not.toContain('worker unreachable');
    expect(steps[1].state.consecutiveFailures).toBe(2);
    expect(steps[1].state.thresholdTripped).toBe(true);
    expect(steps[1].state.notifiedSessionIds).toEqual(['outage-1']);
    expect(steps[1].result.systemMessage).toContain('worker unreachable for 2 consecutive hooks');
    expect(steps[1].result.hookSpecificOutput.additionalContext).toBe(mode === 'terminal' ? 'context from worker' : '');
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
