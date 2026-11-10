import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function run(mode: 'deadline' | 'reset' | 'refused') {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'claude-mem-merge-transport-'));
  const child = Bun.spawn([process.execPath, 'tests/fixtures/worker/project-merge-transport.ts', mode], {
    env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDirectory, CLAUDE_MEM_CHROMA_ENABLED: 'false' },
    stdout: 'pipe', stderr: 'pipe',
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout.trim());
  } finally {
    child.kill();
    await child.exited;
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}

for (const mode of ['deadline', 'reset'] as const) {
  it(`does not merge again locally after the live worker accepts a POST and its transport ends with ${mode}`, async () => {
    const report = await run(mode);
    expect(report.received).toEqual([{
      path: '/api/projects/merge', method: 'POST', body: { from: 'frontend', into: 'work', dryRun: false },
    }]);
    expect(report).toMatchObject({
      result: null, rejected: true, preservedError: true,
      row: { merged_into_project: null }, newOperations: 0,
    });
    if (mode === 'deadline') expect(report.timeout).toBe(true);
  }, 15000);
}

it('still merges in the CLI after a real refused loopback connection', async () => {
  const report = await run('refused');
  expect(report.received).toEqual([]);
  expect(report).toMatchObject({
    rejected: false, result: { ranIn: 'cli', mergedObservations: 1 },
    row: { merged_into_project: 'work' }, newOperations: 1,
  });
}, 15000);
