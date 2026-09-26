import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
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
import { queryObservationsNewest } from '../../src/services/context/ObservationCompiler.js';
import type { ContextConfig } from '../../src/services/context/types.js';
import {
  checkGrokBotIndexSettings,
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
    standingLine: '',
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
  it('lists seat rows first, then fills from house rows without duplicating IDs', () => {
    const seat = [obs(5, 'Seat stale', 1_000, 'cmem_work_prioritizer')];
    const house = [
      obs(80, 'House newest', 8_000, 'claude-mem'),
      obs(79, 'House previous', 7_900, 'worker'),
      obs(5, 'Seat stale', 1_000, 'cmem_work_prioritizer'),
    ];
    const merged = mergeIndexObservations(seat, house, 80);
    expect(merged.map(row => row.id)).toEqual([5, 80, 79]);
    expect(merged[0].title).toBe('Seat stale');
  });

  it('keeps seat rows ahead of newer house rows, each list newest first', () => {
    const seat = [obs(2, 'Seat older', 100), obs(3, 'Seat newer', 200)];
    const house = [obs(90, 'House a', 9_000, 'claude-mem'), obs(91, 'House b', 9_100, 'claude-mem')];
    const merged = mergeIndexObservations(seat, house, 80);
    expect(merged.map(row => row.id)).toEqual([3, 2, 91, 90]);
  });

  it('seat rows that reach the window leave no room for house rows', () => {
    const seat = Array.from({ length: 80 }, (_, i) => obs(i + 1, `Seat ${i + 1}`, i + 1));
    const house = Array.from({ length: 50 }, (_, i) => obs(1_000 + i, `House ${i}`, 100_000 + i, 'claude-mem'));
    const merged = mergeIndexObservations(seat, house, 80);
    expect(merged).toHaveLength(80);
    expect(merged.every(row => row.id <= 80)).toBe(true);
    expect(merged[0].id).toBe(80);
    expect(merged[merged.length - 1].id).toBe(1);
  });

  it('caps the seat itself at the window, dropping its oldest rows', () => {
    const seat = Array.from({ length: 100 }, (_, i) => obs(i + 1, `Seat ${i + 1}`, i + 1));
    const merged = mergeIndexObservations(seat, [obs(999, 'House', 999_999, 'claude-mem')], 80);
    expect(merged).toHaveLength(80);
    expect(merged[0].id).toBe(100);
    expect(merged[merged.length - 1].id).toBe(21);
    expect(merged.some(row => row.id === 999)).toBe(false);
  });

  it('house rows fill only the slots the seat leaves open', () => {
    const seat = Array.from({ length: 78 }, (_, i) => obs(i + 1, `Seat ${i + 1}`, i + 1));
    const house = [
      obs(78, 'Seat 78', 78),
      ...Array.from({ length: 5 }, (_, i) => obs(500 + i, `House ${i}`, 50_000 + i, 'claude-mem')),
    ];
    const merged = mergeIndexObservations(seat, house, 80);
    expect(merged).toHaveLength(80);
    expect(new Set(merged.map(row => row.id)).size).toBe(80);
    expect(merged.slice(78).map(row => row.id)).toEqual([504, 503]);
  });

  it('dedupes rows repeated inside the seat list', () => {
    const merged = mergeIndexObservations([obs(7, 'A', 7), obs(7, 'A', 7)], [obs(7, 'A', 7)], 80);
    expect(merged.map(row => row.id)).toEqual([7]);
  });

  it('slides off the oldest rows past the window', () => {
    const house = Array.from({ length: 120 }, (_, i) => obs(i + 1, `Row ${i + 1}`, i + 1, 'house'));
    const merged = mergeIndexObservations([], house, 80);
    expect(merged).toHaveLength(80);
    expect(merged[0].id).toBe(120);
    expect(merged[merged.length - 1].id).toBe(41);
  });
});

