import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

async function readInChild(content: string, lineCount: number) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mem-tail-cap-'));
  directories.push(directory);
  const file = join(directory, 'owned.log');
  writeFileSync(file, content);
  const module = new URL('../../../../src/services/worker/http/routes/LogsRoutes.ts', import.meta.url).href;
  const child = Bun.spawn([process.execPath, '-e', `
    import { readLastLines } from ${JSON.stringify(module)};
    const result = readLastLines(${JSON.stringify(file)}, ${lineCount});
    console.log(JSON.stringify({ length: result.lines.length, estimate: result.totalEstimate }));
  `], { stdout: 'pipe', stderr: 'pipe' });
  let timeout: ReturnType<typeof setTimeout>;
  const exitCode = await Promise.race([
    child.exited,
    new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 5000); }),
  ]);
  clearTimeout(timeout!);
  if (exitCode === null) {
    child.kill();
    await child.exited;
  }
  const stderr = await new Response(child.stderr).text();
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  return JSON.parse(await new Response(child.stdout).text()) as { length: number; estimate: number };
}

describe('log-tail read cap termination', () => {
  it('finishes when the existing byte cap is reached before enough newlines', async () => {
    const result = await readInChild('x'.repeat(11 * 1024 * 1024), 1000);
    expect(result.length).toBe(10 * 1024 * 1024);
    expect(Number.isFinite(result.estimate)).toBe(true);
  }, 10000);

  it('still reads a small complete log to the requested last lines', async () => {
    const result = await readInChild('first\nsecond\nthird\n', 2);
    expect(result).toEqual({ length: 'second\nthird'.length, estimate: 3 });
  });
});
