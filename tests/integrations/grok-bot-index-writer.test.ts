import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  AGENT_ID_RE,
  HOST_MEMORY_FACT_LINE,
  HOST_MAX_FACT_CHARS,
  assertSafeInjectPath,
  factBlock,
  formatIndexFactLines,
  injectLogPath,
  mergeIndexObservations,
  renderIndexFile,
  shouldRewriteInject,
  type GrokBotIndexObservation,
} from '../../src/services/integrations/grok-bot-index-format.js';
import {
  loadGrokBotIndexConfig,
  projectsForAgent,
  refreshGrokBotIndexes,
  refreshSeatIndex,
  resetGrokBotIndexWriterForTests,
  resolveIndexSeats,
  type GrokBotIndexConfig,
  type GrokBotIndexQueryFns,
} from '../../src/services/integrations/GrokBotIndexWriter.js';

const PRIORITIZER = '11111111-2222-4333-8444-555555555555';
const ORIFICE = '95601360-61f7-4fd9-bb3a-2c976b2b85c0';
const NOW = new Date('2026-09-16T12:00:00.000Z');

const temps: string[] = [];

afterEach(() => {
  resetGrokBotIndexWriterForTests();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'grok-index-'));
  temps.push(dir);
  return dir;
}

function writeSeat(root: string, agentId: string, name: string): void {
  mkdirSync(path.join(root, 'agents', agentId, 'memory', 'log'), { recursive: true });
  mkdirSync(path.join(root, 'agent-transcripts', agentId), { recursive: true });
  writeFileSync(path.join(root, 'agents', agentId, 'profile.json'), JSON.stringify({ name }));
}

function obs(id: number, title: string, epoch: number, project = 'cmem_work_prioritizer'): GrokBotIndexObservation {
  return {
    id,
    type: 'discovery',
    title,
    created_at: new Date(epoch).toISOString(),
    created_at_epoch: epoch,
    project,
  };
}

function makeCfg(root: string, overrides: Partial<GrokBotIndexConfig> = {}): GrokBotIndexConfig {
  return {
    enabled: true,
    agentIdsAuto: true,
    agentIds: [],
    projectsByAgent: new Map(),
    fallback: 'house',
    platformSource: '',
    tier: 'episode',
    window: 80,
    maxLineChars: 160,
    debounceMs: 0,
    agentDataRoot: root,
    watchConfigFile: path.join(root, 'transcript-watch.json'),
    ...overrides,
  };
}

function queries(seatRows: GrokBotIndexObservation[], houseRows: GrokBotIndexObservation[]): GrokBotIndexQueryFns {
  return {
    querySeat: () => seatRows,
    queryHouse: () => houseRows,
  };
}

describe('mergeIndexObservations', () => {
  it('fills a thin seat diary from newer house rows without dropping IDs', () => {
    const seat = [obs(5, 'Seat stale', 1_000, 'cmem_work_prioritizer')];
    const house = [
      obs(80, 'House newest', 8_000, 'claude-mem'),
      obs(79, 'House previous', 7_900, 'worker'),
      obs(5, 'Seat stale', 1_000, 'cmem_work_prioritizer'),
    ];
    const merged = mergeIndexObservations(seat, house, 80);
    expect(merged.map(row => row.id)).toEqual([80, 79, 5]);
    expect(merged[0].title).toBe('House newest');
  });

  it('slides off the oldest rows past the window', () => {
    const house = Array.from({ length: 120 }, (_, i) => obs(i + 1, `Row ${i + 1}`, i + 1, 'house'));
    const merged = mergeIndexObservations([], house, 80);
    expect(merged).toHaveLength(80);
    expect(merged[0].id).toBe(120);
    expect(merged[merged.length - 1].id).toBe(41);
  });
});

