import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const script = path.resolve(import.meta.dir, '../../scripts/activate-progressive-memory-local.mjs');
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'cmem-activation-')); roots.push(root);
  const source = path.join(root, 'source/plugin'), claude = path.join(root, 'claude'), codex = path.join(root, 'codex'), data = path.join(root, 'memory'), workspace = path.join(root, 'workspace');
  const targets = [path.join(claude, 'plugins/marketplaces/thedotmack/plugin'), path.join(claude, 'plugins/cache/thedotmack/claude-mem/13.34.2'), path.join(codex, 'plugins/cache/claude-mem-local/claude-mem/13.34.2')];
  const write = (file: string, content: string) => { mkdirSync(path.dirname(file), {recursive: true}); writeFileSync(file, content); };
  for (const folder of [source, ...targets]) {
    write(path.join(folder, '.claude-plugin/plugin.json'), JSON.stringify({name: 'claude-mem', version: '13.34.2'}));
    write(path.join(folder, 'scripts/worker-service.cjs'), folder === source ? 'claude-mem-retrieved-data sourceFingerprint' : 'old worker');
    write(path.join(folder, 'scripts/mcp-server.cjs'), folder === source ? 'mem_search save_memory' : 'old mcp');
    for (const file of ['hooks/hooks.json','hooks/codex-hooks.json','skills/mem-search/SKILL.md']) write(path.join(folder, file), folder === source ? 'new instructions' : 'old instructions');
  }
  write(path.join(root, 'source/src/shared/memory-instructions.ts'), 'export const MEMORY_PLUGIN_INSTRUCTIONS = `use plugin notes`;');
  write(path.join(claude, 'CLAUDE.md'), 'existing Claude instructions\n');
  write(path.join(codex, 'AGENTS.md'), 'existing Codex instructions\n');
  write(path.join(data, 'settings.json'), JSON.stringify({env:{existing_secret:'fixture secret', unrelated:'keep'}, custom:42}));
  mkdirSync(workspace);
  const args = [script, '--workspace',workspace,'--project','project','--no-restart','--source-plugin',source,'--claude-config-dir',claude,'--codex-dir',codex,'--memory-data-dir',data];
  const run = (...extra: string[]) => spawnSync('node', [...args, ...extra], {encoding:'utf8'});
  return {root,source,claude,codex,data,workspace,targets,run};
}

describe('reversible local activation', () => {
  it('defaults to dry run, then applies idempotently and restores original bytes', () => {
    const f = fixture();
    const original = readFileSync(path.join(f.data, 'settings.json'), 'utf8');
    const dry = f.run();
    expect(dry.status).toBe(0);
    expect(dry.stdout).toStartWith('Local progressive memory dry run\n');
    expect(dry.stdout).toContain('Project: project');
    expect(dry.stdout).toContain('Files to change (');
    expect(() => JSON.parse(dry.stdout)).toThrow();
    expect(dry.stdout).not.toContain('fixture secret');
    expect(readFileSync(path.join(f.data,'settings.json'),'utf8')).toBe(original);
    expect(existsSync(path.join(f.workspace,'.claude/memory'))).toBe(false);
    const apply = f.run('--apply');
    expect(apply.status).toBe(0);
    expect(readFileSync(path.join(f.targets[0],'scripts/worker-service.cjs'),'utf8')).toContain('sourceFingerprint');
    const settings = JSON.parse(readFileSync(path.join(f.data,'settings.json'),'utf8'));
    expect(settings.env.existing_secret).toBe('fixture secret');
    expect(settings.custom).toBe(42);
    expect(JSON.parse(settings.env.CLAUDE_MEM_MEMORY_WATCH_ROOTS)).toEqual([{path:path.join(f.workspace,'.claude/memory'),project:'project'}]);
    expect(f.run('--apply').stdout).toContain('Already active');
    const backupRoot = path.join(f.workspace,'.agent-jobs/progressive-mem-search');
    expect(readdirSync(backupRoot)).toHaveLength(1);
    const backup = path.join(backupRoot,readdirSync(backupRoot)[0]);
    expect(f.run('--restore',backup).status).toBe(0);
    expect(readFileSync(path.join(f.data,'settings.json'),'utf8')).toBe(original);
    expect(readFileSync(path.join(f.targets[0],'scripts/worker-service.cjs'),'utf8')).toBe('old worker');
    expect(readFileSync(path.join(f.claude,'CLAUDE.md'),'utf8')).toBe('existing Claude instructions\n');
  });

  it('refuses rollback after someone edits an affected file, before restoring any other file', () => {
    const f=fixture(); expect(f.run('--apply').status).toBe(0);
    const backupRoot=path.join(f.workspace,'.agent-jobs/progressive-mem-search');
    writeFileSync(path.join(f.codex,'AGENTS.md'),'new independent instructions');
    const restore=f.run('--restore',path.join(backupRoot,readdirSync(backupRoot)[0]));
    expect(restore.status).not.toBe(0);
    expect(restore.stderr).toContain('Later edit detected');
    expect(readFileSync(path.join(f.targets[0],'scripts/worker-service.cjs'),'utf8')).toContain('sourceFingerprint');
  });

  it('refuses unbuilt bundles and target version mismatches before mutation', () => {
    const f=fixture();
    writeFileSync(path.join(f.source,'scripts/mcp-server.cjs'),'old mcp');
    expect(f.run('--apply').status).not.toBe(0);
    expect(existsSync(path.join(f.workspace,'.agent-jobs'))).toBe(false);
    writeFileSync(path.join(f.source,'scripts/mcp-server.cjs'),'mem_search save_memory');
    writeFileSync(path.join(f.targets[1],'.claude-plugin/plugin.json'),JSON.stringify({name:'claude-mem',version:'13.35.0'}));
    expect(f.run('--apply').status).not.toBe(0);
    expect(readFileSync(path.join(f.targets[0],'scripts/worker-service.cjs'),'utf8')).toBe('old worker');
  });
});
