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

    expect(content).toContain('Files with unrecognized extensions do not produce structured symbols');
    expect(content).toContain('`smart_search` is not a general file-content');
    expect(content).toContain('Use `rg` or another text-search tool');
    expect(content).not.toContain('Files with unrecognized extensions are parsed as plain text');
    expect(content).toContain('Custom tree-sitter grammars cannot currently be registered through `.claude-mem.json`');
    expect(content).not.toContain('### Adding Custom Grammars');
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

});
