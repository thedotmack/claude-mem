#!/usr/bin/env node
// Local development activation only. Default is a read-only plan. All changed
// bytes are backed up before the first write; rollback refuses later edits.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = key => { const index = args.indexOf(key); return index < 0 ? null : args[index + 1]; };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => existsSync(file) ? readFileSync(file) : null;
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const fail = message => { throw new Error(message); };
function atomicWrite(file, bytes, mode = 0o600) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.cmem-activation-${process.pid}`;
  writeFileSync(temporary, bytes, { mode });
  renameSync(temporary, file);
}
function safeTarget(file) {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) fail(`Refusing symlink target: ${file}`);
}

const restore = option('--restore');
if (restore) {
  const directory = path.resolve(restore);
  const manifest = json(path.join(directory, 'manifest.json'));
  if (manifest.kind !== 'claude-mem-progressive-local-activation-v1') fail('Unrecognized backup manifest');
  // Check EVERY affected file before restoring any of them.
  for (const entry of manifest.files) {
    safeTarget(entry.target);
    const current = read(entry.target);
    const currentHash = current ? hash(current) : null;
    if (currentHash !== entry.appliedHash && currentHash !== entry.originalHash) fail(`Later edit detected; restore refused: ${entry.target}`);
    if (entry.backup && hash(readFileSync(path.join(directory, entry.backup))) !== entry.originalHash) fail(`Backup checksum mismatch: ${entry.target}`);
  }
  for (const entry of manifest.files) {
    if (entry.backup) atomicWrite(entry.target, readFileSync(path.join(directory, entry.backup)), entry.mode);
    else if (existsSync(entry.target)) rmSync(entry.target);
  }
  // Leave the dedicated note directory and any user notes in place.
  atomicWrite(path.join(directory, 'manifest.json'), Buffer.from(JSON.stringify({ ...manifest, restoredAt: new Date().toISOString() }, null, 2)));
  console.log(`Restored ${manifest.files.length} files. Restart the local worker when idle.`);
  process.exit(0);
}

const workspaceArg = option('--workspace');
const project = option('--project');
if (!workspaceArg || !project?.trim()) fail('Provide --workspace <absolute checkout> and --project <project key>; use --apply to activate.');
const workspace = path.resolve(workspaceArg);
if (!statSync(workspace).isDirectory()) fail('Workspace must be an existing directory');
if (!args.includes('--no-restart')) fail('Include --no-restart; the caller controls when the local worker may restart.');
const source = option('--source-plugin') ? path.resolve(option('--source-plugin')) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugin');
const version = json(path.join(source, '.claude-plugin/plugin.json')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail('Source plugin must have a release version');
const home = homedir();
const claudeConfig = option('--claude-config-dir') || process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
const codexHome = option('--codex-dir') || process.env.CODEX_HOME || path.join(home, '.codex');
const targets = [
  path.join(claudeConfig, 'plugins/marketplaces/thedotmack/plugin'),
  path.join(claudeConfig, `plugins/cache/thedotmack/claude-mem/${version}`),
  path.join(codexHome, `plugins/cache/claude-mem-local/claude-mem/${version}`),
];
const artifacts = ['scripts/worker-service.cjs', 'scripts/mcp-server.cjs', 'hooks/hooks.json', 'hooks/codex-hooks.json', 'skills/mem-search/SKILL.md'];
const changes = [];
const addChange = (target, bytes) => {
  safeTarget(target);
  const original = read(target);
  if (original && original.equals(bytes)) return;
  changes.push({ target, bytes, original, mode: original ? statSync(target).mode & 0o777 : 0o600 });
};
for (const root of targets) {
  const manifest = json(path.join(root, '.claude-plugin/plugin.json'));
  if (manifest.name !== 'claude-mem' || manifest.version !== version) fail(`Plugin/version mismatch: ${root}`);
  for (const artifact of artifacts) {
    const bytes = readFileSync(path.join(source, artifact));
    if (artifact.endsWith('worker-service.cjs') && (!bytes.includes(Buffer.from('claude-mem-retrieved-data')) || !bytes.includes(Buffer.from('sourceFingerprint')))) fail('Build the progressive worker with the native-memory bridge before activation');
    if (artifact.endsWith('mcp-server.cjs') && (!bytes.includes(Buffer.from('mem_search')) || !bytes.includes(Buffer.from('save_memory')))) fail('Build MCP mem_search/save_memory tools before activation');
    addChange(path.join(root, artifact), bytes);
  }
}

const start = '<!-- claude-mem-memory-instructions:start -->';
const end = '<!-- claude-mem-memory-instructions:end -->';
const instructionSource = readFileSync(path.resolve(source, '../src/shared/memory-instructions.ts'), 'utf8');
const instructions = instructionSource.match(/MEMORY_PLUGIN_INSTRUCTIONS = `([\s\S]*?)`;/)?.[1];
if (!instructions) fail('Could not read the versioned memory instruction text');
const block = `${start}\n${instructions}\n${end}`;
for (const file of [path.join(claudeConfig, 'CLAUDE.md'), path.join(codexHome, 'AGENTS.md')]) {
  const original = read(file)?.toString('utf8') || '';
  const begin = original.indexOf(start), finish = original.indexOf(end);
  if ((begin < 0) !== (finish < 0) || (begin >= 0 && finish < begin)) fail(`Incomplete instruction block: ${file}`);
  const next = begin >= 0 ? original.slice(0, begin) + block + original.slice(finish + end.length) : `${original}${original.endsWith('\n') || !original ? '' : '\n'}\n${block}\n`;
  addChange(file, Buffer.from(next));
}

const settingsFile = path.join(option('--memory-data-dir') || process.env.CLAUDE_MEM_DATA_DIR || path.join(home, '.claude-mem'), 'settings.json');
const settings = existsSync(settingsFile) ? json(settingsFile) : {};
const container = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : settings;
const memoryRoot = path.join(workspace, '.claude/memory');
const configured = container.CLAUDE_MEM_MEMORY_WATCH_ROOTS;
const roots = configured ? JSON.parse(configured) : [];
if (!Array.isArray(roots)) fail('Existing memory watch roots are not an array');
if (roots.some(root => root.path === memoryRoot && root.project !== project.trim())) fail('Dedicated folder is already assigned to another project');
if (!roots.some(root => root.path === memoryRoot && root.project === project.trim())) roots.push({ path: memoryRoot, project: project.trim() });
if (roots.length > 8) fail('The native-memory bridge supports at most 8 roots');
container.CLAUDE_MEM_MEMORY_WATCH_ROOTS = JSON.stringify(roots);
container.CLAUDE_MEM_MEMORY_SEARCH_HOOK_ENABLED = 'true';
container.CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED = 'true';
addChange(settingsFile, Buffer.from(JSON.stringify(settings, null, 2) + '\n'));

console.log(JSON.stringify({ dryRun: !args.includes('--apply'), version, filesToChange: changes.map(change => change.target), memoryRoot, project: project.trim(), workerRestart: 'caller-controlled' }, null, 2));
if (!args.includes('--apply')) process.exit(0);
if (changes.length === 0) { console.log('Already active; no files changed.'); process.exit(0); }

const backupRoot = path.join(workspace, '.agent-jobs/progressive-mem-search');
const directory = path.join(backupRoot, `activation-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const files = changes.map((change, index) => {
  const backup = change.original ? `${String(index).padStart(2, '0')}.bin` : null;
  if (backup) writeFileSync(path.join(directory, backup), change.original, { mode: 0o600 });
  return { target: change.target, backup, mode: change.mode, originalHash: change.original ? hash(change.original) : null, appliedHash: hash(change.bytes) };
});
const manifest = { kind: 'claude-mem-progressive-local-activation-v1', version, createdAt: new Date().toISOString(), memoryRoot, project: project.trim(), files };
atomicWrite(path.join(directory, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)));
mkdirSync(memoryRoot, { recursive: true });
for (const change of changes) {
  // Recheck immediately before the mutation; another agent may have edited it.
  const current = read(change.target);
  if ((current ? hash(current) : null) !== (change.original ? hash(change.original) : null)) fail(`File changed during activation: ${change.target}. Restore using ${directory}`);
  atomicWrite(change.target, change.bytes, change.mode);
}
console.log(`Activated local progressive memory. Backup: ${directory}. No worker restart performed.`);
