import { describe, it, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  injectTextToFactLines,
  injectLogPath,
  loadConfig,
  slugGrokBotProject,
  listLiveAgents,
  ensureWatchesForLiveAgents,
  resolveAgentIds,
  projectsForAgent,
} from '../scripts/grok-bot-session-inject.mjs';

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

const ORIFICE = '95601360-61f7-4fd9-bb3a-2c976b2b85c0';
const BIFF = '1e5a61c5-5e1e-4ba6-862f-cd831dac62e9';
const GONE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function writeSeat(root: string, agentId: string, name: string): void {
  mkdirSync(path.join(root, 'agents', agentId), { recursive: true });
  mkdirSync(path.join(root, 'agent-transcripts', agentId), { recursive: true });
  writeFileSync(path.join(root, 'agents', agentId, 'profile.json'), JSON.stringify({ name }));
}

function watchCfg(root: string, extra: Record<string, unknown> = {}) {
  return {
    agentIdsAuto: true,
    agentIds: [],
    agentDataRoot: root,
    watchConfigFile: path.join(root, 'transcript-watch.json'),
    projectsByAgent: new Map(),
    ...extra,
  };
}

describe('AGENT_IDS=* / all', () => {
  it('treats * and all as agentIdsAuto with an empty static allowlist', () => {
    expect(loadConfig({ CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: '*' }).agentIdsAuto).toBe(true);
    expect(loadConfig({ CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: '*' }).agentIds).toEqual([]);
    expect(loadConfig({ CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: 'all' }).agentIdsAuto).toBe(true);
    expect(loadConfig({ CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: 'ALL' }).agentIdsAuto).toBe(true);
    const listed = loadConfig({ CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: `${ORIFICE},${BIFF}` });
    expect(listed.agentIdsAuto).toBe(false);
    expect(listed.agentIds).toEqual([ORIFICE, BIFF]);
  });

  it('lists live UUID seats that have profile.json', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'grok-inject-live-'));
    try {
      writeSeat(root, ORIFICE, 'Orifice');
      writeSeat(root, BIFF, 'Biff');
      mkdirSync(path.join(root, 'agents', 'not-a-uuid'), { recursive: true });
      writeFileSync(path.join(root, 'agents', 'not-a-uuid', 'profile.json'), JSON.stringify({ name: 'Nope' }));
      mkdirSync(path.join(root, 'agents', GONE, 'memory', 'log'), { recursive: true });

      const live = listLiveAgents(root);
      expect(live.map(agent => agent.id).sort()).toEqual([BIFF, ORIFICE].sort());
      expect(live.find(agent => agent.id === ORIFICE)?.name).toBe('Orifice');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolveAgentIds in auto mode ensures watches and returns every live watched seat', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'grok-inject-resolve-'));
    try {
      writeSeat(root, ORIFICE, 'Orifice');
      writeFileSync(path.join(root, 'transcript-watch.json'), JSON.stringify({ version: 1, watches: [] }));

      const cfg = watchCfg(root);
      expect(resolveAgentIds(cfg)).toEqual([ORIFICE]);

      writeSeat(root, BIFF, 'Biff');
      expect(resolveAgentIds(cfg).sort()).toEqual([BIFF, ORIFICE].sort());
      expect(projectsForAgent(cfg, ORIFICE)).toEqual(['cmem_work_orifice']);
      expect(projectsForAgent(cfg, BIFF)).toEqual(['cmem_work_biff']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ensureWatchesForLiveAgents', () => {
  it('adds missing live seats with cmem_work_* and preserves existing project names', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'grok-inject-ensure-'));
    try {
      writeSeat(root, ORIFICE, 'Orifice');
      writeSeat(root, BIFF, 'Biff');
      writeFileSync(path.join(root, 'transcript-watch.json'), JSON.stringify({
        version: 1,
        schemas: { cursor: { name: 'cursor' } },
        watches: [
          { name: 'cursor', path: '/tmp/cursor.jsonl', schema: 'cursor' },
          { name: 'grok-bot', agentId: ORIFICE, project: 'cmem_work_orifice_pilot', schema: 'grok-bot' },
        ],
      }));

      const result = ensureWatchesForLiveAgents(watchCfg(root));
      expect(result).toEqual({ added: 1, pruned: 0 });

      const parsed = JSON.parse(readFileSync(path.join(root, 'transcript-watch.json'), 'utf8'));
      expect(parsed.schemas.cursor.name).toBe('cursor');
      const cursor = parsed.watches.filter((watch: { name: string }) => watch.name === 'cursor');
      expect(cursor).toHaveLength(1);

      const byId = Object.fromEntries(
        parsed.watches
          .filter((watch: { name: string; agentId?: string }) => watch.name === 'grok-bot')
          .map((watch: { agentId: string }) => [watch.agentId, watch]),
      );
      expect(byId[ORIFICE].project).toBe('cmem_work_orifice_pilot');
      expect(byId[BIFF].project).toBe('cmem_work_biff');
      expect(byId[BIFF].path).toBe(path.join(root, 'agent-transcripts', BIFF, '*.jsonl'));
      expect(byId[BIFF].workspace).toBe(path.join(root, '.cmem-projects', 'cmem_work_biff'));
      expect(existsSync(path.join(root, '.cmem-projects', 'cmem_work_biff'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prunes deleted seats and catch-all * watches, and leaves other watches alone', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'grok-inject-prune-'));
    try {
      writeSeat(root, ORIFICE, 'Orifice');
      writeFileSync(path.join(root, 'transcript-watch.json'), JSON.stringify({
        watches: [
          { name: 'cursor', path: '/tmp/cursor.jsonl', schema: 'cursor' },
          { name: 'grok-bot', agentId: '*', project: 'cmem_work_root' },
          { name: 'grok-bot', agentId: ORIFICE, project: 'cmem_work_orifice' },
          { name: 'grok-bot', agentId: GONE, project: 'cmem_work_gone' },
        ],
      }));

      const result = ensureWatchesForLiveAgents(watchCfg(root));
      expect(result).toEqual({ added: 0, pruned: 2 });

      const parsed = JSON.parse(readFileSync(path.join(root, 'transcript-watch.json'), 'utf8'));
      expect(parsed.watches.map((watch: { agentId?: string; name: string }) => watch.agentId || watch.name))
        .toEqual(['cursor', ORIFICE]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op when transcript-watch.json is missing', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'grok-inject-missing-'));
    try {
      writeSeat(root, ORIFICE, 'Orifice');
      expect(ensureWatchesForLiveAgents(watchCfg(root))).toEqual({ added: 0, pruned: 0 });
      expect(existsSync(path.join(root, 'transcript-watch.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('slugs new-hire names with the box slugGrokBotProject rules', () => {
    expect(slugGrokBotProject('Biff')).toBe('cmem_work_biff');
    expect(slugGrokBotProject('New Bot')).toBe('cmem_work_new-bot');
    expect(slugGrokBotProject('box')).toBe('cmem_work_root');
    expect(slugGrokBotProject('Orifice!')).toBe('cmem_work_orifice');
  });
});
