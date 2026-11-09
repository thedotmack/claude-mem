import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyDeliverableIntoBucket } from '../../src/shared/deliverables.js';

test('both report revisions survive a collision in the displayed SHA-256 prefix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deliverable-hash-'));
  try {
    const source = join(dir, 'report.pdf');
    const bucket = join(dir, 'bucket');
    const save = (text: string) => {
      writeFileSync(source, text);
      return copyDeliverableIntoBucket(source, 'project', bucket);
    };
    const firstText = 'report version 00014901\n';
    const nextText = 'report version 00061641\n';
    const first = save(firstText);
    const next = save(nextText);
    assert.equal(first.bytes, next.bytes);
    assert.equal(first.sha256.slice(0, 8), next.sha256.slice(0, 8));
    assert.notEqual(first.sha256, next.sha256);
    assert.notEqual(first.bucketPath, next.bucketPath);
    assert.equal(next.reused, false);
    assert.equal(readFileSync(first.bucketPath, 'utf8'), firstText);
    assert.equal(readFileSync(next.bucketPath, 'utf8'), nextText);
    assert.deepEqual(save(nextText), { ...next, reused: true });
    assert.deepEqual(save(firstText), { ...first, reused: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('filesystems without hard links publish atomically under the complete digest and reuse that copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deliverable-no-hardlinks-'));
  const link = fs.linkSync;
  let attempts = 0;
  fs.linkSync = () => {
    attempts++;
    throw Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' });
  };
  try {
    const source = join(dir, 'report.pdf');
    writeFileSync(source, 'filesystem without links');
    const root = join(dir, 'bucket');
    const first = copyDeliverableIntoBucket(source, 'project', root);
    assert.equal(attempts, 1);
    assert.equal(first.reused, false);
    assert.equal(first.bucketPath, join(root, 'project', first.sha256, `report-${first.sha256.slice(0, 8)}.pdf`));
    assert.equal(readFileSync(first.bucketPath, 'utf8'), 'filesystem without links');
    assert.ok(!existsSync(join(root, 'project', `report-${first.sha256.slice(0, 8)}.pdf`)));
    assert.deepEqual(copyDeliverableIntoBucket(source, 'project', root), { ...first, reused: true });
    assert.equal(attempts, 2);
  } finally {
    fs.linkSync = link;
    rmSync(dir, { recursive: true, force: true });
  }
});
