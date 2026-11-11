import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyConfiguredSkillSelection, applyDisabledSkills, DISABLED_SKILLS_DIRECTORY, parseDisabledSkills, readDisabledSkills } from '../../src/shared/skill-selection.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

let scratch: string;
let root: string;
let original: NodeJS.ProcessEnv;
const selected = (...names: string[]) => new Set(names);
const parked = () => join(root, DISABLED_SKILLS_DIRECTORY);
function addSkill(name: string, body = `# ${name}`, parent = join(root, 'skills')): void {
  mkdirSync(join(parent, name, 'assets'), { recursive: true });
  writeFileSync(join(parent, name, 'SKILL.md'), body);
  writeFileSync(join(parent, name, 'assets', 'example.txt'), 'preserve assets');
}
function makePlugin(path: string): void {
  mkdirSync(join(path, '.claude-plugin'), { recursive: true });
  mkdirSync(join(path, 'skills'), { recursive: true });
  writeFileSync(join(path, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude-mem' }));
}
function saveSettings(value: unknown): void {
  writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR!, 'settings.json'), JSON.stringify(value));
}
beforeEach(() => {
  original = { ...process.env };
  scratch = mkdtempSync(join(tmpdir(), 'skill-selection-'));
  process.env.CLAUDE_CONFIG_DIR = join(scratch, 'claude');
  process.env.CLAUDE_MEM_DATA_DIR = join(scratch, 'data');
  delete process.env.CLAUDE_MEM_SKILLS_DISABLED;
  mkdirSync(process.env.CLAUDE_MEM_DATA_DIR);
  root = join(process.env.CLAUDE_CONFIG_DIR, 'plugins', 'cache', 'thedotmack', 'claude-mem', '15.15.2');
  makePlugin(root);
  addSkill('mem-search');
  addSkill('make-plan');
  addSkill('do');
});
afterEach(() => {
  process.env = original;
  rmSync(scratch, { recursive: true, force: true });
});

describe('disabled skills configuration', () => {
  it('defaults to all skills enabled without writing any files', () => {
    expect(SettingsDefaultsManager.get('CLAUDE_MEM_SKILLS_DISABLED')).toBe('');
    expect(applyConfiguredSkillSelection(root)).toEqual({ disabled: [], enabled: [], warnings: [] });
    expect(readdirSync(root).sort()).toEqual(['.claude-plugin', 'skills']);
    expect(readdirSync(join(root, 'skills')).sort()).toEqual(['do', 'make-plan', 'mem-search']);
  });
  it('accepts trimmed, deduplicated names and arrays', () => {
    expect([...parseDisabledSkills('make-plan, do,,make-plan ')]).toEqual(['make-plan', 'do']);
    expect([...parseDisabledSkills(['make-plan', ' do '])]).toEqual(['make-plan', 'do']);
  });
  for (const invalid of ['../mem-search', '/tmp', 'make-plan/do', 'make-plan\\do', '*', 'claude-mem:do', '.', '..', 'CON', 'nul', ['do', 1], true, 123, null]) {
    it(`rejects invalid input ${JSON.stringify(invalid)} before changing files`, () => {
      expect(() => parseDisabledSkills(invalid)).toThrow();
      expect(existsSync(join(root, 'skills', 'make-plan', 'SKILL.md'))).toBe(true);
    });
  }
  it('reads BOM and legacy nested settings without modifying the file', () => {
    const path = join(process.env.CLAUDE_MEM_DATA_DIR!, 'settings.json');
    const body = '\uFEFF' + JSON.stringify({ env: { CLAUDE_MEM_SKILLS_DISABLED: ['do'] }, CLAUDE_MEM_SKILLS_DISABLED: 'mem-search', other: 1 });
    writeFileSync(path, body);
    expect([...readDisabledSkills()]).toEqual(['do']);
    expect(readFileSync(path, 'utf-8')).toBe(body);
  });
  it('environment overrides the file, including an explicitly empty value', () => {
    saveSettings({ CLAUDE_MEM_SKILLS_DISABLED: 'do' });
    process.env.CLAUDE_MEM_SKILLS_DISABLED = 'make-plan';
    expect([...readDisabledSkills()]).toEqual(['make-plan']);
    process.env.CLAUDE_MEM_SKILLS_DISABLED = '';
    expect([...readDisabledSkills()]).toEqual([]);
  });
  it('does not restore disabled skills when settings are malformed', () => {
    applyDisabledSkills(root, selected('do'));
    writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR!, 'settings.json'), '{broken');
    expect(() => applyConfiguredSkillSelection(root)).toThrow();
    expect(existsSync(join(parked(), 'do', 'SKILL.md'))).toBe(true);
  });
});

