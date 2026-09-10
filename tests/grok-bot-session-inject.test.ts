import { describe, it, expect } from 'bun:test';
import { injectTextToFactLines, injectLogPath } from '../scripts/grok-bot-session-inject.mjs';

/**
 * The whole point of this shim is that the sand host parses what it writes.
 * The host's grammar (grok-bot-harness memory-file-format) is:
 *
 *   MEMORY_FACT_LINE = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.+?)\s*$/
 *   normalizeMemoryContent = clampLine(raw, 500)   // \s+ -> ' ', then slice
 *
 * GrokBotAwarenessPusher deliberately writes `- <date> [awareness] ...`, which
 * that regex does NOT match — awareness lines never reach the prompt. Inject
 * lines must match, so these tests pin the grammar.
 */
const HOST_MEMORY_FACT_LINE = /^-\s+\((\d{4}-\d{2}-\d{2})\)\s+(.+?)\s*$/;
const HOST_MAX_CONTENT_LENGTH = 500;

const NOW = new Date('2026-09-10T03:41:00.000Z');

function sampleInject(rowCount: number): string {
  const rows = Array.from({ length: rowCount }, (_, i) => `${17000 + i} 6:0${i % 10}p ○ observation number ${i}`);
  return [
    '# [cmem_work_orifice] recent context, 2026-09-10 3:41am UTC',
    'Mode: Code Development (code)',
    '',
    'Legend: 🎯session ●bugfix',
    'Format: ID TIME TYPE TITLE',
    'Fetch details: get_observations([IDs]) | Search: mem-search skill',
    '',
    'Stats: 45 obs (22,097t read) | 2,160,208t work | 99% savings',
    '',
    '### Sep 8, 2026',
    ...rows,
  ].join('\n');
}

describe('injectTextToFactLines', () => {
  const options = { projects: ['cmem_work_orifice'], maxLines: 2, maxLineChars: 460, tier: 'episode', now: NOW };

  it('emits lines the host parses as memory facts', () => {
    const lines = injectTextToFactLines(sampleInject(20), options);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      const match = HOST_MEMORY_FACT_LINE.exec(line);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('2026-09-10');
      expect(match![2].length).toBeLessThanOrEqual(HOST_MAX_CONTENT_LENGTH);
    }
  });

  it('never exceeds the configured line budget', () => {
    const lines = injectTextToFactLines(sampleInject(400), options);
    expect(lines.length).toBeLessThanOrEqual(options.maxLines);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(options.maxLineChars);
    }
  });

  it('carries the tier prefix the host ranks on', () => {
    const episode = injectTextToFactLines(sampleInject(5), options);
    for (const line of episode) expect(line).toContain('[episode] [claude-mem]');

    const plain = injectTextToFactLines(sampleInject(5), { ...options, tier: 'plain' });
    for (const line of plain) {
      expect(line).toContain('[claude-mem]');
      expect(line).not.toContain('[episode]');
    }
  });

  it('keeps the newest rows when it has to truncate', () => {
    const lines = injectTextToFactLines(sampleInject(400), options).join('\n');
    expect(lines).toContain('observation number 399');
    expect(lines).not.toContain('observation number 0 ');
    expect(lines).toContain('older rows in claude-mem');
  });

  it('drops glyph-legend boilerplate but keeps the project header and stats', () => {
    const lines = injectTextToFactLines(sampleInject(5), options).join('\n');
    expect(lines).toContain('cmem_work_orifice');
    expect(lines).toContain('2,160,208t work');
    expect(lines).not.toContain('Legend:');
    expect(lines).not.toContain('Format: ID TIME');
  });

  it('still emits a lead fact when the project has no sessions yet', () => {
    const empty = '# [cmem_work_orifice] recent context, 2026-09-10 3:41am UTC\nMode: Code Development (code)\n\nNo previous sessions found.';
    const lines = injectTextToFactLines(empty, options);
    expect(lines.length).toBe(2);
    expect(HOST_MEMORY_FACT_LINE.test(lines[0])).toBe(true);
    expect(lines[0]).toContain('cmem_work_orifice');
    expect(lines[1]).toContain('No previous sessions found.');
  });
});

describe('injectLogPath', () => {
  it('targets the agent log folder and never profile.md', () => {
    const filePath = injectLogPath('/home/box/agent-data', '95601360-61f7-4fd9-bb3a-2c976b2b85c0');
    expect(filePath).toBe(
      '/home/box/agent-data/agents/95601360-61f7-4fd9-bb3a-2c976b2b85c0/memory/log/zz-claude-mem-inject.md',
    );
    expect(filePath.endsWith('profile.md')).toBe(false);
  });

  it('uses a filename the host never writes itself (host owns YYYY-MM.md)', () => {
    const filePath = injectLogPath('/root', '95601360-61f7-4fd9-bb3a-2c976b2b85c0');
    expect(/\d{4}-\d{2}\.md$/.test(filePath)).toBe(false);
  });
});
