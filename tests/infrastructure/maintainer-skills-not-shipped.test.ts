import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

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

  it('npm "files" and marketplace sources do not include .claude/', () => {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'));
    for (const entry of pkg.files as string[]) {
      expect(entry.startsWith('.claude/') || entry === '.claude').toBe(false);
    }

    const marketplace = JSON.parse(
      readFileSync(join(PROJECT_ROOT, '.claude-plugin/marketplace.json'), 'utf-8'),
    );
    for (const plugin of marketplace.plugins) {
      expect(String(plugin.source).replace(/^\.\//, '').startsWith('.claude')).toBe(false);
    }
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
    expect(content).toContain('## Scope — check this first');
    expect(content).toContain('thedotmack/claude-mem');
    expect(content).toContain('**Confirmation gate.**');
    expect(content).toContain('npm publish --dry-run');
    expect(content).toContain('Never read, print, copy, or edit');
  });
});
