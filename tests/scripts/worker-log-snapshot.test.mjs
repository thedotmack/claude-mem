import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/worker-logs.cjs', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-snapshot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'logs'));
  const file = join(dir, 'logs', `claude-mem-${new Date().toISOString().slice(0, 10)}.log`);
  return { dir, file, env: { ...process.env, CLAUDE_MEM_DATA_DIR: dir } };
}

test('streams a single oversized snapshot entry under a constrained heap', t => {
  const { dir, file, env } = fixture(t);
  const chunk = Buffer.alloc(1024 * 1024, 'a');
  for (let i = 0; i < 32; i++) appendFileSync(file, chunk);
  const output = join(dir, 'out');
  const fd = openSync(output, 'w');
  try {
    const result = spawnSync('node', ['--max-old-space-size=16', script], { env, stdio: ['ignore', fd, 'pipe'] });
    assert.equal(result.status, 0, String(result.stderr));
  } finally { closeSync(fd); }
  assert.equal(statSync(output).size, statSync(file).size);
});

test('emits exactly the last 50 lines and preserves an unterminated multibyte sequence', t => {
  const { file, env } = fixture(t);
  const rows = Array.from({ length: 60 }, (_, i) => `row${i}\n`);
  const partial = Buffer.from([0xe2, 0x82]);
  writeFileSync(file, Buffer.concat([Buffer.from(rows.join('')), partial]));
  const result = spawnSync('node', [script], { env });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout, Buffer.concat([Buffer.from(rows.slice(-49).join('')), partial]));
});

test('reads data appended just before watcher registration without waiting for another write', async t => {
  const { dir, file, env } = fixture(t);
  writeFileSync(file, 'before');
  const preload = join(dir, 'registration.cjs');
  writeFileSync(preload, `const fs = require('node:fs'), watch = fs.watchFile;
fs.watchFile = function(file, ...args) {
  fs.appendFileSync(file, ' and after');
  return watch.call(this, file, ...args);
};`);
  const child = spawn('node', ['--require', preload, script, '--follow'], { env });
  const exit = once(child, 'exit');
  let stdout = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('watcher did not catch up')), 5000);
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes('after')) { clearTimeout(timer); resolve(); }
      });
    });
    assert.equal(stdout, 'before and after');
  } finally { child.kill(); await exit; }
});
