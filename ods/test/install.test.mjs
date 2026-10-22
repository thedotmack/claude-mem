import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { install } from '../install.mjs';

const source = process.env.ODS_TEST_REPO;
const files = [
  'ods/manifest.json', 'ods/.env.schema.json',
  'ods/extensions/services/pixel-agent/host/pixel_ingress.mjs',
  'ods/installers/lib/pixel-host-install.sh',
];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ods-install-test-'));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), execFileSync('git', ['show', `HEAD:${file}`], { cwd: source }));
  }
  fs.mkdirSync(path.join(root, 'ods/data/claude-mem'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ods/data/claude-mem/keep.db'), 'existing memory');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('native install is checked before mutation, idempotent, and removable without touching data', { skip: !source }, t => {
  const root = fixture(t);
  const before = fs.readFileSync(path.join(root, files[2]));
  assert.equal(install(root, { check: true }).status, 'compatible');
  assert.deepEqual(fs.readFileSync(path.join(root, files[2])), before);
  assert.equal(install(root).status, 'installed');
  assert.match(fs.readFileSync(path.join(root, files[2]), 'utf8'), /createOdsMemory/);
  assert.equal(install(root).status, 'already-installed');
  assert.equal(install(root, { uninstall: true }).status, 'removed');
  assert.deepEqual(fs.readFileSync(path.join(root, files[2])), before);
  assert.equal(fs.readFileSync(path.join(root, 'ods/data/claude-mem/keep.db'), 'utf8'), 'existing memory');
});

test('refuses incompatible ODS source without a partial install', { skip: !source }, t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, files[2]), 'changed upstream API');
  assert.throws(() => install(root), /does not match/);
  assert.equal(fs.existsSync(path.join(root, 'ods/extensions/services/claude-mem')), false);
});

test('preserves local edits and requires disabling the running extension before removal', { skip: !source }, t => {
  const root = fixture(t);
  install(root);
  const service = path.join(root, 'ods/extensions/services/claude-mem');
  fs.renameSync(path.join(service, 'compose.yaml.disabled'), path.join(service, 'compose.yaml'));
  assert.throws(() => install(root, { uninstall: true }), /disable/);
  fs.renameSync(path.join(service, 'compose.yaml'), path.join(service, 'compose.yaml.disabled'));
  fs.appendFileSync(path.join(service, 'Dockerfile'), '\n# local customization\n');
  assert.throws(() => install(root, { uninstall: true }), /Locally modified/);
  assert.match(fs.readFileSync(path.join(service, 'Dockerfile'), 'utf8'), /local customization/);
});

test('refuses a symlinked integration destination', { skip: !source || process.platform === 'win32' }, t => {
  const root = fixture(t);
  fs.symlinkSync(path.join(root, 'ods/data'), path.join(root, 'ods/extensions/services/claude-mem'));
  assert.throws(() => install(root), /symlink/);
  assert.equal(fs.existsSync(path.join(root, 'ods/data/keep.db')), false);
});
