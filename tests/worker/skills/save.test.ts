import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillCatalog, MAX_SKILL_BYTES, sha256 } from '../../../src/services/skills/catalog.js';
import { saveSkill } from '../../../src/services/skills/save.js';

let home: string, directory: string, file: string, catalog: SkillCatalog, id: string;
const original = '# Original\r\n';
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'skill-save-'));
  home = await realpath(home);
  directory = path.join(home, '.claude', 'skills', 'sample');
  await mkdir(directory, { recursive: true });
  file = path.join(directory, 'SKILL.md');
  await writeFile(file, original);
  catalog = new SkillCatalog({ home, extraFolders: [] });
  id = (await catalog.refresh()).skills[0].id;
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

test('source save preserves bytes, existing mode and sibling files; identical replay is idempotent', async () => {
  await chmod(file, 0o640);
  await writeFile(path.join(directory, 'helper.ts'), '// retained');
  const next = '\uFEFF# Edit 🙂\r\nno trailing newline';
  const result = await saveSkill(catalog, id, sha256(original), next);
  expect(result.revision).toBe(sha256(next));
  expect(result.entry.name).toBe('sample');
  expect(await readFile(file)).toEqual(Buffer.from(next, 'utf8'));
  const savedStat = await stat(file);
  expect(savedStat.mode & 0o777).toBe(0o640);
  expect((await saveSkill(catalog, id, sha256(original), next)).revision).toBe(result.revision);
  expect((await stat(file)).ino).toBe(savedStat.ino);
  expect((await readdir(directory)).sort()).toEqual(['SKILL.md', 'helper.ts']);
});

test('conflicts preserve existing edits and the queue recovers after a failure', async () => {
  const results = await Promise.allSettled([
    saveSkill(catalog, id, sha256(original), 'one'),
    saveSkill(catalog, id, sha256(original), 'two'),
  ]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect((results[1] as PromiseRejectedResult).reason.status).toBe(409);
  expect(await readFile(file, 'utf8')).toBe('one');
  await writeFile(file, 'external');
  await expect(saveSkill(catalog, id, sha256('one'), 'three')).rejects.toMatchObject({status:409});
  await saveSkill(catalog, id, sha256('external'), 'four');
  expect(await readFile(file, 'utf8')).toBe('four');
});

test('validates text, front matter, stale base and permissions before modifying disk', async () => {
  for (const [text, status] of [['bad\uD801', 422], ['a\0b', 422], ['---\nname: [oops\n---\n', 422], ['é'.repeat(MAX_SKILL_BYTES / 2 + 1), 413]] as const) {
    await expect(saveSkill(catalog, id, sha256(original), text)).rejects.toMatchObject({status});
  }
  await expect(saveSkill(catalog, id, 'wrong', 'new')).rejects.toMatchObject({status:400});
  await chmod(file, 0o444);
  await expect(saveSkill(catalog, id, sha256(original), 'new')).rejects.toMatchObject({status:403});
  expect(await readFile(file, 'utf8')).toBe(original);
  expect(await readdir(directory)).toEqual(['SKILL.md']);
});

test('a parent replacement during staging never writes outside the approved skill root', async () => {
  const outside = path.join(home, 'outside');
  const moved = path.join(home, 'moved');
  await mkdir(outside); await writeFile(path.join(outside, 'SKILL.md'), 'private');
  class MovedCatalog extends SkillCatalog {
    reads = 0;
    override async read(target: string) {
      if (++this.reads === 2) {
        await rename(directory, moved);
        await symlink(outside, directory, 'dir');
      }
      return super.read(target);
    }
  }
  await expect(saveSkill(new MovedCatalog({ home, extraFolders:[] }), id, sha256(original), 'staged'))
    .rejects.toThrow();
  expect(await readFile(path.join(outside, 'SKILL.md'), 'utf8')).toBe('private');
  expect(await readFile(path.join(moved, 'SKILL.md'), 'utf8')).toBe(original);
  expect(await readdir(outside)).toEqual(['SKILL.md']);
  if (process.platform === 'linux') expect(await readdir(moved)).toEqual(['SKILL.md']);
});