describe('installed skill selection', () => {
  it('moves only selected skill directories and preserves their assets', () => {
    expect(applyDisabledSkills(root, selected('make-plan')).disabled).toEqual(['make-plan']);
    expect(existsSync(join(root, 'skills', 'make-plan'))).toBe(false);
    expect(readFileSync(join(parked(), 'make-plan', 'assets', 'example.txt'), 'utf-8')).toBe('preserve assets');
    expect(existsSync(join(root, 'skills', 'mem-search', 'SKILL.md'))).toBe(true);
    expect(applyDisabledSkills(root, selected('make-plan'))).toEqual({ disabled: [], enabled: [], warnings: [] });
  });
  it('clearing the list restores the exact original directory', () => {
    applyDisabledSkills(root, selected('do', 'make-plan'));
    expect(applyDisabledSkills(root, selected()).enabled.sort()).toEqual(['do', 'make-plan']);
    expect(readFileSync(join(root, 'skills', 'do', 'SKILL.md'), 'utf-8')).toBe('# do');
    expect(applyDisabledSkills(root, selected()).enabled).toEqual([]);
  });
  it('changing the list restores deselected names while disabling new ones', () => {
    applyDisabledSkills(root, selected('do'));
    expect(applyDisabledSkills(root, selected('make-plan'))).toEqual({ disabled: ['make-plan'], enabled: ['do'], warnings: [] });
  });
  it('reports unknown names and leaves other skills intact', () => {
    expect(applyDisabledSkills(root, selected('unknown')).warnings).toEqual(['Unknown bundled skill: unknown']);
    expect(readdirSync(join(root, 'skills')).length).toBe(3);
  });
  it('reapplies saved settings to a new cache version without changing the old one', () => {
    saveSettings({ CLAUDE_MEM_SKILLS_DISABLED: 'make-plan' });
    applyConfiguredSkillSelection(root);
    const oldRoot = root;
    root = join(root, '..', '15.15.3');
    makePlugin(root);
    addSkill('make-plan', 'new version');
    addSkill('new-skill');
    applyConfiguredSkillSelection(root);
    expect(readFileSync(join(parked(), 'make-plan', 'SKILL.md'), 'utf-8')).toBe('new version');
    expect(existsSync(join(root, 'skills', 'new-skill', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(oldRoot, DISABLED_SKILLS_DIRECTORY, 'make-plan', 'SKILL.md'), 'utf-8')).toBe('# make-plan');
  });
  it('preserves both copies on a same-directory update and restores the new version', () => {
    applyDisabledSkills(root, selected('do'));
    addSkill('do', 'updated skill');
    applyDisabledSkills(root, selected('do'));
    const history = join(parked(), '.history');
    const [old] = readdirSync(history);
    expect(readFileSync(join(history, old, 'SKILL.md'), 'utf-8')).toBe('# do');
    expect(readFileSync(join(parked(), 'do', 'SKILL.md'), 'utf-8')).toBe('updated skill');
    applyDisabledSkills(root, selected());
    expect(readFileSync(join(root, 'skills', 'do', 'SKILL.md'), 'utf-8')).toBe('updated skill');
  });
  it('does not replace an updated active copy when the skill is enabled', () => {
    applyDisabledSkills(root, selected('do'));
    addSkill('do', 'updated skill');
    applyDisabledSkills(root, selected());
    expect(readFileSync(join(root, 'skills', 'do', 'SKILL.md'), 'utf-8')).toBe('updated skill');
    expect(readdirSync(join(parked(), '.history')).length).toBe(1);
  });
  it('supports the installed marketplace plugin but refuses a source checkout', () => {
    const marketplace = join(process.env.CLAUDE_CONFIG_DIR!, 'plugins', 'marketplaces', 'thedotmack', 'plugin');
    cpSync(root, marketplace, { recursive: true });
    expect(applyDisabledSkills(marketplace, selected('do')).disabled).toEqual(['do']);
    const source = join(scratch, 'source');
    cpSync(root, source, { recursive: true });
    expect(() => applyDisabledSkills(source, selected('do'))).toThrow('only modifies an installed');
    expect(existsSync(join(source, 'skills', 'do', 'SKILL.md'))).toBe(true);
  });
  it('refuses a foreign plugin manifest', () => {
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{"name":"other"}');
    expect(() => applyDisabledSkills(root, selected('do'))).toThrow('requires the claude-mem');
  });
  it('refuses a pre-existing foreign backup directory', () => {
    mkdirSync(parked());
    writeFileSync(join(parked(), 'important.txt'), 'user data');
    expect(() => applyDisabledSkills(root, selected('do'))).toThrow('not owned');
    expect(readFileSync(join(parked(), 'important.txt'), 'utf-8')).toBe('user data');
  });
  for (const target of ['skills', 'skills/do', 'skills/do/SKILL.md', DISABLED_SKILLS_DIRECTORY, '.claude-plugin', '.claude-plugin/plugin.json']) {
    it(`refuses a symbolic link at ${target}`, () => {
      const path = join(root, target);
      const outside = join(scratch, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'precious'), 'keep');
      rmSync(path, { recursive: true, force: true });
      symlinkSync(outside, path, 'junction');
      expect(() => applyDisabledSkills(root, selected('do'))).toThrow();
      expect(readFileSync(join(outside, 'precious'), 'utf-8')).toBe('keep');
    });
  }
  it('refuses a dangling link and preflights all names before moving any', () => {
    rmSync(join(root, 'skills', 'do'), { recursive: true });
    symlinkSync(join(scratch, 'missing'), join(root, 'skills', 'do'), 'junction');
    expect(() => applyDisabledSkills(root, selected('make-plan', 'do'))).toThrow();
    expect(existsSync(join(root, 'skills', 'make-plan', 'SKILL.md'))).toBe(true);
  });
  it('refuses to replace an incomplete skill directory', () => {
    applyDisabledSkills(root, selected('do'));
    mkdirSync(join(root, 'skills', 'do'));
    writeFileSync(join(root, 'skills', 'do', 'notes.txt'), 'keep');
    expect(() => applyDisabledSkills(root, selected())).toThrow('no regular SKILL.md');
    expect(readFileSync(join(root, 'skills', 'do', 'notes.txt'), 'utf-8')).toBe('keep');
  });
  it('does not break an existing lock and releases its own lock after an error', () => {
    const lock = join(root, '.claude-mem-skill-selection.lock');
    mkdirSync(lock);
    expect(() => applyDisabledSkills(root, selected('do'))).toThrow('locked');
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { recursive: true });
    mkdirSync(parked());
    expect(() => applyDisabledSkills(root, selected('do'))).toThrow();
    expect(existsSync(lock)).toBe(false);
  });
});

