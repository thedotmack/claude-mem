import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonAtomic } from '../../../src/services/work-view/request-groups.mjs';
import { registerSharedFileWriter } from '../../../src/services/work-view/shared-file-hooks.mjs';

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-atomic-'));
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

test('the durable hook replacement is written before its completion callback', () => fixture(dir => {
  const path = join(dir, 'story.json');
  let finished = false;
  const unregister = registerSharedFileWriter(dir, (name, value) => {
    assert.equal(name, 'story.json');
    assert.equal(value.private, 'raw');
    const finish = () => {
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { public: 'redacted' });
      finished = true;
    };
    finish.value = { public: 'redacted' };
    return finish;
  });
  try { writeJsonAtomic(path, { private: 'raw' }); } finally { unregister(); }
  assert.equal(finished, true);
}));

test('a failed rename removes its temporary file and does not report completion', () => fixture(dir => {
  const path = join(dir, 'story.json');
  mkdirSync(path);
  let finished = false;
  const unregister = registerSharedFileWriter(dir, () => () => { finished = true; });
  try { assert.throws(() => writeJsonAtomic(path, { narrative: 'complete' })); } finally { unregister(); }
  assert.equal(finished, false);
  assert.deepEqual(readdirSync(dir), ['story.json']);
}));
