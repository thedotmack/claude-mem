import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// bun scripts/bench-imessage-contacts.ts [contacts=10000] [samples=5]
// Includes process startup, command loading, stdin parsing and the saved JSON.
const count = Number(process.argv[2] ?? 10_000);
const samples = Number(process.argv[3] ?? 5);
if (!Number.isInteger(count) || count < 1 || count > 20_000 || !Number.isInteger(samples) || samples < 1) {
  throw new Error('Use 1–20000 contacts and a positive integer sample count.');
}
const command = fileURLToPath(new URL('../tests/fixtures/imessage/contacts-command.ts', import.meta.url));
const contacts = Object.fromEntries(Array.from({ length: count }, (_, index) => [`+1555${String(index).padStart(7, '0')}`, `Person ${index}`]));
const input = JSON.stringify(contacts);
const milliseconds: number[] = [];
for (let run = 0; run <= samples; run++) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mem-contacts-bench-'));
  try {
    const start = performance.now();
    const result = spawnSync(process.execPath, [command, '--json', '--replace'], {
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: directory },
      input, encoding: 'utf8', timeout: 30_000,
    });
    const elapsed = performance.now() - start;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).count, count);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'imessage-observer', 'contacts.json'), 'utf8')), contacts);
    if (run > 0) milliseconds.push(elapsed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const ordered = [...milliseconds].sort((a, b) => a - b);
console.log(JSON.stringify({ count, samples, warmups: 1, milliseconds, medianMs: ordered[Math.floor(samples / 2)] }));
