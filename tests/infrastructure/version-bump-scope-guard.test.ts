import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * The version-bump skill ships to every user inside plugin/skills, and it pushes
 * main, tags, creates a GitHub release and posts to X. It must refuse to run in
 * any repository other than thedotmack/claude-mem (#4430).
 */

const PROJECT_ROOT = join(import.meta.dir, '../..');
const VERSION_BUMP_SKILL = join(PROJECT_ROOT, 'plugin/skills/version-bump/SKILL.md');

const SHIPPED_SKILL_ROOTS = [
  'plugin/skills',
  'cowork/skills',
  'claude-mem-cursor/skills',
  'claude-mem-grok-bot/skills',
  'openclaw/skills',
];

function frontmatterDescription(content: string): string {
  const match = content.match(/^---\n[\s\S]*?^description:\s*(.+)$[\s\S]*?^---$/m);
  if (!match) throw new Error('version-bump SKILL.md has no frontmatter description');
  return match[1];
}

function shippedSkillFiles(): string[] {
  const files: string[] = [];
  for (const root of SHIPPED_SKILL_ROOTS) {
    const absoluteRoot = join(PROJECT_ROOT, root);
    if (!existsSync(absoluteRoot)) continue;
    for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
      const skillFile = join(absoluteRoot, entry.name, 'SKILL.md');
      if (entry.isDirectory() && existsSync(skillFile)) files.push(skillFile);
    }
  }
  return files;
}

describe('version-bump skill scope guard (#4430)', () => {
  const content = readFileSync(VERSION_BUMP_SKILL, 'utf-8');

  it('describes itself as the thedotmack/claude-mem release workflow only', () => {
    const description = frontmatterDescription(content);
    expect(description).toContain('thedotmack/claude-mem');
    expect(description).toContain('Does not apply to any other repository');
  });

  it('checks the origin remote and package name before Preparation, and stops otherwise', () => {
    const scopeSection = content.indexOf('## Scope — check this first');
    const preparationSection = content.indexOf('## Preparation');
    expect(scopeSection).toBeGreaterThan(-1);
    expect(preparationSection).toBeGreaterThan(scopeSection);

    const scopeText = content.slice(scopeSection, preparationSection);
    expect(scopeText).toContain('git remote get-url origin');
    expect(scopeText).toContain('github.com/thedotmack/claude-mem');
    expect(scopeText).toContain(`node -p "require('./package.json').name"`);
    expect(scopeText).toContain('If either check fails, stop');
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
});