describe('formatIndexFactLines', () => {
  it('emits host-parseable Memory facts with observation IDs', () => {
    const lines = formatIndexFactLines(
      [obs(17401, 'Grew the inject allowlist', Date.parse('2026-09-16T14:03:00Z'))],
      { primaryProject: 'cmem_work_prioritizer', now: NOW, houseFilled: true },
    );
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const match = HOST_MEMORY_FACT_LINE.exec(line);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('2026-09-16');
      expect(match![2].length).toBeLessThanOrEqual(HOST_MAX_FACT_CHARS);
      expect(line).toContain('[episode] [claude-mem]');
    }
    expect(lines[0]).toContain('cmem_work_prioritizer');
    expect(lines[0]).toContain('house fill');
    expect(lines[1]).toContain('17401');
    expect(lines[1]).toContain('Grew the inject allowlist');
  });
});

describe('path guards', () => {
  it('targets zz-claude-mem-inject.md and refuses profile.md', () => {
    const root = '/home/box/agent-data';
    const filePath = injectLogPath(root, PRIORITIZER);
    expect(filePath).toBe(`/home/box/agent-data/agents/${PRIORITIZER}/memory/log/zz-claude-mem-inject.md`);
    expect(AGENT_ID_RE.test(PRIORITIZER)).toBe(true);
    expect(() => assertSafeInjectPath(root, PRIORITIZER, path.join(root, 'agents', PRIORITIZER, 'memory', 'log', 'profile.md')))
      .toThrow(/profile\.md/);
    expect(() => injectLogPath(root, '../etc')).toThrow(/non-UUID/);
  });
});

describe('refreshSeatIndex live write', () => {
  it('writes a growing INDEX and does not touch CCS or profile.md', async () => {
    const root = tempRoot();
    writeSeat(root, PRIORITIZER, 'Prioritizer');
    writeFileSync(path.join(root, 'transcript-watch.json'), JSON.stringify({
      watches: [{ name: 'grok-bot', agentId: PRIORITIZER, project: 'cmem_work_prioritizer' }],
    }));
    const cfg = makeCfg(root);

    const first = refreshSeatIndex(
      cfg,
      { id: PRIORITIZER, name: 'Prioritizer', projects: ['cmem_work_prioritizer'] },
      queries(
        [obs(5, 'Seat only', 1_000)],
        [obs(80, 'House newest', 8_000, 'claude-mem'), obs(5, 'Seat only', 1_000)],
      ),
      NOW,
    );
    expect(first.status).toBe('written');
    expect(first.houseFilled).toBe(true);
    expect(first.filePath).toBe(injectLogPath(root, PRIORITIZER));

    const firstText = readFileSync(first.filePath!, 'utf8');
    expect(firstText).toContain('80');
    expect(firstText).toContain('House newest');
    expect(firstText).toContain('Seat only');
    expect(existsSync(path.join(root, 'ccs'))).toBe(false);
    expect(existsSync(path.join(root, 'agents', PRIORITIZER, 'profile.md'))).toBe(false);

    const second = refreshSeatIndex(
      cfg,
      { id: PRIORITIZER, name: 'Prioritizer', projects: ['cmem_work_prioritizer'] },
      queries(
        [obs(6, 'Seat grew', 9_000), obs(5, 'Seat only', 1_000)],
        [obs(81, 'Even newer house', 9_500, 'claude-mem'), obs(6, 'Seat grew', 9_000), obs(5, 'Seat only', 1_000)],
      ),
      NOW,
    );
    expect(second.status).toBe('written');
    const secondText = readFileSync(second.filePath!, 'utf8');
    expect(secondText).toContain('Even newer house');
    expect(secondText).toContain('Seat grew');
    expect(shouldRewriteInject(firstText, secondText)).toBe(true);

    const third = refreshSeatIndex(
      cfg,
      { id: PRIORITIZER, name: 'Prioritizer', projects: ['cmem_work_prioritizer'] },
      queries(
        [obs(6, 'Seat grew', 9_000), obs(5, 'Seat only', 1_000)],
        [obs(81, 'Even newer house', 9_500, 'claude-mem'), obs(6, 'Seat grew', 9_000), obs(5, 'Seat only', 1_000)],
      ),
      NOW,
    );
    expect(third.status).toBe('unchanged');
    expect(factBlock(readFileSync(third.filePath!, 'utf8'))).toBe(factBlock(secondText));
  });

  it('skips CCS as a required intermediate even when a TIMELINE.md already exists', () => {
    const root = tempRoot();
    writeSeat(root, ORIFICE, 'Orifice');
    const ccsPath = path.join(root, 'ccs', 'seats', ORIFICE, 'TIMELINE.md');
    mkdirSync(path.dirname(ccsPath), { recursive: true });
    writeFileSync(ccsPath, '# leftover CCS bucket\n');

    refreshSeatIndex(
      makeCfg(root, { agentIdsAuto: false, agentIds: [ORIFICE] }),
      { id: ORIFICE, name: 'Orifice', projects: ['cmem_work_orifice'] },
      queries([obs(9, 'Direct write', 2_000, 'cmem_work_orifice')], []),
      NOW,
    );

    expect(readFileSync(ccsPath, 'utf8')).toBe('# leftover CCS bucket\n');
    expect(readFileSync(injectLogPath(root, ORIFICE), 'utf8')).toContain('Direct write');
  });

  it('does not write when inject is disabled', async () => {
    const root = tempRoot();
    writeSeat(root, PRIORITIZER, 'Prioritizer');
    const results = await refreshGrokBotIndexes(
      makeCfg(root, { enabled: false }),
      queries([obs(1, 'Nope', 1)], []),
      NOW,
    );
    expect(results).toEqual([]);
    expect(existsSync(injectLogPath(root, PRIORITIZER))).toBe(false);
  });
});