it('refuses a redirected cache ancestor', () => {
  const ancestor = join(root, '..', '..');
  const outside = join(scratch, 'outside-cache');
  cpSync(ancestor, outside, { recursive: true });
  rmSync(ancestor, { recursive: true });
  symlinkSync(outside, ancestor, 'junction');
  expect(() => applyDisabledSkills(root, selected('do'))).toThrow('symbolic link');
  expect(existsSync(join(outside, 'claude-mem', '15.15.2', 'skills', 'do', 'SKILL.md'))).toBe(true);
});
it('uses the same normalized root for validation and filesystem operations', () => {
  const outside = join(scratch, 'outside');
  mkdirSync(join(outside, 'child'), { recursive: true });
  addSkill('do', 'outside data', join(outside, 'skills'));
  symlinkSync(join(outside, 'child'), join(root, 'jump'), 'junction');
  applyDisabledSkills(`${root}/jump/..`, selected('do'));
  expect(existsSync(join(root, 'skills', 'do'))).toBe(false);
  expect(readFileSync(join(outside, 'skills', 'do', 'SKILL.md'), 'utf-8')).toBe('outside data');
});

it.skipIf(process.platform !== 'win32')('accepts different casing of the same installed Windows path without an unbounded ancestor walk', () => {
  applyDisabledSkills(root.toUpperCase(), selected('do'));
  expect(existsSync(join(root, 'skills', 'do'))).toBe(false);
  expect(existsSync(join(parked(), 'do', 'SKILL.md'))).toBe(true);
});

it.skipIf(process.platform !== 'win32')('accepts different casing of the installed Windows marketplace path', () => {
  const marketplace = join(process.env.CLAUDE_CONFIG_DIR!, 'plugins', 'marketplaces', 'thedotmack', 'plugin');
  cpSync(root, marketplace, { recursive: true });
  expect(applyDisabledSkills(marketplace.toUpperCase(), selected('do')).disabled).toEqual(['do']);
});
