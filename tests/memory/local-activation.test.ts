import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { settingsTarget } from '../../src/shared/settings-document.js';

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
  write(path.join(data, 'settings.json'), JSON.stringify({env:{CLAUDE_MEM_LOG_LEVEL:'INFO', existing_secret:'fixture secret', unrelated:'keep'}, custom:42}));
  mkdirSync(workspace);
  const args = [script, '--workspace',workspace,'--project','project','--no-restart','--source-plugin',source,'--claude-config-dir',claude,'--codex-dir',codex];
  const env = {...process.env, HOME:root, USERPROFILE:root, CLAUDE_MEM_DATA_DIR:''};
  const run = (...extra: string[]) => spawnSync('node', [...args, '--memory-data-dir',data, ...extra], {encoding:'utf8',env});
  const runResolved = (overrides:NodeJS.ProcessEnv = {}, ...extra:string[]) => spawnSync('node', [...args, ...extra], {encoding:'utf8',env:{...env,...overrides}});
  return {root,source,claude,codex,data,workspace,targets,run,runResolved};
}

describe('reversible local activation', () => {
  it('keeps flat settings active when an unrelated env object exists', () => {
    const f=fixture();
    const target=path.join(f.data,'settings.json');
    const original={CLAUDE_MEM_RUNTIME:'worker',CLAUDE_MEM_WORKER_PORT:'39001',env:{existing_secret:'fixture secret',unrelated:'keep'},custom:42};
    const bytes=JSON.stringify(original);
    writeFileSync(target,bytes);
    const apply=f.run('--apply');
    expect(apply.status,apply.stderr).toBe(0);
    const saved=JSON.parse(readFileSync(target,'utf8'));
    expect(saved.env).toEqual(original.env);
    expect(saved.CLAUDE_MEM_RUNTIME).toBe('worker');
    expect(saved.CLAUDE_MEM_WORKER_PORT).toBe('39001');
    expect(saved.custom).toBe(42);
    // Read through the worker's actual settings-document predicate, rather
    // than merely verifying that the activation script wrote some JSON.
    const effective=settingsTarget(saved);
    expect(effective).toBe(saved);
    expect(effective.CLAUDE_MEM_MEMORY_SEARCH_HOOK_ENABLED).toBe('true');
    expect(JSON.parse(effective.CLAUDE_MEM_MEMORY_WATCH_ROOTS as string)).toEqual([{path:path.join(f.workspace,'.claude/memory'),project:'project'}]);
    const backupRoot=path.join(f.workspace,'.agent-jobs/progressive-mem-search');
    expect(f.run('--restore',path.join(backupRoot,readdirSync(backupRoot)[0])).status).toBe(0);
    expect(readFileSync(target,'utf8')).toBe(bytes);
  });

  for (const selection of ['flat BOM settings', 'nested home-relative settings', 'environment override', 'CLI override'] as const) {
    it(`updates and rolls back the worker's resolved settings with ${selection}`, () => {
      const f=fixture();
      const defaultSettings=path.join(f.root,'.claude-mem/settings.json');
      const stale=path.join(f.root,'stale-data');
      const redirect=selection==='flat BOM settings'
        ? {CLAUDE_MEM_DATA_DIR:f.data, unrelated:'keep redirect metadata'}
        : {CLAUDE_MEM_DATA_DIR:stale, env:{CLAUDE_MEM_DATA_DIR:selection==='nested home-relative settings'?'~/memory':stale}, unrelated:'keep redirect metadata'};
      mkdirSync(path.dirname(defaultSettings),{recursive:true});
      const originalRedirect='\uFEFF'+JSON.stringify(redirect);
      writeFileSync(defaultSettings,originalRedirect);
      const target=path.join(f.data,'settings.json');
      const originalTarget='\uFEFF'+readFileSync(target,'utf8');
      writeFileSync(target,originalTarget);
      const nativeSettings=path.join(f.claude,'settings.json');
      const nativeBytes=JSON.stringify({autoMemoryEnabled:false,unrelated:'preserve native choices'});
      writeFileSync(nativeSettings,nativeBytes);
      const overrides=selection==='environment override'?{CLAUDE_MEM_DATA_DIR:'~/memory'}
        : selection==='CLI override'?{CLAUDE_MEM_DATA_DIR:stale}:{};
      const extra=selection==='CLI override'?['--memory-data-dir','~/memory']:[];
      const dry=f.runResolved(overrides,...extra);
      expect(dry.status,dry.stderr).toBe(0);
      expect(dry.stdout).toContain(target);
      expect(readFileSync(defaultSettings,'utf8')).toBe(originalRedirect);
      expect(readFileSync(target,'utf8')).toBe(originalTarget);
      const apply=f.runResolved(overrides,...extra,'--apply');
      expect(apply.status,apply.stderr).toBe(0);
      const saved=JSON.parse(readFileSync(target,'utf8'));
      expect(JSON.parse(saved.env.CLAUDE_MEM_MEMORY_WATCH_ROOTS)).toEqual([{path:path.join(f.workspace,'.claude/memory'),project:'project'}]);
      expect(saved.env.existing_secret).toBe('fixture secret');
      expect(readFileSync(defaultSettings,'utf8')).toBe(originalRedirect);
      expect(readFileSync(nativeSettings,'utf8')).toBe(nativeBytes);
      expect(existsSync(stale)).toBe(false);
      const backupRoot=path.join(f.workspace,'.agent-jobs/progressive-mem-search');
      const backup=path.join(backupRoot,readdirSync(backupRoot)[0]);
      const manifest=JSON.parse(readFileSync(path.join(backup,'manifest.json'),'utf8'));
      expect(manifest.files.some((entry:{target:string})=>entry.target===target)).toBe(true);
      expect(manifest.files.some((entry:{target:string})=>entry.target===defaultSettings)).toBe(false);
      expect(f.runResolved(overrides,'--restore',backup).status).toBe(0);
      expect(readFileSync(target,'utf8')).toBe(originalTarget);
      expect(readFileSync(defaultSettings,'utf8')).toBe(originalRedirect);
    });
  }

  for (const [label, included, platform] of [
    ['Claude marketplace only', [0], 'claude'],
    ['Claude cache only', [1], 'claude'],
    ['Claude marketplace and cache', [0, 1], 'claude'],
    ['Codex cache only', [2], 'codex'],
  ] as const) {
    it(`discovers ${label}, updates only its instructions, and rolls back safely`, () => {
      const f=fixture();
      for(let index=0;index<f.targets.length;index++) if(!(included as readonly number[]).includes(index)) rmSync(f.targets[index],{recursive:true});
      const instruction=path.join(platform==='claude'?f.claude:f.codex, platform==='claude'?'CLAUDE.md':'AGENTS.md');
      const unusedInstruction=path.join(platform==='claude'?f.codex:f.claude, platform==='claude'?'AGENTS.md':'CLAUDE.md');
      const originalInstruction=readFileSync(instruction,'utf8');
      const originalSettings=readFileSync(path.join(f.data,'settings.json'),'utf8');
      rmSync(unusedInstruction);
      const apply=f.run('--apply');
      expect(apply.status).toBe(0);
      for(const index of included) expect(readFileSync(path.join(f.targets[index],'scripts/worker-service.cjs'),'utf8')).toContain('sourceFingerprint');
      for(let index=0;index<f.targets.length;index++) if(!(included as readonly number[]).includes(index)) expect(existsSync(f.targets[index])).toBe(false);
      expect(readFileSync(instruction,'utf8')).toContain('use plugin notes');
      expect(existsSync(unusedInstruction)).toBe(false);
      const backupRoot=path.join(f.workspace,'.agent-jobs/progressive-mem-search');
      const backup=path.join(backupRoot,readdirSync(backupRoot)[0]);
      const manifest=JSON.parse(readFileSync(path.join(backup,'manifest.json'),'utf8'));
      expect(manifest.files.some((entry:{target:string})=>entry.target===unusedInstruction)).toBe(false);
      expect(f.run('--restore',backup).status).toBe(0);
      expect(readFileSync(instruction,'utf8')).toBe(originalInstruction);
      expect(readFileSync(path.join(f.data,'settings.json'),'utf8')).toBe(originalSettings);
      expect(existsSync(unusedInstruction)).toBe(false);
    });
  }

  it('refuses activation without an installed target before changing instructions or settings', () => {
    const f=fixture();
    for(const target of f.targets) rmSync(target,{recursive:true});
    const original=readFileSync(path.join(f.data,'settings.json'),'utf8');
    const result=f.run('--apply');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No supported installed claude-mem plugin');
    expect(readFileSync(path.join(f.data,'settings.json'),'utf8')).toBe(original);
    expect(readFileSync(path.join(f.claude,'CLAUDE.md'),'utf8')).toBe('existing Claude instructions\n');
    expect(existsSync(path.join(f.workspace,'.agent-jobs'))).toBe(false);
    expect(existsSync(path.join(f.workspace,'.claude/memory'))).toBe(false);
  });

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
    expect(existsSync(path.join(f.workspace,'.agent-jobs'))).toBe(false);
  });
});
