import { createHash } from 'crypto';
import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const AGENT_COST_REPORT_DIRS = [
  'plugin/skills/agent-cost-report',
  'claude-mem-cursor/skills/agent-cost-report',
  'claude-mem-grok-bot/skills/agent-cost-report',
  'cowork/skills/agent-cost-report',
  'openclaw/skills/agent-cost-report',
].map((path) => join(import.meta.dir, '../../', path));

const SKILLS_DIR = join(import.meta.dir, '../../plugin/skills');

describe('skill docs placement (#1651)', () => {
  it('mem-search metadata can be read by a YAML parser', () => {
    const content = readFileSync(join(SKILLS_DIR, 'mem-search/SKILL.md'), 'utf-8');
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    expect(frontmatter).not.toBeNull();

    const metadata = Bun.YAML.parse(frontmatter![1]) as { name: string; description: string };
    expect(metadata.name).toBe('mem-search');
    expect(typeof metadata.description).toBe('string');
    expect(metadata.description).toContain('search, timeline, then selected get_observations');
  });

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

  it('agent-cost-report uses a spec-compliant name in every bundled copy', () => {
    const names = AGENT_COST_REPORT_DIRS.map((dir) => {
      const content = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      expect(frontmatter).not.toBeNull();

      const metadata = Bun.YAML.parse(frontmatter![1]) as { name: string };
      expect(metadata.name.length).toBeGreaterThan(0);
      expect(metadata.name.length).toBeLessThanOrEqual(64);
      expect(metadata.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(metadata.name).toBe('agent-cost-report');
      return metadata.name;
    });

    expect(new Set(names).size).toBe(1);
  });

  it('agent-cost-report SKILL.md checksum is current in every bundled copy', () => {
    for (const dir of AGENT_COST_REPORT_DIRS) {
      const skill = readFileSync(join(dir, 'SKILL.md'));
      const checksums = readFileSync(join(dir, 'CHECKSUMS.txt'), 'utf-8');
      const skillChecksum = checksums.match(/^([a-f0-9]{64})  SKILL\.md$/m);
      expect(skillChecksum).not.toBeNull();
      expect(createHash('sha256').update(skill).digest('hex')).toBe(skillChecksum![1]);
    }
  });

});
