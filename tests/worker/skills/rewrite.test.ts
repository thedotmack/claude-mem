import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeRewriteRunner } from '../../../src/services/skills/rewrite.js';

let directory: string;
const input = { stamp: 'human' as const, text: '# Test\n\nPaint me.\n', passage: 'Paint me.' };
const signal = () => new AbortController().signal;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'paint-runner-check-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function executable(code: string) {
  const file = join(directory, 'test-cli');
  await writeFile(file, '#!/usr/bin/env node\n' + code, { mode: 0o700 });
  return () => file;
}

test.skipIf(process.platform === 'win32')('CLI receives tools-off flags and the complete draft on stdin in its own disposable cwd', async () => {
  const receipt = join(directory, 'receipt');
  const path = await executable(`
    require('fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), input: require('fs').readFileSync(0, 'utf8') }));
    console.log('Rewritten.');
  `);
  const runner = createClaudeRewriteRunner({ executable: path });
  expect(await runner(input, signal())).toBe('Rewritten.');
  const result = JSON.parse(await readFile(receipt, 'utf8'));
  expect(result.argv).toContain('--safe-mode');
  expect(result.argv[result.argv.indexOf('--tools') + 1]).toBe('');
  expect(result.argv).toContain('--no-session-persistence');
  expect(result.input).toContain('<skill>\n' + input.text + '\n</skill>');
  expect(result.input).toContain('<painted>\nPaint me.\n</painted>');
  expect(result.argv.join(' ')).not.toContain('Paint me.');
  await expect(stat(result.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
});

test.skipIf(process.platform === 'win32')('the worker gateway and provider environment cannot redirect a skill rewrite', async () => {
  const keys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK'];
  const previous = keys.map(key => process.env[key]);
  const path = await executable('console.log(JSON.stringify(' + JSON.stringify(keys) + '.filter(k => k in process.env)))');
  try {
    for (const key of keys) process.env[key] = 'paint-test-sentinel';
    expect(await createClaudeRewriteRunner({ executable: path })(input, signal())).toBe('[]');
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});

test.skipIf(process.platform === 'win32')('timeout, oversized output and an empty reply are recoverable errors', async () => {
  let path = await executable('setInterval(() => {}, 1000)');
  await expect(createClaudeRewriteRunner({ executable: path, timeoutMs: 100 })(input, signal())).rejects.toMatchObject({ status: 504 });
  path = await executable('console.log("x".repeat(128));');
  await expect(createClaudeRewriteRunner({ executable: path, maxOutputBytes: 64 })(input, signal())).rejects.toMatchObject({ status: 502 });
  path = await executable('console.log("");');
  await expect(createClaudeRewriteRunner({ executable: path })(input, signal())).rejects.toMatchObject({ status: 502 });
});

test.skipIf(process.platform === 'win32')('cancels a running CLI and releases its process slot', async () => {
  const ready = join(directory, 'ready');
  const runner = createClaudeRewriteRunner({ executable: await executable(
    `require('fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`
  ) });
  const abort = new AbortController();
  const pending = runner(input, abort.signal);
  for (let n = 0; n < 150 && !(await Bun.file(ready).exists()); n++) await Bun.sleep(10);
  const pid = Number(await readFile(ready, 'utf8'));
  abort.abort();
  await expect(pending).rejects.toMatchObject({ status: 499 });
  expect(() => process.kill(pid, 0)).toThrow();
});
