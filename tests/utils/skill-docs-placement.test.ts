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

    expect(content).not.toContain('tree-sitter');
    expect(content).not.toContain('Bundled Languages');
  });

  it('cloud-sync/SKILL.md requires the authenticated Hub probe for success', () => {
    const path = join(SKILLS_DIR, 'cloud-sync/SKILL.md');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');

    expect(content).toContain('hub.reachable: true');
    expect(content).toContain('hub.reachable: false');
    expect(content).toContain('authenticated, read-only');
    expect(content).toContain('GET /v1/sync/status');
    expect(content).toContain('never appends or advances');
    expect(content).not.toContain('/api/pro/sync/status');
  });

  it('cloud sync copy keeps the launch boundary and 4,000,000-byte request contract accurate', () => {
    const docs = readFileSync(join(import.meta.dir, '../../docs/public/cloud-sync.mdx'), 'utf-8');
    const source = readFileSync(join(import.meta.dir, '../../src/services/sync/CloudSync.ts'), 'utf-8');

    expect(docs).toContain('up to 500 ops / 4,000,000 encoded');
    expect(docs).not.toContain('500 ops / 2&nbsp;MB');
    expect(source).toContain('no historical/pre-launch backfill');
    expect(source).not.toContain('This IS backfill');
  });
});