describe('seat mapping', () => {
  it('maps live seats from profile.json and transcript-watch projects', () => {
    const root = tempRoot();
    writeSeat(root, PRIORITIZER, 'Prioritizer');
    writeFileSync(path.join(root, 'transcript-watch.json'), JSON.stringify({
      watches: [{ name: 'grok-bot', agentId: PRIORITIZER, project: 'cmem_work_prioritizer' }],
    }));
    const cfg = makeCfg(root);
    expect(resolveIndexSeats(cfg)).toEqual([{
      id: PRIORITIZER,
      name: 'Prioritizer',
      projects: ['cmem_work_prioritizer'],
    }]);
    expect(projectsForAgent(cfg, PRIORITIZER, 'Prioritizer')).toEqual(['cmem_work_prioritizer']);
  });

  it('falls back to the slugged seat name when no watch project exists', () => {
    const root = tempRoot();
    writeSeat(root, PRIORITIZER, 'Prioritizer');
    writeFileSync(path.join(root, 'transcript-watch.json'), JSON.stringify({ watches: [] }));
    expect(projectsForAgent(makeCfg(root), PRIORITIZER, 'Prioritizer')).toEqual(['cmem_work_prioritizer']);
  });
});

describe('loadGrokBotIndexConfig', () => {
  it('defaults to enabled house-fill for every live seat', () => {
    const settingsPath = path.join(tempRoot(), 'settings.json');
    writeFileSync(settingsPath, '{}');
    const cfg = loadGrokBotIndexConfig(settingsPath, {
      ...process.env,
      CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: undefined,
      CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: undefined,
      CLAUDE_MEM_GROK_BOT_INJECT_FALLBACK: undefined,
      GROK_BOT_AGENT_DATA: '/tmp/agent-data-does-not-need-to-exist',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.agentIdsAuto).toBe(true);
    expect(cfg.fallback).toBe('house');
    expect(cfg.window).toBe(80);
    expect(cfg.tier).toBe('episode');
  });

  it('can be turned off without touching Claude Code hooks', () => {
    const settingsPath = path.join(tempRoot(), 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: 'false' }));
    const cfg = loadGrokBotIndexConfig(settingsPath, {
      ...process.env,
      CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: 'false',
    });
    expect(cfg.enabled).toBe(false);
  });
});

describe('renderIndexFile', () => {
  it('does not churn the fact block when only the HTML comment would change', () => {
    const lines = formatIndexFactLines([obs(1, 'Same', 1)], {
      primaryProject: 'cmem_work_prioritizer',
      now: NOW,
    });
    const a = renderIndexFile(lines);
    const b = a.replace('Growing observation timeline', 'Different comment');
    expect(shouldRewriteInject(a, b)).toBe(false);
  });
});