describe('queryObservationsNewest manual saves', () => {
  function seedDb(): Database {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE sdk_sessions (memory_session_id TEXT, platform_source TEXT)`);
    db.run(`CREATE TABLE observations (
      id INTEGER PRIMARY KEY, memory_session_id TEXT, type TEXT, title TEXT, subtitle TEXT,
      narrative TEXT, facts TEXT, concepts TEXT, files_read TEXT, files_modified TEXT,
      discovery_tokens INTEGER, created_at TEXT, created_at_epoch INTEGER, project TEXT,
      merged_into_project TEXT)`);
    db.run(`INSERT INTO sdk_sessions VALUES ('manual-seat', 'claude'), ('sdk-1', 'claude')`);
    const insert = db.prepare(`INSERT INTO observations
      (id, memory_session_id, type, title, concepts, created_at, created_at_epoch, project)
      VALUES (?, ?, ?, ?, ?, '', ?, ?)`);
    insert.run(1, 'sdk-1', 'discovery', 'Tagged', '["how-it-works"]', 1, 'seat');
    insert.run(2, 'manual-seat', 'discovery', 'Grok seat save', '[]', 2, 'seat');
    insert.run(3, 'sdk-1', 'discovery', 'Untagged sdk row', '[]', 3, 'seat');
    return db;
  }
  const config = {
    observationTypes: new Set(['discovery']),
    observationConcepts: new Set(['how-it-works']),
  } as unknown as ContextConfig;

  it('includes /api/memory/save rows for the seat project when asked', () => {
    const db = seedDb();
    const rows = queryObservationsNewest({ db }, config, { limit: 10, projects: ['seat'], includeManualSaves: true });
    expect(rows.map(row => row.id)).toEqual([2, 1]);
    db.close();
  });

  it('keeps the strict mode filter by default', () => {
    const db = seedDb();
    const rows = queryObservationsNewest({ db }, config, { limit: 10, projects: ['seat'] });
    expect(rows.map(row => row.id)).toEqual([1]);
    db.close();
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

  it('pins an optional standing line above the header as a host fact', () => {
    const rows = [obs(17401, 'Grew the inject allowlist', Date.parse('2026-09-16T14:03:00Z'))];
    const standing = 'Before ending a turn,   run the\n self-save skill.';
    const lines = formatIndexFactLines(rows, {
      primaryProject: 'cmem_work_prioritizer',
      now: NOW,
      standingLine: standing,
    });
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('- (2026-09-16) [episode] [claude-mem] Before ending a turn, run the self-save skill.');
    expect(HOST_MEMORY_FACT_LINE.test(lines[0])).toBe(true);
    expect(lines[1]).toContain('Claude-Mem timeline index for cmem_work_prioritizer');
  });

  it('caps a long standing line under the host fact limit', () => {
    const lines = formatIndexFactLines([], {
      primaryProject: 'p',
      now: NOW,
      standingLine: 'x'.repeat(2000),
    });
    expect(lines[0].length).toBeLessThan(HOST_MAX_FACT_CHARS);
    expect(lines[0].endsWith('…')).toBe(true);
    expect(HOST_MEMORY_FACT_LINE.test(lines[0])).toBe(true);
  });

  it('emits identical output when the standing line is empty or blank', () => {
    const rows = [obs(1, 'Same', 1)];
    const base = formatIndexFactLines(rows, { primaryProject: 'p', now: NOW });
    expect(formatIndexFactLines(rows, { primaryProject: 'p', now: NOW, standingLine: '' })).toEqual(base);
    expect(formatIndexFactLines(rows, { primaryProject: 'p', now: NOW, standingLine: '  \n ' })).toEqual(base);
    expect(base[0]).toContain('Claude-Mem timeline index');
  });

  it('rewrites the inject when the standing line is added, changed or removed', () => {
    const rows = [obs(1, 'Same', 1)];
    const render = (standingLine?: string) =>
      renderIndexFile(formatIndexFactLines(rows, { primaryProject: 'p', now: NOW, standingLine }));
    const none = render();
    const a = render('Use the self-save skill.');
    const b = render('Use the self-save skill v2.');
    expect(shouldRewriteInject(none, a)).toBe(true);
    expect(shouldRewriteInject(a, b)).toBe(true);
    expect(shouldRewriteInject(b, none)).toBe(true);
    expect(shouldRewriteInject(a, render('Use the self-save skill.'))).toBe(false);
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

  it('reports houseFilled false when seat rows fill the whole window', () => {
    const root = tempRoot();
    writeSeat(root, PRIORITIZER, 'Prioritizer');
    const seatRows = Array.from({ length: 80 }, (_, i) => obs(i + 1, `Seat ${i + 1}`, i + 1));
    const result = refreshSeatIndex(
      makeCfg(root),
      { id: PRIORITIZER, name: 'Prioritizer', projects: ['cmem_work_prioritizer'] },
      queries(seatRows, [obs(900, 'Busy house', 900_000, 'claude-mem')]),
      NOW,
    );
    expect(result.status).toBe('written');
    expect(result.houseFilled).toBe(false);
    const text = readFileSync(result.filePath!, 'utf8');
    expect(text).not.toContain('Busy house');
    expect(text).not.toContain('house fill');
  });

  it('skips the house query entirely when seat rows fill the window', () => {
    const root = tempRoot();
    writeSeat(root, PRIORITIZER, 'Prioritizer');
    const seatRows = Array.from({ length: 80 }, (_, i) => obs(i + 1, `Seat ${i + 1}`, i + 1));
    let houseCalls = 0;
    const result = refreshSeatIndex(
      makeCfg(root),
      { id: PRIORITIZER, name: 'Prioritizer', projects: ['cmem_work_prioritizer'] },
      {
        querySeat: () => seatRows,
        queryHouse: () => {
          houseCalls += 1;
          throw new Error('house query must not run');
        },
      },
      NOW,
    );
    expect(houseCalls).toBe(0);
    expect(result.status).toBe('written');
    expect(result.houseFilled).toBe(false);
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

describe('checkGrokBotIndexSettings', () => {
  it('flags standing line and project map edits so idle seats refresh', () => {
    const settingsPath = path.join(tempRoot(), 'settings.json');
    const write = (extra: Record<string, string>) => writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: 'false',
      ...extra,
    }));
    write({});
    expect(checkGrokBotIndexSettings(settingsPath)).toBe(false); // first read only records
    expect(checkGrokBotIndexSettings(settingsPath)).toBe(false);
    write({ CLAUDE_MEM_GROK_BOT_INJECT_STANDING_LINE: 'Use the self-save skill.' });
    expect(checkGrokBotIndexSettings(settingsPath)).toBe(true);
    expect(checkGrokBotIndexSettings(settingsPath)).toBe(false);
    write({
      CLAUDE_MEM_GROK_BOT_INJECT_STANDING_LINE: 'Use the self-save skill.',
      CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT: `${ORIFICE}=Orifice`,
    });
    expect(checkGrokBotIndexSettings(settingsPath)).toBe(true);
    write({ CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT: `${ORIFICE}=Orifice` });
    expect(checkGrokBotIndexSettings(settingsPath)).toBe(true); // cleared line
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
    expect(cfg.standingLine).toBe('');
  });

  it('loads the standing line trimmed with whitespace collapsed', () => {
    const settingsPath = path.join(tempRoot(), 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_GROK_BOT_INJECT_STANDING_LINE: '  Run   the\nself-save skill.  ',
    }));
    const cfg = loadGrokBotIndexConfig(settingsPath, {
      ...process.env,
      CLAUDE_MEM_GROK_BOT_INJECT_STANDING_LINE: undefined,
      GROK_BOT_AGENT_DATA: '/tmp/agent-data-does-not-need-to-exist',
    });
    expect(cfg.standingLine).toBe('Run the self-save skill.');
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
