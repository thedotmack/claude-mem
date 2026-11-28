import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync, statSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../../src/services/work-view/request-groups.mjs';
import { registerSharedFileWriter } from '../../../src/services/work-view/shared-file-hooks.mjs';
import { scratchDir } from '../../helpers/scratch-dir.js';

function fixture(run) {
  const dir = scratchDir('ledger-atomic');
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a ledger write does not consume another writer’s unfinished temporary file', () => fixture(dir => {
  const path = join(dir, 'story.json');
  const unfinished = `${path}.tmp`;
  writeFileSync(unfinished, 'another writer is still filling this file');
  writeJsonAtomic(path, { narrative: 'complete' });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { narrative: 'complete' });
  assert.equal(readFileSync(unfinished, 'utf8'), 'another writer is still filling this file');
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
}));

// The shared writer renames the file under its database write lock (SharedLedgerAdapter.finishWrite), so the raw value
// is never written by writeJsonAtomic and nothing is written before the writer's completion runs.
test('a registered shared writer writes the file in its completion, and the raw value is never written', () => fixture(dir => {
  const path = join(dir, 'story.json');
  let finished = false;
  const unregister = registerSharedFileWriter(dir, (name, value, options) => {
    assert.equal(name, 'story.json');
    assert.equal(value.private, 'raw');
    assert.deepEqual(options, { readHash: 'hash-of-the-read' });
    return () => {
      assert.equal(existsSync(path), false);
      writeFileSync(path, JSON.stringify({ public: 'redacted' }));
      finished = true;
    };
  });
  try { writeJsonAtomic(path, { private: 'raw' }, { readHash: 'hash-of-the-read' }); } finally { unregister(); }
  assert.equal(finished, true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { public: 'redacted' });
}));

test('without a shared writer, a failed rename throws and removes its temporary file', () => fixture(dir => {
  const path = join(dir, 'story.json');
  mkdirSync(path);
  assert.throws(() => writeJsonAtomic(path, { narrative: 'complete' }));
  assert.deepEqual(readdirSync(dir), ['story.json']);
}));
