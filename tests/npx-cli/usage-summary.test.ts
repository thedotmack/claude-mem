import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildUsageSummary,
  formatTokenCount,
  formatUsageSummaryLines,
  readUsageSummary,
  usageWindowStartMs,
  USAGE_WINDOW_DAYS,
} from '../../src/npx-cli/install/usage-summary.js';
import {
  buildInstallerOAuthStartBody,
  setInstallerSignupContext,
  startInstallerOAuthPairing,
} from '../../src/npx-cli/commands/install.js';

const DAY = 86_400_000;
// 2026-09-28T15:30:00Z
const NOW = Date.parse('2026-09-28T15:30:00Z');

describe('buildUsageSummary (pure)', () => {
  it('returns an all-zero summary for no rows or garbage input', () => {
    const empty = { window_days: 28, active_days: 0, observations: 0, memory_tokens: 0, days: [] };
    expect(buildUsageSummary([], NOW)).toEqual(empty);
    expect(buildUsageSummary(null, NOW)).toEqual(empty);
    expect(buildUsageSummary('nope', NOW)).toEqual(empty);
  });

  it('keeps exactly the 28 UTC days ending today', () => {
    expect(new Date(usageWindowStartMs(NOW)).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    const s = buildUsageSummary([
      { d: '2026-08-31', obs: 5, tokens: 50 }, // one day before the window
      { d: '2026-09-01', obs: 1, tokens: 10 }, // first day
      { d: '2026-09-28', obs: 2, tokens: 20 }, // today
      { d: '2026-09-29', obs: 9, tokens: 90 }, // future
    ], NOW);
    expect(s.days.map((d) => d.d)).toEqual(['2026-09-01', '2026-09-28']);
    expect(s).toMatchObject({ active_days: 2, observations: 3, memory_tokens: 30 });
  });

  it('merges duplicate dates, sorts ascending, and totals', () => {
    const s = buildUsageSummary([
      { d: '2026-09-20', obs: 3, tokens: 300 },
      { d: '2026-09-10', obs: 1, tokens: null },
      { d: '2026-09-20', obs: 2, tokens: '200' },
    ], NOW);
    expect(s.days).toEqual([
      { d: '2026-09-10', obs: 1, tokens: 0 },
      { d: '2026-09-20', obs: 5, tokens: 500 },
    ]);
    expect(s).toMatchObject({ active_days: 2, observations: 6, memory_tokens: 500 });
  });

  it('drops invalid rows and floors fractional counts', () => {
    const s = buildUsageSummary([
      { d: '2026-02-30', obs: 1, tokens: 1 },   // not a real date
      { d: '2026/09/10', obs: 1, tokens: 1 },   // wrong format
      { d: 20260910, obs: 1, tokens: 1 },       // not a string
      { d: '2026-09-11', obs: -1, tokens: 1 },  // negative
      { d: '2026-09-12', obs: 'x', tokens: 1 }, // non-numeric
      { d: '2026-09-13', obs: 1, tokens: Infinity },
      { d: '2026-09-14', obs: 0, tokens: 5 },   // not an active day
      null,
      'row',
      { d: '2026-09-15', obs: 2.9, tokens: 10.7 },
    ], NOW);
    expect(s.days).toEqual([{ d: '2026-09-15', obs: 2, tokens: 10 }]);
  });

  it('never lists more than 28 days', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      d: new Date(NOW - i * DAY).toISOString().slice(0, 10),
      obs: 1,
      tokens: 1,
    }));
    const s = buildUsageSummary(rows, NOW);
    expect(s.days).toHaveLength(USAGE_WINDOW_DAYS);
    expect(s.active_days).toBe(28);
    expect(new Set(s.days.map((d) => d.d)).size).toBe(28);
    expect(s.days[0].d).toBe('2026-09-01');
  });
});

