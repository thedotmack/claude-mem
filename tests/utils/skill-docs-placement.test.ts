/**
 * Regression test for misplaced smart-explore language docs (#1651)
 *
 * The smart-explore language support section was missing from smart-explore/SKILL.md
 * and had previously been in mem-search/SKILL.md (where it doesn't belong).
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SKILLS_DIR = join(import.meta.dir, '../../plugin/skills');

describe('skill docs placement (#1651)', () => {
  it('smart-explore/SKILL.md contains Language Support section', () => {
    const path = join(SKILLS_DIR, 'smart-explore/SKILL.md');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');

    expect(content).toContain('Language Support');
    expect(content).toContain('tree-sitter');
  });

  it('smart-explore/SKILL.md lists bundled languages', () => {
    const content = readFileSync(join(SKILLS_DIR, 'smart-explore/SKILL.md'), 'utf-8');

    const expectedLanguages = [
      'JavaScript',
      'TypeScript',
      'TSX / JSX',
      'Python',
      'Go',
      'Rust',
      'Ruby',
      'Java',
      'C',
      'C++',
    ];

    for (const language of expectedLanguages) {
      expect(content).toContain(language);
    }

    expect(content).toContain('Files with unrecognized extensions are parsed as plain text');
  });

  it('mem-search/SKILL.md does NOT contain tree-sitter or language grammar docs', () => {
    const path = join(SKILLS_DIR, 'mem-search/SKILL.md');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');

    // Language support docs belong in smart-explore, not mem-search
    expect(content).not.toContain('tree-sitter');
    expect(content).not.toContain('Bundled Languages');
  });
});
