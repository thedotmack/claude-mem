import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SkillCatalog, skillMetadata } from '../../../src/services/skills/catalog.js';

let base: string;
let home: string;
let extra: string;
const writeSkill = async (root: string, name: string, text = '---\nname: same\ndescription: "Edit this skill"\n---\nBody\n') => {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  await writeFile(file, text); return file;
};

beforeEach(async () => {
  // Known-project discovery deliberately ignores OS temporary session folders.
  base = await mkdtemp(path.join(process.cwd(), '.skill-catalog-test-'));
  home = path.join(base, 'home'); extra = path.join(base, 'custom');
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

test('lists distinct scopes, coalesces aliases, respects folders and preserves source bytes', async () => {
  const claude = path.join(home, '.claude', 'skills');
  const codex = path.join(home, '.agents', 'skills');
  const a = await writeSkill(claude, 'deploy');
  const b = await writeSkill(codex, 'deploy');
  const c = await writeSkill(extra, 'nested/collect');
  await symlink(path.dirname(c), path.join(claude, 'alias'), 'dir');
  await writeSkill(extra, '.claude/plugins/cache/vendor/tool');
  await writeSkill(claude, 'synced/tool');
  await writeSkill(extra, 'node_modules/plugin');
  const outside = await writeSkill(path.join(base, 'unconfigured'), 'private');
  await symlink(path.dirname(outside), path.join(claude, 'external'), 'dir');
  await symlink(path.dirname(outside), path.join(path.dirname(a), 'references'), 'dir');

  const catalog = new SkillCatalog({ home, extraFolders: [extra, path.join(base, 'missing')] });
  const list = await catalog.refresh();
  expect(list.skills).toHaveLength(4);
  expect(list.skills.filter(s => s.editable).map(s => s.location).sort()).toEqual([a,b,c].sort());
  const unavailable = list.skills.find(s => !s.editable)!;
  expect(unavailable.location).toContain('external');
  expect(unavailable.problem).toContain('EXTRA_SKILL_FOLDERS');
  expect(list.issues).toHaveLength(1);
  const first = list.skills.find(s => s.location === a)!;
  expect(first.portableRoot).toBe('personal:claude');
  expect(first.relativePath).toBe('deploy/SKILL.md');
  expect((await catalog.read(first.id)).text).toBe(await readFile(a, 'utf8'));
  expect((await catalog.refresh()).skills.map(s => s.id)).toEqual(list.skills.map(s => s.id));
  await expect(catalog.read(unavailable.id)).rejects.toThrow('unavailable');
});

test('finds nested and worktree projects from actual session cwd records, without observations', async () => {
  const project = path.join(base, 'project'), worktree = path.join(base, 'worktree');
  await mkdir(path.join(project, '.git'), { recursive: true });
  await mkdir(worktree);
  await writeFile(path.join(worktree, '.git'), 'gitdir: ../project/.git/worktrees/wt');
  await writeSkill(path.join(project, '.agents/skills'), 'deploy');
  const sub = path.join(project, 'packages', 'site');
  await writeSkill(path.join(sub, '.claude/skills'), 'deploy');
  await writeSkill(path.join(worktree, '.claude/skills'), 'deploy');
  const databasePath = path.join(base, 'sessions.db');
  const db = new Database(databasePath, { create: true });
  db.exec('CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, cwd TEXT)');
  for (const cwd of [sub, worktree, '/not-on-this-machine', null]) db.query('INSERT INTO sdk_sessions(cwd) VALUES (?)').run(cwd);
  db.close();
  const catalog = new SkillCatalog({ home, databasePath, extraFolders: [] });
  const { skills } = await catalog.refresh();
  expect(skills).toHaveLength(3);
  expect(new Set(skills.map(s => s.id)).size).toBe(3);
  expect(skills.map(s => s.source).sort()).toEqual(['project', 'project/packages/site', 'worktree']);
  expect((await new SkillCatalog({home, databasePath, extraFolders: [], excludedProjects: 'worktree'}).refresh()).skills).toHaveLength(2);
});

test('one malformed file remains editable; body-only Claude, multiline descriptions, and permission state survive', async () => {
  const root = path.join(home, '.claude/skills');
  const invalid = await writeSkill(root, 'repair-me', '---\nname: [broken\n---\nbody');
  const raw = '\uFEFF# Body only\r\nKeep bytes';
  const good = await writeSkill(root, 'plain', raw);
  await chmod(good, 0o444);
  const catalog = new SkillCatalog({ home, extraFolders: [] });
  const { skills } = await catalog.refresh();
  expect(skills.find(s => s.location === invalid)).toMatchObject({name:'repair-me', editable:true, problem: expect.any(String)});
  const simple = skills.find(s=>s.location===good)!;
  expect(simple).toMatchObject({name:'plain',editable:false,problem:null});
  expect((await catalog.read(simple.id)).text).toBe(raw);
  expect(skillMetadata('---\nname: go\ndescription: >-\n  one\n  two\n---\n', 'default', 'codex')).toEqual({name:'go', description:'one two',problem:null});
});

test('refuses targets replaced with symlinks and roots authorized only through a symlink', async () => {
  const original = await writeSkill(extra, 'replace');
  const outside = await writeSkill(path.join(base, 'secrets'), 'replace', 'keep private');
  await mkdir(home, { recursive: true });
  const alias = path.join(base, 'linked-root');
  await symlink(extra, alias, 'dir');
  const catalog = new SkillCatalog({ home, extraFolders: [extra, alias] });
  const { skills } = await catalog.refresh();
  expect(skills).toHaveLength(1);
  await rm(original);
  await symlink(outside, original);
  await expect(catalog.read(skills[0].id)).rejects.toThrow('moved');
  const implicit = path.join(base, 'secrets', 'skills');
  await writeSkill(implicit, 'not-granted');
  await symlink(path.dirname(implicit), path.join(home, '.agents'), 'dir');
  const unfound = await new SkillCatalog({ home, extraFolders: [alias] }).refresh();
  expect(unfound.skills).toHaveLength(0);
  expect(unfound.issues.filter(issue => issue.message.includes('linked'))).toHaveLength(2);
});
