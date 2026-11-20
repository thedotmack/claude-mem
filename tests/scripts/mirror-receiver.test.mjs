import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mirror from '../../scripts/mirror-dir.cjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'receiver-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, 'source'), dest = join(root, 'dest');
  mkdirSync(src);
  mkdirSync(dest);
  return { src, dest };
}

test('retains protected descendants of stale directories but removes unprotected siblings', t => {
  const { src, dest } = fixture(t);
  mkdirSync(join(dest, 'obsolete/.git'), { recursive: true });
  writeFileSync(join(dest, 'obsolete/.git/HEAD'), 'ref');
  writeFileSync(join(dest, 'obsolete/stale'), 'stale');
  const stats = mirror.mirrorDirectory(src, dest, { exclude: ['.git'] });
  assert.equal(readFileSync(join(dest, 'obsolete/.git/HEAD'), 'utf8'), 'ref');
  assert.equal(existsSync(join(dest, 'obsolete/stale')), false);
  assert.equal(stats.deleted, 1);
});

test('does not replace protected receiver data during a directory-to-file transition', t => {
  const { src, dest } = fixture(t);
  mkdirSync(join(dest, 'plugin/data'), { recursive: true });
  writeFileSync(join(dest, 'plugin/data/db'), 'saved');
  writeFileSync(join(dest, 'plugin/config'), 'config');
  writeFileSync(join(src, 'plugin'), 'file');
  assert.throws(() => mirror.mirrorDirectory(src, dest, { exclude: ['plugin/data/'] }), /excluded/);
  assert.equal(readFileSync(join(dest, 'plugin/data/db'), 'utf8'), 'saved');
  assert.equal(readFileSync(join(dest, 'plugin/config'), 'utf8'), 'config');
});

test('globstar directories also cover zero path segments', () => {
  const rules = mirror.compileExcludes(['/tests/**/.generated/']);
  for (const path of ['tests/.generated', 'tests/a/.generated', 'tests/a/b/.generated']) {
    assert.equal(mirror.isExcluded(rules, path, true), true, path);
  }
  assert.equal(mirror.isExcluded(rules, 'other/tests/.generated', true), false);
});

test('refuses special files before removing siblings from the receiver', { skip: process.platform === 'win32' }, t => {
  const { src, dest } = fixture(t);
  execFileSync('mkfifo', [join(src, 'events')]);
  writeFileSync(join(dest, 'existing'), 'keep');
  assert.throws(() => mirror.mirrorDirectory(src, dest), /special file/);
  assert.equal(readFileSync(join(dest, 'existing'), 'utf8'), 'keep');
});

test('a missing source does not create a destination', t => {
  const { src, dest } = fixture(t);
  const missingDest = join(dest, 'new');
  assert.throws(() => mirror.mirrorDirectory(join(src, 'missing'), missingDest), { code: 'ENOENT' });
  assert.equal(existsSync(missingDest), false);
});
