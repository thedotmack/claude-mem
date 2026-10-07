import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'fs';
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

  it('npm "files" entries do not contain the maintainer skill', () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'));
    for (const entry of pkg.files as string[]) {
      expect({ entry, shipsSkill: containsMaintainerSkill(entry) }).toEqual({
        entry,
        shipsSkill: false,
      });
    }
  });

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
