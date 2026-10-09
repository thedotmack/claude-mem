import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, relative, resolve } from 'path';

/**
 * The version-bump skill drives the maintainer's npm token and `npm publish`.
 * It must stay out of everything that ships to users (#4430): the npm tarball
 * ("files" in package.json) and the marketplace plugin bundles.
 */

const PROJECT_ROOT = join(import.meta.dir, '../..');
const MAINTAINER_SKILL_DIR = join(PROJECT_ROOT, '.claude/skills/version-bump');

const SHIPPED_SKILL_ROOTS = [
  'plugin/skills',
  'cowork/skills',
  'claude-mem-cursor/skills',
  'claude-mem-grok-bot/skills',
  'openclaw/skills',
];

const MARKETPLACE_MANIFESTS = [
  '.claude-plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
  '.cursor-plugin/marketplace.json',
];

/** True when shipping `source` (a repo-relative path) would include the skill. */
function containsMaintainerSkill(source: string): boolean {
  const target = resolve(PROJECT_ROOT, source);
  const rel = relative(target, MAINTAINER_SKILL_DIR);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Paths npm would put in the tarball for the package in `cwd`. `files` entries
 * are globs, so ask npm itself rather than treating them as literal paths.
 */
function npmPackedFiles(cwd: string): string[] {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd,
    encoding: 'utf-8',
  });
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr}`);
  const [pack] = JSON.parse(result.stdout);
  return pack.files.map((file: { path: string }) => file.path);
}

function packsMaintainerSkill(paths: string[]): boolean {
  return paths.some((path) => path.startsWith('.claude/skills/version-bump/'));
}

/** Pack a throwaway package with the repo's .npmignore, the skill, and `files`. */
function npmPackedFilesFor(files: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-pack-'));
  try {
    cpSync(MAINTAINER_SKILL_DIR, join(dir, '.claude/skills/version-bump'), { recursive: true });
    cpSync(join(PROJECT_ROOT, '.npmignore'), join(dir, '.npmignore'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pack-fixture', version: '0.0.0', files }));
    return npmPackedFiles(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function shippedSkillFiles(): string[] {
  const files: string[] = [];
  for (const root of SHIPPED_SKILL_ROOTS) {
    const abs = join(PROJECT_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const skillFile = join(abs, entry.name, 'SKILL.md');
      if (entry.isDirectory() && existsSync(skillFile)) files.push(skillFile);
    }
  }
  return files;
}

describe('maintainer-only skills are not shipped (#4430)', () => {
  it('version-bump lives in .claude/skills, not in any shipped skill root', () => {
    expect(existsSync(join(MAINTAINER_SKILL_DIR, 'SKILL.md'))).toBe(true);
    for (const root of SHIPPED_SKILL_ROOTS) {
      expect(existsSync(join(PROJECT_ROOT, root, 'version-bump'))).toBe(false);
    }
  });

  it('the npm tarball does not contain the maintainer skill', () => {
    const packed = npmPackedFiles(PROJECT_ROOT);
    expect(packed.length).toBeGreaterThan(0);
    expect(packed.filter((path) => path.startsWith('.claude/'))).toEqual([]);
  }, 30_000);

  it('the npm tarball check catches "files" patterns that pick up the skill', () => {
    const leaking = ['.claude', '.claude/skills', '.claude/skills/*', '.claude/**', '.claude/skills/version-bump'];
    for (const entry of leaking) {
      expect({ entry, shipsSkill: packsMaintainerSkill(npmPackedFilesFor([entry])) }).toEqual({
        entry,
        shipsSkill: true,
      });
    }
    expect(packsMaintainerSkill(npmPackedFilesFor(['plugin/skills']))).toBe(false);
  }, 60_000);

  it('no marketplace plugin source contains the maintainer skill', () => {
    let checked = 0;
    for (const manifest of MARKETPLACE_MANIFESTS) {
      const marketplace = JSON.parse(readFileSync(join(PROJECT_ROOT, manifest), 'utf-8'));
      for (const plugin of marketplace.plugins) {
        const source = typeof plugin.source === 'string' ? plugin.source : plugin.source?.path;
        if (typeof source !== 'string') continue; // remote (github/url) sources
        checked++;
        expect({ manifest, source, shipsSkill: containsMaintainerSkill(source) }).toEqual({
          manifest,
          source,
          shipsSkill: false,
        });
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('no shipped SKILL.md tells an agent to use ~/.npmrc credentials', () => {
    const files = shippedSkillFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect({ file, mentionsNpmrc: readFileSync(file, 'utf-8').includes('.npmrc') }).toEqual({
        file,
        mentionsNpmrc: false,
      });
    }
  });

  it('version-bump keeps its scope check and publish confirmation gate', () => {
    const content = readFileSync(join(MAINTAINER_SKILL_DIR, 'SKILL.md'), 'utf-8');
    const required = [
      // scope check
      '## Scope — check this first',
      'git remote get-url origin',
      'github.com/thedotmack/claude-mem',
      "require('./package.json').name",
      'If either check fails, stop',
      // publish confirmation gate
      '**Confirmation gate.**',
      'npm publish --dry-run',
      'wait for\n    the maintainer to reply with an explicit yes',
      'A standing instruction to release is not the confirmation',
      "If `npm whoami` prints anything other than\n    `thedotmack`, stop.",
      // credential handling
      'Never read, print, copy, or edit',
    ];
    for (const text of required) {
      expect({ text, present: content.includes(text) }).toEqual({ text, present: true });
    }
  });
});
