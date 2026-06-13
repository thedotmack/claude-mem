import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  postHogConstructorCalls,
  postHogCaptureCalls,
  postHogMockBehavior,
} from '../preload';
import {
  utcDayString,
  collectDailyRollups,
  findFirstActivityEpochMs,
  deterministicEventUuid,
  buildBackfillEvents,
  runHistoricalBackfill,
  PROJECT_EPOCH_FLOOR,
} from '../../src/services/telemetry/backfill';
import { scrubProperties } from '../../src/services/telemetry/scrub';
import { __resetTelemetryForTests } from '../../src/services/telemetry/telemetry';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * In-memory DB matching the runner.ts schema for every column the rollup
 * queries touch (install-stats test pattern, EXTENDED: discovery_tokens on
 * both observations and session_summaries, memory_session_id, type,
 * agent_type, status, platform_source, and the user_prompts table).
 */
function makeDb(): Database {
  const db = new Database(':memory:');
  db.run(`
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT 'claude',
      started_at_epoch INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT,
      project TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'other',
      agent_type TEXT,
      created_at_epoch INTEGER NOT NULL,
      discovery_tokens INTEGER DEFAULT 0
    );
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT,
      project TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      discovery_tokens INTEGER DEFAULT 0
    );
    CREATE TABLE user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT,
      prompt_number INTEGER,
      prompt_text TEXT,
      created_at_epoch INTEGER NOT NULL
    );
  `);
  return db;
}

type SessionRow = {
  epoch: number;
  project?: string;
  memId?: string | null;
  status?: string;
  platform?: string;
};
function insertSession(db: Database, row: SessionRow): void {
  db.prepare(
    'INSERT INTO sdk_sessions (memory_session_id, project, platform_source, started_at_epoch, status) VALUES (?, ?, ?, ?, ?)'
  ).run(row.memId ?? null, row.project ?? 'alpha', row.platform ?? 'claude', row.epoch, row.status ?? 'completed');
}

