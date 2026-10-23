#!/usr/bin/env node
/** Prepare a native ODS integration without changing its live gateway configuration. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const source = path.dirname(fileURLToPath(import.meta.url));
const servicePath = 'extensions/services/claude-mem';
const nativePath = 'extensions/services/pixel-agent/host/claude_mem.mjs';
const patchedPaths = [
  '.env.schema.json',
  'extensions/services/pixel-agent/host/pixel_ingress.mjs',
  'installers/lib/pixel-host-install.sh',
];
const serviceFiles = ['Dockerfile', 'gateway.mjs', 'manifest.yaml', 'compose.yaml.disabled'];
const receiptName = '.claude-mem-native-install.json';
const sha = contents => createHash('sha256').update(contents).digest('hex');

function regularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Expected a regular file: ${file}`);
  return stat;
}

function safePath(root, relative) {
  const pieces = relative.split('/');
  if (pieces.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid integration path');
  let current = root;
  for (const part of pieces) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}

function read(file) { regularFile(file); return fs.readFileSync(file); }

function replace(file, contents, mode = 0o644) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function rootDirectory(directory) {
  const root = fs.realpathSync(directory);
  const actual = fs.existsSync(path.join(root, 'ods/manifest.json')) ? path.join(root, 'ods') : root;
  const manifest = JSON.parse(read(safePath(actual, 'manifest.json')));
  if (manifest.ods_version !== '3.0.0') throw new Error('This native adapter is qualified against ODS 3.0.0');
  return actual;
}

function planPatch(root) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mem-ods-'));
  try {
    const original = Object.fromEntries(patchedPaths.map(relative => {
      const file = safePath(root, relative);
      const contents = read(file);
      const target = path.join(temporary, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
      return [relative, { contents, mode: fs.statSync(file).mode & 0o777 }];
    }));
    const patch = path.join(source, 'patches/ods-native.patch');
    const options = { cwd: temporary, stdio: 'pipe', env: { ...process.env, GIT_CEILING_DIRECTORIES: temporary } };
    try {
      execFileSync('git', ['apply', '--check', patch], options);
      execFileSync('git', ['apply', patch], options);
    } catch {
      throw new Error('ODS source does not match the native patch; no files were changed');
    }
    return Object.entries(original).map(([relative, before]) => ({ relative, before: before.contents,
      mode: before.mode, after: fs.readFileSync(path.join(temporary, relative)) }));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function verifyReceipt(root, receipt) {
  if (receipt.schemaVersion !== 1 || receipt.patchSha256 !== sha(read(path.join(source, 'patches/ods-native.patch')))) {
    throw new Error('Unrecognized native installation receipt');
  }
  const expected = [...patchedPaths, nativePath, ...serviceFiles.map(file => `${servicePath}/${file}`)].sort();
  if (JSON.stringify(Object.keys(receipt.files || {}).sort()) !== JSON.stringify(expected)) throw new Error('Invalid receipt paths');
  if (receipt.phase !== undefined && receipt.phase !== 'removing') throw new Error('Invalid receipt phase');
  for (const relative of expected) {
    const alternative = relative.endsWith('/compose.yaml.disabled') ? relative.replace(/\.disabled$/, '') : null;
    const file = fs.existsSync(path.join(root, relative)) ? safePath(root, relative) : alternative && safePath(root, alternative);
    const item = receipt.files[relative];
    // Once removal starts, each path may contain the installed bytes or the
    // exact original bytes (or be absent if this installer created it).
    // This makes a failed rename/unlink resumable without accepting local edits.
    if (receipt.phase === 'removing') {
      safePath(root, relative);
      if (alternative) safePath(root, alternative);
      if ((!file || !fs.existsSync(file)) && !patchedPaths.includes(relative)) continue;
      if (file && fs.existsSync(file) && item.original
          && sha(read(file)) === sha(Buffer.from(item.original, 'base64'))) continue;
    }
    if (!file || !fs.existsSync(file) || sha(read(file)) !== item.sha256) throw new Error(`Locally modified integration: ${relative}`);
  }
  const names = fs.readdirSync(path.join(root, servicePath)).sort();
  const allowed = new Set([...serviceFiles, 'compose.yaml', receiptName]);
  if (names.some(name => !allowed.has(name))) throw new Error('Integration directory contains unowned files');
}

export function install(directory, { check = false, uninstall = false } = {}) {
  const root = rootDirectory(directory);
  const service = safePath(root, servicePath);
  const receiptPath = path.join(service, receiptName);
  if (fs.existsSync(receiptPath)) {
    const receipt = JSON.parse(read(receiptPath));
    verifyReceipt(root, receipt);
    if (!uninstall) {
      if (receipt.phase === 'removing') throw new Error('Removal in progress; run --uninstall again to finish');
      return { status: 'already-installed', root };
    }
    if (fs.existsSync(path.join(service, 'compose.yaml'))) throw new Error('Run ods disable claude-mem before removing the integration');
    if (check) return { status: 'ready-to-remove', root };
    // Persist intent before the first restore. Keep this receipt until all
    // owned files have reached their removed state, even if a later step fails.
    receipt.phase = 'removing';
    replace(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 0o600);
    for (const relative of patchedPaths) {
      const item = receipt.files[relative];
      replace(safePath(root, relative), Buffer.from(item.original, 'base64'), item.mode);
    }
    fs.rmSync(safePath(root, nativePath), { force: true });
    for (const file of serviceFiles) fs.rmSync(path.join(service, file), { force: true });
    fs.unlinkSync(receiptPath);
    try { fs.rmdirSync(service); }
    catch (error) {
      // A parent-directory permission failure must not discard recovery state.
      replace(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 0o600);
      throw error;
    }
    return { status: 'removed', root, dataPreserved: true };
  }
  if (uninstall) throw new Error('No native Claude-Mem installation receipt was found');
  if (fs.existsSync(service) || fs.existsSync(path.join(root, nativePath))) throw new Error('Refusing to overwrite an unowned integration');
  const changes = planPatch(root);
  const additions = [
    { relative: nativePath, after: read(path.join(source, 'native/claude_mem.mjs')), mode: 0o644 },
    ...serviceFiles.map(file => ({ relative: `${servicePath}/${file}`, after: read(path.join(source, 'service', file)), mode: 0o644 })),
  ];
  if (check) return { status: 'compatible', root, files: [...changes, ...additions].map(item => item.relative) };
  const written = [];
  try {
    for (const item of [...changes, ...additions]) {
      const file = item.relative.startsWith(`${servicePath}/`)
        ? path.join(root, item.relative) : safePath(root, item.relative);
      if (item.before && sha(read(file)) !== sha(item.before)) throw new Error('ODS source changed while preparing the integration');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      replace(file, item.after, item.mode);
      written.push(item);
    }
    const receipt = { schemaVersion: 1, odsRevision: 'c99f52822f2c37813fd880004f964ca83dfc5a35',
      patchSha256: sha(read(path.join(source, 'patches/ods-native.patch'))),
      files: Object.fromEntries(written.map(item => [item.relative, { sha256: sha(item.after), mode: item.mode,
        ...(item.before ? { original: item.before.toString('base64') } : {}) }])) };
    replace(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 0o600);
    return { status: 'installed', root, enabled: false };
  } catch (error) {
    for (const item of written.reverse()) {
      const file = path.join(root, item.relative);
      if (sha(read(file)) !== sha(item.after)) throw new Error('Installation interrupted by a concurrent edit; review the native integration files');
      if (item.before) replace(file, item.before, item.mode);
      else fs.unlinkSync(file);
    }
    if (fs.existsSync(service) && fs.readdirSync(service).length === 0) fs.rmdirSync(service);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { 'ods-dir': { type: 'string' }, check: { type: 'boolean' }, uninstall: { type: 'boolean' } } });
    if (!values['ods-dir']) throw new Error('Usage: node ods/install.mjs --ods-dir /path/to/ODS/ods [--check | --uninstall]');
    const result = install(values['ods-dir'], { check: values.check, uninstall: values.uninstall });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'installed') console.log('Native sources are prepared. Follow ods/README.md to build the service and deploy the ODS ingress.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
