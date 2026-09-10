import { describe, it, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  injectTextToFactLines,
  injectLogPath,
  timelineBucketPath,
  privateBucketPath,
  seatBucketDir,
  loadConfig,
  slugGrokBotProject,
  listLiveAgents,
  ensureWatchesForLiveAgents,
  resolveAgentIds,
  projectsForAgent,
  parseTimelineRows,
  slideWindow,
  shouldRewriteInject,
  writeFileIfChanged,
  factBlock,
  bucketRowPayload,
  assertSafeInjectPath,
  assertSafeBucketPath,
  resolveIndexWindow,
  refreshAgent,
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
const ORIFICE = '95601360-61f7-4fd9-bb3a-2c976b2b85c0';
const BIFF = '1e5a61c5-5e1e-4ba6-862f-cd831dac62e9';
const GONE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

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

describe('resolveIndexWindow', () => {
  it('defaults to the Phase 1 rich-index window, not the #3953 pointer', () => {
    expect(resolveIndexWindow(undefined, undefined)).toBe(80);
    expect(resolveIndexWindow('', 2)).toBe(80);
    expect(resolveIndexWindow(undefined, 2)).toBe(80);
  });

  it('honors an explicit WINDOW and clamps to 100', () => {
    expect(resolveIndexWindow(50, 2)).toBe(50);
    expect(resolveIndexWindow(100, 2)).toBe(100);
    expect(resolveIndexWindow(400, 2)).toBe(100);
    expect(resolveIndexWindow(undefined, 60)).toBe(60);
  });
});

describe('injectTextToFactLines', () => {
  const options = {
    projects: ['cmem_work_orifice'],
    window: 80,
    maxLineChars: 160,
    tier: 'episode',
    now: NOW,
  };

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

  it('is a rich index: one observation per line, not a packed 2-line pointer', () => {
    const lines = injectTextToFactLines(sampleInject(20), options);
    expect(lines.length).toBe(21); // header + 20 rows
    const indexRows = lines.slice(1);
    expect(indexRows.some(line => line.includes(' | '))).toBe(false);
    expect(indexRows.filter(line => /170\d{2}/.test(line)).length).toBe(20);
  });

  it('never exceeds the configured slide-off window', () => {
    const lines = injectTextToFactLines(sampleInject(400), options);
    expect(lines.length).toBeLessThanOrEqual(options.window + 1);
    expect(lines[0].length).toBeLessThanOrEqual(HOST_MAX_CONTENT_LENGTH);
    for (const line of lines.slice(1)) {
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

  it('keeps the newest rows when it has to slide off', () => {
    const lines = injectTextToFactLines(sampleInject(400), options).join('\n');
    expect(lines).toContain('observation number 399');
    expect(lines).toContain('17399');
    expect(lines).not.toContain('observation number 0 ');
    expect(lines).toContain('older in bucket');
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

  it('does not churn the fact block when only the inject fetch clock changes', () => {
    const a = injectTextToFactLines(sampleInject(5).replace('3:41am UTC', '3:42am UTC'), options);
    const b = injectTextToFactLines(sampleInject(5).replace('3:41am UTC', '4:01am UTC'), options);
    expect(factBlock(a.join('\n'))).toBe(factBlock(b.join('\n')));
  });
});

describe('row grammar and slide-off window', () => {
  it('parses observation IDs from inject / bucket markdown', () => {
    const rows = parseTimelineRows(sampleInject(3));
    expect(rows.map(row => row.id)).toEqual(['17000', '17001', '17002']);
    expect(rows[0].raw).toContain('17000');
    expect(rows[0].raw).toContain('observation number 0');
  });

  it('keeps summary IDs too', () => {
    const rows = parseTimelineRows('S10489 Session started (Sep 10, 2026)\n17001 1:18p ○ hello');
    expect(rows.map(row => row.id)).toEqual(['S10489', '17001']);
  });

  it('ignores legend, day headers, and the CCS bucket title', () => {
    const rows = parseTimelineRows([
      '# Timeline bucket',
      '<!-- comment -->',
      'Legend: 🎯session',
      '### Sep 10, 2026',
      '17099 1:18p ○ keep me',
    ].join('\n'));
    expect(rows).toEqual([{ id: '17099', raw: '17099 1:18p ○ keep me' }]);
  });

  it('slides off oldest rows and reports how many dropped', () => {
    const rows = parseTimelineRows(sampleInject(120));
    const { kept, omitted } = slideWindow(rows, 80);
    expect(kept).toHaveLength(80);
    expect(omitted).toBe(40);
    expect(kept[0].id).toBe('17119');
    expect(kept[kept.length - 1].id).toBe('17040');
    expect(kept.some(row => row.id === '17000')).toBe(false);
  });

  it('puts the observation ID on every compiled index row so deep fetch works', () => {
    const lines = injectTextToFactLines(sampleInject(12), {
      projects: ['cmem_work_orifice'],
      window: 80,
      maxLineChars: 160,
      now: NOW,
    });
    const indexRows = lines.slice(1);
    expect(indexRows).toHaveLength(12);
    for (const line of indexRows) {
      const id = /\[claude-mem\] (\d+) /.exec(line)?.[1];
      expect(id).toBeTruthy();
      expect(HOST_MEMORY_FACT_LINE.test(line)).toBe(true);
    }
    expect(lines[0]).toContain('get_observations by ID');
  });
});

describe('mtime-stable rewrite', () => {
  it('shouldRewriteInject ignores header comments and compares the fact block', () => {
    const facts = injectTextToFactLines(sampleInject(4), {
      projects: ['cmem_work_orifice'],
      window: 80,
      maxLineChars: 160,
      now: NOW,
    }).join('\n');
    const a = `# Memory log\n\n<!-- first fetch -->\n\n${facts}\n`;
    const b = `# Memory log\n\n<!-- later fetch, different comment -->\n\n${facts}\n`;
    expect(shouldRewriteInject(a, b)).toBe(false);
    expect(shouldRewriteInject(a, `${a}\n- (2026-09-10) [episode] [claude-mem] 99999 1:00p ○ new\n`)).toBe(true);
  });

  it('writeFileIfChanged does not bump mtime when bytes are unchanged', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'grok-inject-mtime-'));
    try {
      const file = path.join(dir, 'timeline.md');
      writeFileSync(file, 'same-bytes\n');
      const before = statSync(file).mtimeMs;
      const first = writeFileIfChanged(file, 'same-bytes\n');
      expect(first.changed).toBe(false);
      expect(statSync(file).mtimeMs).toBe(before);

      const second = writeFileIfChanged(file, 'different-bytes\n');
      expect(second.changed).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('different-bytes\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refreshAgent is mtime-stable across identical inject payloads', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'grok-inject-refresh-'));
    try {
      writeSeat(root, ORIFICE, 'Orifice');
      writeFileSync(path.join(root, 'transcript-watch.json'), JSON.stringify({
        watches: [{ name: 'grok-bot', agentId: ORIFICE, project: 'cmem_work_orifice' }],
      }));
      const body = sampleInject(8);
      const cfg = {
        agentIdsAuto: false,
        agentIds: [ORIFICE],
        agentDataRoot: root,
        ccsRoot: path.join(root, 'ccs'),
        watchConfigFile: path.join(root, 'transcript-watch.json'),
        projectsByAgent: new Map(),
        window: 80,
        maxLineChars: 160,
        tier: 'episode',
        stateFile: path.join(root, 'state.json'),
      };

      const fetchInjectFn = async () => ({ url: 'http://127.0.0.1:37700/api/context/inject?projects=cmem_work_orifice', body });
      const first = await refreshAgent(cfg, ORIFICE, { fetchInjectFn });
      expect(first.status).toBe('written');
      expect(first.factLines).toBe(9);

      const injectPath = first.filePath as string;
      const bucketPath = first.bucketPath as string;
      const injectMtime = statSync(injectPath).mtimeMs;
      const bucketMtime = statSync(bucketPath).mtimeMs;

      const second = await refreshAgent(cfg, ORIFICE, { fetchInjectFn });
      expect(second.status).toBe('unchanged');
      expect(statSync(injectPath).mtimeMs).toBe(injectMtime);
      expect(statSync(bucketPath).mtimeMs).toBe(bucketMtime);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('compiles a user-edited bucket without overwriting it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'grok-inject-user-'));
    try {
      writeSeat(root, ORIFICE, 'Orifice');
      writeFileSync(path.join(root, 'transcript-watch.json'), JSON.stringify({
        watches: [{ name: 'grok-bot', agentId: ORIFICE, project: 'cmem_work_orifice' }],
      }));
      const cfg = {
        agentIdsAuto: false,
        agentIds: [ORIFICE],
        agentDataRoot: root,
        ccsRoot: path.join(root, 'ccs'),
        watchConfigFile: path.join(root, 'transcript-watch.json'),
        projectsByAgent: new Map(),
        window: 80,
        maxLineChars: 160,
        tier: 'episode',
        stateFile: path.join(root, 'state.json'),
      };

      await refreshAgent(cfg, ORIFICE, {
        fetchInjectFn: async () => ({ url: 'http://inject', body: sampleInject(3) }),
      });

      const bucketPath = timelineBucketPath(cfg.ccsRoot, ORIFICE);
      const edited = `${readFileSync(bucketPath, 'utf8').trim()}\n18888 2:00p ○ user edited row\n`;
      writeFileSync(bucketPath, edited);

      let fetched = 0;
      const result = await refreshAgent(cfg, ORIFICE, {
        fetchInjectFn: async () => {
          fetched += 1;
          return { url: 'http://inject', body: sampleInject(3) };
        },
      });
      expect(fetched).toBe(0);
      expect(result.bucketStatus).toBe('user-edited');
      expect(readFileSync(bucketPath, 'utf8')).toBe(edited);
      expect(readFileSync(result.filePath as string, 'utf8')).toContain('18888');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats identical observation rows as an unchanged bucket payload even if the fetch clock moved', () => {
    const a = sampleInject(4);
    const b = a.replace('3:41am UTC', '9:00pm UTC');
    expect(bucketRowPayload(a)).toBe(bucketRowPayload(b));
  });

  it('writes TIMELINE.md under ccs/seats/<id> and never touches PRIVATE.md', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'grok-inject-layout-'));
    try {
      writeSeat(root, ORIFICE, 'Orifice');
      writeFileSync(path.join(root, 'transcript-watch.json'), JSON.stringify({
        watches: [{ name: 'grok-bot', agentId: ORIFICE, project: 'cmem_work_orifice' }],
      }));
      const ccsRoot = path.join(root, 'ccs');
      const privatePath = privateBucketPath(ccsRoot, ORIFICE);
      mkdirSync(path.dirname(privatePath), { recursive: true });
      writeFileSync(privatePath, '# keep me\n');

      const result = await refreshAgent({
        agentIdsAuto: false,
        agentIds: [ORIFICE],
        agentDataRoot: root,
        ccsRoot,
        watchConfigFile: path.join(root, 'transcript-watch.json'),
        projectsByAgent: new Map(),
        window: 80,
        maxLineChars: 160,
        tier: 'episode',
        stateFile: path.join(root, 'state.json'),
      }, ORIFICE, {
        fetchInjectFn: async () => ({ url: 'http://inject', body: sampleInject(3) }),
      });

      expect(result.bucketPath).toBe(`${ccsRoot}/seats/${ORIFICE}/TIMELINE.md`);
      expect(existsSync(result.bucketPath as string)).toBe(true);
      expect(readFileSync(privatePath, 'utf8')).toBe('# keep me\n');
      expect(existsSync(path.join(ccsRoot, 'house'))).toBe(false);
      expect(existsSync(path.join(ccsRoot, 'groups'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('path guards', () => {
  const root = '/home/box/agent-data';
  const ccs = path.join(root, 'ccs');

  it('targets the agent log folder and never profile.md', () => {
    const filePath = injectLogPath(root, ORIFICE);
    expect(filePath).toBe(
      `/home/box/agent-data/agents/${ORIFICE}/memory/log/zz-claude-mem-inject.md`,
    );
    expect(filePath.endsWith('profile.md')).toBe(false);
  });

  it('uses a filename the host never writes itself (host owns YYYY-MM.md)', () => {
    const filePath = injectLogPath('/root', ORIFICE);
    expect(/\d{4}-\d{2}\.md$/.test(filePath)).toBe(false);
  });

  it('refuses inject writes to profile.md and anything outside memory/log', () => {
    expect(() => assertSafeInjectPath(root, ORIFICE, path.join(root, 'agents', ORIFICE, 'memory', 'log', 'profile.md')))
      .toThrow(/profile\.md/);
    expect(() => assertSafeInjectPath(root, ORIFICE, path.join(root, 'agents', ORIFICE, 'profile.md')))
      .toThrow(/outside agent memory\/log|profile\.md/);
    expect(() => assertSafeInjectPath(root, ORIFICE, path.join(root, 'agents', ORIFICE, 'memory', 'log', '2026-09.md')))
      .toThrow(/does not own/);
  });

  it('places the editable bucket at ccs/seats/<seat-id>/TIMELINE.md', () => {
    const bucket = timelineBucketPath(ccs, ORIFICE);
    expect(bucket).toBe(`${ccs}/seats/${ORIFICE}/TIMELINE.md`);
    expect(seatBucketDir(ccs, ORIFICE)).toBe(`${ccs}/seats/${ORIFICE}`);
    expect(privateBucketPath(ccs, ORIFICE)).toBe(`${ccs}/seats/${ORIFICE}/PRIVATE.md`);
    expect(bucket.endsWith('profile.md')).toBe(false);
    expect(bucket.endsWith('PRIVATE.md')).toBe(false);
  });

  it('defaults CCS under the agent-data tree (bots can edit TIMELINE.md)', () => {
    const cfg = loadConfig({ GROK_BOT_AGENT_DATA: root });
    expect(cfg.ccsRoot).toBe(path.join(root, 'ccs'));
    expect(timelineBucketPath(cfg.ccsRoot, ORIFICE)).toBe(
      `${root}/ccs/seats/${ORIFICE}/TIMELINE.md`,
    );
  });

  it('refuses bucket writes to profile.md, PRIVATE.md, house/, groups/, or another seat', () => {
    expect(() => assertSafeBucketPath(ccs, ORIFICE, path.join(ccs, 'seats', ORIFICE, 'profile.md')))
      .toThrow(/profile\.md/);
    expect(() => assertSafeBucketPath(ccs, ORIFICE, path.join(ccs, 'seats', ORIFICE, 'PRIVATE.md')))
      .toThrow(/PRIVATE\.md/);
    expect(() => assertSafeBucketPath(ccs, ORIFICE, path.join(ccs, 'house', 'TIMELINE.md')))
      .toThrow(/outside CCS L1 seat folder|house/);
    expect(() => assertSafeBucketPath(ccs, ORIFICE, path.join(ccs, 'groups', 'TIMELINE.md')))
      .toThrow(/outside CCS L1 seat folder|groups/);
    expect(() => assertSafeBucketPath(ccs, ORIFICE, path.join(ccs, 'seats', BIFF, 'TIMELINE.md')))
      .toThrow(/outside CCS L1 seat folder/);
    expect(() => assertSafeBucketPath(ccs, ORIFICE, path.join(ccs, 'seats', ORIFICE, '..', BIFF, 'TIMELINE.md')))
      .toThrow(/outside CCS L1 seat folder/);
    expect(() => assertSafeInjectPath(root, ORIFICE, path.join(root, 'agents', ORIFICE, 'memory', 'log', '..', 'profile.md')))
      .toThrow(/profile\.md|outside/);
  });

  it('refuses non-UUID agent ids so a path cannot escape the seat folder', () => {
    expect(() => injectLogPath(root, '../etc')).toThrow(/non-UUID/);
    expect(() => timelineBucketPath(ccs, '*')).toThrow(/non-UUID/);
  });
});

describe('loadConfig defaults', () => {
  it('prefers the Orifice / Grok Memory allowlist; * / all are infra, not the product', () => {
    const listed = loadConfig({ CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: `${ORIFICE}` });
    expect(listed.agentIdsAuto).toBe(false);
    expect(listed.agentIds).toEqual([ORIFICE]);
    expect(listed.window).toBe(80);

    expect(loadConfig({ CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: '*' }).agentIdsAuto).toBe(true);
    expect(loadConfig({ CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: '*' }).agentIds).toEqual([]);
    expect(loadConfig({ CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: 'all' }).agentIdsAuto).toBe(true);
    expect(loadConfig({ CLAUDE_MEM_GROK_BOT_INJECT_AGENT_IDS: 'ALL' }).agentIdsAuto).toBe(true);
  });

  it('does not let a leftover MAX_LINES=2 pin the compiler to the thin pointer', () => {
    expect(loadConfig({ CLAUDE_MEM_GROK_BOT_INJECT_MAX_LINES: '2' }).window).toBe(80);
    expect(loadConfig({ CLAUDE_MEM_GROK_BOT_INJECT_WINDOW: '50' }).window).toBe(50);
  });
});

describe('AGENT_IDS=* / all', () => {
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