type ObsRow = {
  epoch: number;
  project?: string;
  memId?: string | null;
  type?: string;
  agentType?: string | null;
  tokens?: number;
};
function insertObs(db: Database, row: ObsRow): void {
  db.prepare(
    'INSERT INTO observations (memory_session_id, project, type, agent_type, created_at_epoch, discovery_tokens) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(row.memId ?? null, row.project ?? 'alpha', row.type ?? 'other', row.agentType ?? null, row.epoch, row.tokens ?? 0);
}

type SummaryRow = { epoch: number; project?: string; memId?: string | null; tokens?: number };
function insertSummary(db: Database, row: SummaryRow): void {
  db.prepare(
    'INSERT INTO session_summaries (memory_session_id, project, created_at_epoch, discovery_tokens) VALUES (?, ?, ?, ?)'
  ).run(row.memId ?? null, row.project ?? 'alpha', row.epoch, row.tokens ?? 0);
}

function insertPrompt(db: Database, epoch: number): void {
  db.prepare(
    'INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at_epoch) VALUES (?, ?, ?, ?)'
  ).run('cs-1', 1, '', epoch);
}

function historicalDays(events: ReturnType<typeof buildBackfillEvents>): string[] {
  return events
    .filter(e => e.event === 'historical_activity')
    .map(e => e.timestamp.toISOString().slice(0, 10));
}

/** Capture process.stderr.write output for the duration of fn. */
async function withStderrCapture(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = process.stderr.write;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = ((chunk: any) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

// Fixed "now" for the pure builders: 2026-06-12T23:00:00Z.
// lastFullDay = utcDay(NOW - 60h) = utcDay(2026-06-10T11:00Z) = 2026-06-10.
const NOW = Date.UTC(2026, 5, 12, 23, 0, 0);
const LAST_FULL_DAY = '2026-06-10';

let tempDir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'CLAUDE_MEM_DATA_DIR',
  'CLAUDE_MEM_TELEMETRY',
  'CLAUDE_MEM_TELEMETRY_DEBUG',
  'CLAUDE_MEM_TELEMETRY_KEY',
  'CLAUDE_MEM_TELEMETRY_HOST',
  'DO_NOT_TRACK',
];

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

beforeEach(() => {
  // Fresh data dir per test so marker/telemetry.json state never leaks
  // between tests — and never touches the real ~/.claude-mem.
  tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-backfill-'));
  process.env.CLAUDE_MEM_DATA_DIR = tempDir;
  process.env.CLAUDE_MEM_TELEMETRY = '1';
  delete process.env.CLAUDE_MEM_TELEMETRY_DEBUG;
  delete process.env.CLAUDE_MEM_TELEMETRY_KEY;
  delete process.env.CLAUDE_MEM_TELEMETRY_HOST;
  delete process.env.DO_NOT_TRACK;
  postHogConstructorCalls.length = 0;
  postHogCaptureCalls.length = 0;
  postHogMockBehavior.emitErrorOnShutdown = null;
  __resetTelemetryForTests();
});

afterEach(() => {
  postHogMockBehavior.emitErrorOnShutdown = null;
  rmSync(tempDir, { recursive: true, force: true });
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __resetTelemetryForTests();
});

function markerPath(): string {
  return join(tempDir, 'backfill.json');
}

function readMarker(): Record<string, unknown> {
  return JSON.parse(readFileSync(markerPath(), 'utf-8'));
}

describe('collectDailyRollups epoch normalization', () => {
  it('(a) lands mixed second/ms epochs on the correct UTC day, never 1970', () => {
    const db = makeDb();
    // Legacy seconds-unit rows: 1755000000 s = 2025-08-12T12:00:00Z.
    insertObs(db, { epoch: 1_755_000_000 });
    // Same day, written in milliseconds an hour later.
    insertObs(db, { epoch: 1_755_000_000_000 + HOUR_MS });

    const rollups = collectDailyRollups(db, LAST_FULL_DAY, '2024-01-01');

    expect(rollups.length).toBe(1);
    expect(rollups[0].day).toBe('2025-08-12');
    expect(rollups[0].counters.observation_count).toBe(2);
    for (const rollup of rollups) {
      expect(rollup.day.startsWith('1970')).toBe(false);
    }
  });
});

describe('day window (whole UTC days only)', () => {
  it('(b) excludes a 47h-old row, includes whole day buckets, drops floor/pre-install rows', () => {
    const db = makeDb();
    const memId = 's-1';
    // installDay anchor: session 10 days back -> 2026-06-02.
    insertSession(db, { epoch: NOW - 10 * DAY_MS, memId });
    // 47h-old session: 2026-06-11T00:00Z, day AFTER lastFullDay -> excluded.
    insertSession(db, { epoch: NOW - 47 * HOUR_MS, memId: 's-47h' });
    // Two sessions on lastFullDay itself: one 70h old, one only 49h old —
    // BOTH included because the whole UTC day 2026-06-10 is included
    // (day-bucket rule, not a raw 60h row cutoff -> no partial day ships).
    insertSession(db, { epoch: NOW - 70 * HOUR_MS, memId: 's-70h' });
    insertSession(db, { epoch: NOW - 49 * HOUR_MS, memId: 's-49h' });
    // Corrupt row below PROJECT_EPOCH_FLOOR -> ignored entirely.
    insertObs(db, { epoch: Date.UTC(2023, 5, 1) });
    expect(Date.UTC(2023, 5, 1)).toBeLessThan(PROJECT_EPOCH_FLOOR);
    // Backdated artifact: observation before installDay -> no day produced.
    insertObs(db, { epoch: NOW - 23 * DAY_MS });

    const events = buildBackfillEvents(db, 'install-1', NOW);
    const days = historicalDays(events);

    expect(days).toContain('2026-06-02');
    expect(days).toContain(LAST_FULL_DAY);
    expect(days).not.toContain('2026-06-11');
    for (const day of days) {
      expect(day <= LAST_FULL_DAY).toBe(true);
      expect(day >= '2026-06-02').toBe(true);
      expect(day.startsWith('1970')).toBe(false);
    }
    const lastFullDayEvent = events.find(
      e => e.event === 'historical_activity' && e.timestamp.toISOString().startsWith(LAST_FULL_DAY)
    );
    expect(lastFullDayEvent?.properties.session_count).toBe(2);
  });
});

describe('deterministicEventUuid', () => {
  it('(c) is stable across calls and shaped like a UUID', () => {
    const a = deterministicEventUuid('install-1', 'historical_activity', '2025-10-19');
    const b = deterministicEventUuid('install-1', 'historical_activity', '2025-10-19');
    expect(a).toBe(b);
    expect(a).toMatch(UUID_RE);
    // Distinct inputs produce distinct ids.
    expect(deterministicEventUuid('install-1', 'historical_activity', '2025-10-20')).not.toBe(a);
    expect(deterministicEventUuid('install-2', 'historical_activity', '2025-10-19')).not.toBe(a);
    expect(deterministicEventUuid('install-1', 'install_inferred', '2025-10-19')).not.toBe(a);
  });
});

describe('buildBackfillEvents properties', () => {
  it('(d) every built property survives scrubProperties — no silent drops', () => {
    const db = makeDb();
    const epoch = Date.UTC(2026, 0, 15, 10, 0, 0); // 2026-01-15
    insertSession(db, { epoch, memId: 's-1', status: 'completed', platform: 'claude' });
    insertSession(db, { epoch: epoch + 1000, memId: 's-2', status: 'failed', platform: 'codex' });
    insertSession(db, { epoch: epoch + 2000, memId: 's-3', status: 'completed', platform: 'gemini' });
    insertSession(db, { epoch: epoch + 3000, memId: 's-4', status: 'active', platform: 'weird-thing', project: 'beta' });
    insertObs(db, { epoch, memId: 's-1', type: 'bugfix' });
    insertObs(db, { epoch: epoch + 1000, memId: 's-1', type: 'discovery' });
    insertObs(db, { epoch: epoch + 2000, memId: 's-1', type: 'decision' });
    insertObs(db, { epoch: epoch + 3000, memId: 's-1', type: 'refactor' });
    insertObs(db, { epoch: epoch + 4000, memId: 's-1', type: 'weirdtype', agentType: 'task' });
    insertSummary(db, { epoch, memId: 's-1', tokens: 250 });
    insertPrompt(db, epoch);

    const events = buildBackfillEvents(db, 'install-1', NOW);
    expect(events.length).toBe(2);

    const activity = events.find(e => e.event === 'historical_activity');
    expect(activity).toBeDefined();
    const props = activity!.properties as Record<string, unknown>;
    const expectedCounters: Record<string, number> = {
      observation_count: 5,
      obs_type_bugfix: 1,
      obs_type_discovery: 1,
      obs_type_decision: 1,
      obs_type_refactor: 1,
      obs_type_other: 1,
      subagent_obs_count: 1,
      session_count: 4,
      session_completed_count: 2,
      session_failed_count: 1,
      sessions_claude_count: 1,
      sessions_codex_count: 1,
      sessions_gemini_count: 1,
      sessions_other_platform_count: 1,
      summary_count: 1,
      discovery_tokens: 250,
      prompt_count: 1,
      project_count: 2,
    };
    for (const [key, value] of Object.entries(expectedCounters)) {
      expect(props[key]).toBe(value);
    }
    expect(props.backfilled).toBe(true);
    expect(props.$process_person_profile).toBe(false);
    // No buildBaseProperties on historical_activity — current version/os on
    // historical days would poison version-over-time charts.
    expect(props.version).toBeUndefined();
    expect(props.os).toBeUndefined();
    // Re-scrubbing the non-$ properties changes nothing: nothing the builder
    // attached gets silently dropped by the whitelist.
    const { $process_person_profile: _directive, ...rest } = props;
    expect(scrubProperties(rest)).toEqual(rest as Record<string, string | number | boolean>);

    const install = events.find(e => e.event === 'install_inferred');
    expect(install).toBeDefined();
    const installProps = install!.properties as Record<string, unknown>;
    expect(installProps.first_active_date).toBe('2026-01-15');
    expect(installProps.backfilled).toBe(true);
    // Base props ARE expected on the one person event ($set = current state).
    expect(typeof installProps.version).toBe('string');
    const { $set: _set, ...installRest } = installProps;
    expect(scrubProperties(installRest)).toEqual(
      installRest as Record<string, string | number | boolean>
    );
  });

  it('(e) empty DB produces zero events without throwing', () => {
    expect(buildBackfillEvents(makeDb(), 'install-1', NOW)).toEqual([]);
    // Even a database with no tables at all.
    expect(buildBackfillEvents(new Database(':memory:'), 'install-1', NOW)).toEqual([]);
    expect(findFirstActivityEpochMs(new Database(':memory:'))).toBeNull();
  });

  it('(f) discovery_tokens sums session_summaries only — one turn counts once', () => {
    const db = makeDb();
    const epoch = Date.UTC(2025, 2, 3, 9, 0, 0); // 2025-03-03
    // One compression turn: the same 100-token cost is written to every
    // observation row of the turn AND the turn's summary row.
    insertObs(db, { epoch, memId: 's-1', tokens: 100 });
    insertObs(db, { epoch: epoch + 1000, memId: 's-1', tokens: 100 });
    insertObs(db, { epoch: epoch + 2000, memId: 's-1', tokens: 100 });
    insertSummary(db, { epoch: epoch + 3000, memId: 's-1', tokens: 100 });

    const rollups = collectDailyRollups(db, LAST_FULL_DAY, '2024-01-01');
    expect(rollups.length).toBe(1);
    expect(rollups[0].day).toBe('2025-03-03');
    expect(rollups[0].counters.discovery_tokens).toBe(100);
  });

  it('(g) one session with one observation: no double counting', () => {
    const db = makeDb();
    const epoch = Date.UTC(2025, 3, 4, 14, 0, 0); // 2025-04-04
    insertSession(db, { epoch, memId: 's-1', project: 'alpha' });
    insertObs(db, { epoch: epoch + 1000, memId: 's-1', project: 'alpha' });

    const rollups = collectDailyRollups(db, LAST_FULL_DAY, '2024-01-01');
    expect(rollups.length).toBe(1);
    expect(rollups[0].counters.session_count).toBe(1);
    expect(rollups[0].counters.project_count).toBe(1);
    expect(rollups[0].counters.observation_count).toBe(1);
  });

  it('(h) install_inferred uses the sessions MIN at noon UTC with first_active_date in $set', () => {
    const db = makeDb();
    // Backdated artifact observation: 2025-08-12 (legacy seconds epoch).
    insertObs(db, { epoch: 1_755_000_000 });
    // Trustworthy session start: 2025-10-19T08:00Z.
    insertSession(db, { epoch: Date.UTC(2025, 9, 19, 8, 0, 0), memId: 's-1' });

    const events = buildBackfillEvents(db, 'install-1', NOW);
    const install = events.filter(e => e.event === 'install_inferred');
    expect(install.length).toBe(1);
    expect(install[0].timestamp.toISOString()).toBe('2025-10-19T12:00:00.000Z');
    expect(install[0].properties.first_active_date).toBe('2025-10-19');
    const set = install[0].properties.$set as Record<string, unknown>;
    expect(set.first_active_date).toBe('2025-10-19');
    expect(install[0].uuid).toBe(deterministicEventUuid('install-1', 'install_inferred', 'install'));
    // The backdated artifact day is clamped out of the rollups entirely.
    expect(historicalDays(events)).not.toContain('2025-08-12');
  });

  it('(i) first activity 1h ago (installDay > lastFullDay) yields zero events', () => {
    const db = makeDb();
    insertSession(db, { epoch: NOW - 1 * HOUR_MS, memId: 's-1' });
    insertObs(db, { epoch: NOW - 1 * HOUR_MS, memId: 's-1' });
    expect(buildBackfillEvents(db, 'install-1', NOW)).toEqual([]);
  });
});

describe('runHistoricalBackfill gates', () => {
  function seedHistoricalDb(): Database {
    const db = makeDb();
    const epoch = Date.now() - 10 * DAY_MS;
    insertSession(db, { epoch, memId: 's-1' });
    insertObs(db, { epoch: epoch + 1000, memId: 's-1' });
    return db;
  }

  it('(j) consent off: no client, no captures, no marker', async () => {
    process.env.CLAUDE_MEM_TELEMETRY = '0';
    await runHistoricalBackfill(seedHistoricalDb());
    expect(postHogConstructorCalls.length).toBe(0);
    expect(postHogCaptureCalls.length).toBe(0);
    expect(existsSync(markerPath())).toBe(false);
  });

  it('(j) existing marker: returns before doing anything', async () => {
    writeFileSync(
      markerPath(),
      JSON.stringify({ completedAt: 'x', throughDay: '2026-01-01', eventCount: 1, installId: 'i' })
    );
    await runHistoricalBackfill(seedHistoricalDb());
    expect(postHogConstructorCalls.length).toBe(0);
    expect(postHogCaptureCalls.length).toBe(0);
  });

  it('(j) debug mode: stderr dry-run, no send, no marker', async () => {
    process.env.CLAUDE_MEM_TELEMETRY_DEBUG = '1';
    const db = seedHistoricalDb();
    const lines = await withStderrCapture(async () => {
      await runHistoricalBackfill(db);
    });
    expect(lines.some(l => l.includes('[telemetry-backfill]'))).toBe(true);
    expect(postHogConstructorCalls.length).toBe(0);
    expect(postHogCaptureCalls.length).toBe(0);
    expect(existsSync(markerPath())).toBe(false);
  });

  it('(j) debug mode on an EMPTY DB: still no marker (debug never latches)', async () => {
    process.env.CLAUDE_MEM_TELEMETRY_DEBUG = '1';
    const db = makeDb();
    const lines = await withStderrCapture(async () => {
      await runHistoricalBackfill(db);
    });
    expect(lines.some(l => l.includes('[telemetry-backfill]'))).toBe(true);
    expect(postHogCaptureCalls.length).toBe(0);
    expect(existsSync(markerPath())).toBe(false);
  });

  it('zero events (fresh install): writes the marker without sending', async () => {
    await runHistoricalBackfill(makeDb());
    expect(postHogConstructorCalls.length).toBe(0);
    expect(postHogCaptureCalls.length).toBe(0);
    expect(existsSync(markerPath())).toBe(true);
    expect(readMarker().eventCount).toBe(0);
  });

  it('(j) second invocation after success sends nothing', async () => {
    const db = seedHistoricalDb();
    await runHistoricalBackfill(db);
    expect(existsSync(markerPath())).toBe(true);
    const sentCount = postHogCaptureCalls.length;
    expect(sentCount).toBeGreaterThan(0);
    await runHistoricalBackfill(db);
    expect(postHogCaptureCalls.length).toBe(sentCount);
  });

  it('(k) happy path: historicalMigration client, uuid + Date timestamps, marker with throughDay', async () => {
    const expectedThroughBefore = utcDayString(Date.now() - 60 * HOUR_MS);
    await runHistoricalBackfill(seedHistoricalDb());
    const expectedThroughAfter = utcDayString(Date.now() - 60 * HOUR_MS);

    expect(postHogConstructorCalls.length).toBe(1);
    const options = postHogConstructorCalls[0].options;
    expect(options.historicalMigration).toBe(true);
    expect(options.flushAt).toBe(5000);
    expect(options.maxBatchSize).toBe(5000);
    expect(options.maxQueueSize).toBe(5000);
    expect(options.disableGeoip).toBe(false);

    // One active day + one install_inferred.
    expect(postHogCaptureCalls.length).toBe(2);
    for (const call of postHogCaptureCalls) {
      expect(typeof call.uuid).toBe('string');
      expect(call.uuid as string).toMatch(UUID_RE);
      expect(call.timestamp instanceof Date).toBe(true);
      expect(typeof call.distinctId).toBe('string');
    }
    expect(postHogCaptureCalls.map(c => c.event)).toContain('install_inferred');

    expect(existsSync(markerPath())).toBe(true);
    const marker = readMarker();
    expect([expectedThroughBefore, expectedThroughAfter]).toContain(marker.throughDay as string);
    expect(marker.eventCount).toBe(2);
    expect(marker.installId).toBe(postHogCaptureCalls[0].distinctId as string);
  });

  it('(k) an emitted client error prevents the marker (retry on next start)', async () => {
    postHogMockBehavior.emitErrorOnShutdown = new Error('delivery failed');
    await runHistoricalBackfill(seedHistoricalDb());
    expect(postHogCaptureCalls.length).toBe(2);
    expect(existsSync(markerPath())).toBe(false);
  });
});