describe('readUsageSummary (bun child, read-only)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeDb(schema: 'current' | 'no-tokens' | 'empty-file'): string {
    const dir = mkdtempSync(join(tmpdir(), 'cmem-usage-summary-'));
    dirs.push(dir);
    const path = join(dir, 'claude-mem.db');
    const db = new Database(path);
    if (schema !== 'empty-file') {
      db.run(`CREATE TABLE observations (
        id INTEGER PRIMARY KEY, project TEXT NOT NULL, text TEXT NOT NULL,
        created_at TEXT NOT NULL, created_at_epoch INTEGER NOT NULL
        ${schema === 'current' ? ', discovery_tokens INTEGER DEFAULT 0' : ''})`);
    }
    db.close();
    return path;
  }

  function insert(path: string, rows: Array<[number, number | null]>): void {
    const db = new Database(path);
    const hasTokens = db.query('PRAGMA table_info(observations)').all()
      .some((c) => (c as { name: string }).name === 'discovery_tokens');
    for (const [epoch, tokens] of rows) {
      if (hasTokens) {
        db.run(
          'INSERT INTO observations (project, text, created_at, created_at_epoch, discovery_tokens) VALUES (?, ?, ?, ?, ?)',
          ['secret-project', 'secret text', 'x', epoch, tokens],
        );
      } else {
        db.run('INSERT INTO observations (project, text, created_at, created_at_epoch) VALUES (?, ?, ?, ?)',
          ['secret-project', 'secret text', 'x', epoch]);
      }
    }
    db.close();
  }

  const read = (dbPath: string) => readUsageSummary({ dbPath, bunPath: process.execPath, nowMs: NOW });

  it('returns null when the DB or bun is missing', async () => {
    expect(await readUsageSummary({ dbPath: '/nonexistent/claude-mem.db', bunPath: process.execPath, nowMs: NOW })).toBeNull();
    const path = makeDb('current');
    expect(await readUsageSummary({ dbPath: path, bunPath: null, nowMs: NOW })).toBeNull();
  });

  it('returns null when the observations table does not exist', async () => {
    expect(await read(makeDb('empty-file'))).toBeNull();
  });

  it('returns an all-zero summary for an empty observations table', async () => {
    expect(await read(makeDb('current'))).toEqual({
      window_days: 28, active_days: 0, observations: 0, memory_tokens: 0, days: [],
    });
  });

  it('aggregates per UTC day across seconds and ms epochs, window edges included', async () => {
    const path = makeDb('current');
    const start = usageWindowStartMs(NOW);
    insert(path, [
      [start - 1, 999],                                // just before the window
      [start, 100],                                    // first ms of the window
      [Math.floor((start + 3600_000) / 1000), 50],     // legacy seconds epoch, same day
      [NOW, 7],                                        // today
      [NOW - 2 * DAY, null],                           // null tokens count as 0
      [NOW + 2 * DAY, 1_000],                          // future row excluded
    ]);
    const s = await read(path);
    expect(s).toEqual({
      window_days: 28,
      active_days: 3,
      observations: 4,
      memory_tokens: 157,
      days: [
        { d: '2026-09-01', obs: 2, tokens: 150 },
        { d: '2026-09-26', obs: 1, tokens: 0 },
        { d: '2026-09-28', obs: 1, tokens: 7 },
      ],
    });
    // Numbers only: nothing from the rows' text columns leaks into the payload.
    expect(JSON.stringify(s)).not.toContain('secret');
  });

  it('counts observations when the schema predates discovery_tokens', async () => {
    const path = makeDb('no-tokens');
    insert(path, [[NOW, null], [NOW - DAY, null]]);
    expect(await read(path)).toMatchObject({ active_days: 2, observations: 2, memory_tokens: 0 });
  });
});

describe('installer output and wire body', () => {
  it('formats the local block only when there are observations', () => {
    expect(formatUsageSummaryLines(null)).toEqual([]);
    expect(formatUsageSummaryLines(buildUsageSummary([], NOW))).toEqual([]);
    const lines = formatUsageSummaryLines(buildUsageSummary([
      { d: '2026-09-27', obs: 1200, tokens: 3_400_000 },
      { d: '2026-09-28', obs: 34, tokens: 800_000 },
    ], NOW));
    expect(lines).toEqual([
      'Your memory so far (last 28 days): 1,234 observations across 2 active days, 4.2M memory tokens.',
    ]);
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(12_345)).toBe('12K');
    expect(formatTokenCount(2_000_000_000)).toBe('2B');
  });

  it('adds install_state and usage_summary only when known', () => {
    expect(buildInstallerOAuthStartBody('npx-installer', 'host')).toEqual({
      source: 'npx-installer', device_name: 'host',
    });
    const summary = buildUsageSummary([{ d: '2026-09-28', obs: 1, tokens: 2 }], NOW);
    expect(buildInstallerOAuthStartBody('npx-installer', 'host', { installState: 'update', usageSummary: summary }))
      .toEqual({ source: 'npx-installer', device_name: 'host', install_state: 'update', usage_summary: summary });
    expect(buildInstallerOAuthStartBody('npx-installer', 'host', { installState: 'fresh', usageSummary: null }))
      .toEqual({ source: 'npx-installer', device_name: 'host', install_state: 'fresh' });
  });

  it('sends the install context set by the install command in the start request', async () => {
    const realFetch = globalThis.fetch;
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response('', { status: 503 });
    }) as typeof fetch;
    try {
      const summary = buildUsageSummary([{ d: '2026-09-28', obs: 3, tokens: 9 }], NOW);
      setInstallerSignupContext({ installState: 'update', usageSummary: summary });
      await startInstallerOAuthPairing();
      setInstallerSignupContext({});
      await startInstallerOAuthPairing();
    } finally {
      globalThis.fetch = realFetch;
      setInstallerSignupContext({});
    }
    const first = JSON.parse(bodies[0]);
    expect(first.install_state).toBe('update');
    expect(first.usage_summary).toMatchObject({ window_days: 28, active_days: 1, observations: 3, memory_tokens: 9 });
    expect(Object.keys(JSON.parse(bodies[1])).sort()).toEqual(['device_name', 'source']);
  });
});
