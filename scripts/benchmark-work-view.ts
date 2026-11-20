#!/usr/bin/env bun
/**
 * My Work read benchmark. Default: a disposable sparse-history database.
 *   bun scripts/benchmark-work-view.ts --output reports/work-view-benchmark.json
 *   bun scripts/benchmark-work-view.ts --rows 500000 --payload-bytes 4096 --cold-runs 20 --warm-runs 50
 * A real database must be selected explicitly with --db; it is opened read-only.
 * Reports contain aggregate timings/counts/plans, never row contents or IDs.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { WorkStateSource } from '../src/services/work-view/data-source.mjs';
import { readProductRecords } from '../src/services/work-view/work-product.mjs';

const options = ['--rows', '--payload-bytes', '--dense-rows', '--cold-runs', '--warm-runs', '--db', '--ledger', '--output'];
if (process.argv.includes('--help')) {
  console.log('Usage: bun scripts/benchmark-work-view.ts [--rows N] [--payload-bytes N] [--dense-rows N] [--cold-runs N] [--warm-runs N] [--output PATH]\n'
    + '       bun scripts/benchmark-work-view.ts --db PATH [--ledger PATH] [--output PATH]\n'
    + 'Defaults to disposable synthetic data (100000 historical rows per table). Explicit --db reads only.');
  process.exit(0);
}
for (let index = 2; index < process.argv.length; index += 2) {
  if (!options.includes(process.argv[index])) throw new Error(`Unknown option: ${process.argv[index]}; use --help`);
}
const value = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const next = process.argv[index + 1];
  if (!next || next.startsWith('--')) throw new Error(`${name} requires a value`);
  return next;
};
function integer(name: string, fallback: number, max: number): number {
  const raw = value(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new Error(`${name} must be 1–${max}`);
  return Number(raw);
}
const rows = integer('--rows', 100_000, 2_000_000);
const payloadBytes = integer('--payload-bytes', 256, 65_536);
const denseRows = integer('--dense-rows', 0, 2_000_000);
const coldRuns = integer('--cold-runs', 3, 100);
const warmRuns = integer('--warm-runs', 10, 1000);
const requestedDb = value('--db');
if (requestedDb && denseRows) throw new Error('--dense-rows is available only with disposable synthetic data');
const output = value('--output');
const temporary = requestedDb ? null : mkdtempSync(join(tmpdir(), 'work-view-benchmark-'));
const databasePath = requestedDb ? resolve(requestedDb) : join(temporary!, 'source.db');
const ledgerDir = value('--ledger') ? resolve(value('--ledger')!) : null;

function fileIdentity(path: string): string | null {
  try { const stat = statSync(path); return `${stat.dev}:${stat.ino}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Resolve directory aliases even when the output/sidecar leaf does not exist yet. */
function canonicalDestination(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(realpathSync(dirname(resolve(path))), basename(path));
  }
}

function assertReportOutput(): void {
  if (!output) return;
  // Protect both the selected name and the real database name: the selected
  // file itself may be a symlink, while its SQLite sidecars use the real name.
  const protectedPaths = [databasePath, canonicalDestination(databasePath)]
    .flatMap(path => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]);
  const identity = fileIdentity(output);
  const destination = canonicalDestination(output);
  if (protectedPaths.some(path => canonicalDestination(path) === destination)
    || (identity !== null && protectedPaths.some(path => fileIdentity(path) === identity))) {
    throw new Error('Report output cannot overwrite the database or its sidecars');
  }
}
assertReportOutput();

const now = Date.now();
const round = (ms: number) => Math.round(ms * 100) / 100;
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const summary = (samples: number[]) => ({ samples: samples.length, p50Ms: round(percentile(samples, .5)), p95Ms: round(percentile(samples, .95)), minMs: round(Math.min(...samples)), maxMs: round(Math.max(...samples)) });

function createFixture(path: string, historicalRows = rows): void {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE work_state_entries (id INTEGER PRIMARY KEY, project TEXT, list_name TEXT, fields TEXT, created_at_epoch INTEGER);
      CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, project TEXT, platform_source TEXT, content_session_id TEXT,
        memory_session_id TEXT, user_prompt TEXT, custom_title TEXT, status TEXT, started_at_epoch INTEGER,
        completed_at_epoch INTEGER, cwd TEXT);
      CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER, prompt_text TEXT, created_at_epoch INTEGER);
      CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, project TEXT, platform_source TEXT, agent_id TEXT, agent_type TEXT,
        session_db_id INTEGER, memory_session_id TEXT, content_session_id TEXT, prompt_number INTEGER, tool_name TEXT,
        tool_input TEXT, tool_response TEXT, created_at_epoch INTEGER, cwd TEXT);
      CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT, memory_session_id TEXT, content_session_id TEXT,
        agent_id TEXT, agent_type TEXT, prompt_number INTEGER, title TEXT, subtitle TEXT, type TEXT, narrative TEXT,
        facts TEXT, concepts TEXT, files_read TEXT, files_modified TEXT, created_at_epoch INTEGER);
      CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, project TEXT, memory_session_id TEXT, prompt_number INTEGER,
        request TEXT, completed TEXT, next_steps TEXT, created_at_epoch INTEGER);
      CREATE TABLE deliverables (id INTEGER PRIMARY KEY, project TEXT, content_session_id TEXT, platform_source TEXT,
        title TEXT, kind TEXT, source_path TEXT, bucket_path TEXT, created_at_epoch INTEGER);
      CREATE INDEX idx_tool_uses_created_at_epoch ON tool_uses(created_at_epoch);
      CREATE INDEX idx_tool_uses_tool_name ON tool_uses(tool_name);
      CREATE INDEX idx_tool_uses_session_db_id ON tool_uses(session_db_id);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
      CREATE INDEX idx_benchmark_prompt_session ON user_prompts(session_db_id);
    `);
    const tool = db.prepare(`INSERT INTO tool_uses
      (id, project, platform_source, session_db_id, content_session_id, prompt_number, tool_name, tool_input, tool_response, created_at_epoch)
      VALUES (?, 'benchmark', 'claude', ?, ?, 1, ?, ?, '{}', ?)`);
    const observation = db.prepare(`INSERT INTO observations
      (id, project, memory_session_id, content_session_id, prompt_number, title, type, narrative, files_modified, created_at_epoch)
      VALUES (?, 'benchmark', ?, ?, 1, 'Synthetic observation', 'discovery', ?, ?, ?)`);
    const padding = 'x'.repeat(payloadBytes);
    db.transaction(() => {
      // High IDs deliberately represent old imported history; sorting by time
      // instead of ID must not accidentally appear equivalent in this fixture.
      for (let index = 0; index < historicalRows; index++) {
        tool.run(index + 1000, null, null, index % 2 ? 'Read' : 'Bash', JSON.stringify({ command: 'echo synthetic', padding }), now - 365 * 86400000);
        observation.run(index + 1000, null, null, padding, '[]', now - 365 * 86400000);
      }
      for (let index = 1; index <= 140; index++) {
        const stamp = now - (141 - index) * 10;
        db.prepare(`INSERT INTO sdk_sessions VALUES (?, 'benchmark', 'claude', ?, ?, 'Synthetic request', NULL, 'completed', ?, ?, NULL)`)
          .run(index, `synthetic-${index}`, `memory-${index}`, stamp, stamp);
        db.prepare(`INSERT INTO user_prompts VALUES (?, ?, 1, 'Synthetic request', ?)`).run(index, index, stamp);
        tool.run(index, index, `synthetic-${index}`, index % 2 ? 'Artifact' : 'Bash', index % 2 ? '{}' : '{"command":"git commit -m synthetic"}', stamp);
        observation.run(index, `memory-${index}`, `synthetic-${index}`, 'Synthetic evidence', '["/nonexistent/synthetic.png"]', stamp);
      }
      db.prepare('INSERT INTO work_state_entries VALUES (1, ?, ?, ?, ?)')
        .run('benchmark', 'benchmark', JSON.stringify({ task: 'Benchmark read', status: 'todo' }), now - 2000);
    })();
  } finally { db.close(); }
}

function timedRead(source: WorkStateSource, maxActivityAgeMs: number) {
  const start = performance.now();
  const result = source.read({ maxActivityAgeMs });
  const durationMs = performance.now() - start;
  if (!result.agentView.source.connected) throw new Error('Work view source could not be read');
  const serializeStart = performance.now();
  const json = JSON.stringify(result.agentView);
  return { durationMs, serializationMs: performance.now() - serializeStart, payloadBytes: Buffer.byteLength(json), requestCount: result.agentView.humanRequests.length };
}

function compareQueries(db: Database, sinceEpoch: number) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  // Capture the production SQL; retain no row content in the report.
  readProductRecords((sql: string, params: unknown[]) => { queries.push({ sql, params }); return []; }, sinceEpoch, 2000, { database: db });
  return queries.map(({ sql, params }, position) => {
    const kind = ['publishingCalls', 'gitCalls', 'productObservations', 'productDeliverables'][position];
    const baseline = sql.replace(/ INDEXED BY \w+/g, '');
    const baselineTimes: number[] = [], selectedTimes: number[] = [];
    let rowCount = 0;
    for (let sample = 0; sample < 3; sample++) {
      let before: unknown[] = [], after: unknown[] = [];
      const runBaseline = () => { const start = performance.now(); before = db.query(baseline).all(...params as never[]); baselineTimes.push(performance.now() - start); };
      const runSelected = () => { const start = performance.now(); after = db.query(sql).all(...params as never[]); selectedTimes.push(performance.now() - start); };
      if (sample % 2) { runSelected(); runBaseline(); } else { runBaseline(); runSelected(); }
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`${kind}: changed product results or ordering`);
      rowCount = after.length;
    }
    return {
      kind, rowCount, identicalRowsAndOrder: true,
      baseline: summary(baselineTimes), selected: summary(selectedTimes),
      baselinePlan: db.query(`EXPLAIN QUERY PLAN ${baseline}`).all(...params as never[]).map((row: any) => row.detail),
      selectedPlan: db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params as never[]).map((row: any) => row.detail),
    };
  });
}

function compareProductReads(db: Database, sinceEpoch: number) {
  const baseline: number[] = [], selected: number[] = [];
  const read = (sql: string, params: unknown[]) => db.query(sql).all(...params as never[]);
  for (let sample = 0; sample < 3; sample++) {
    let before: unknown, after: unknown;
    const original = () => { const start = performance.now(); before = readProductRecords(read, sinceEpoch); baseline.push(performance.now() - start); };
    const optimized = () => { const start = performance.now(); after = readProductRecords(read, sinceEpoch, 2000, { database: db }); selected.push(performance.now() - start); };
    if (sample % 2) { optimized(); original(); } else { original(); optimized(); }
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Product discovery changed rows or ordering');
  }
  return { baseline: summary(baseline), selectedIncludingPolicyProbe: summary(selected), identicalRowsAndOrder: true };
}

function candidateRanges(db: Database, sinceEpoch: number) {
  const cap = 20_001;
  return ['tool_uses', 'observations'].map(table => {
    const row = db.query(`SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM ${table} WHERE created_at_epoch >= ? LIMIT ?
    )`).get(sinceEpoch, cap) as { count: number };
    return { table, count: row.count, capped: row.count === cap, cap };
  });
}

function compareDensePositiveRange(path: string) {
  createFixture(path, denseRows);
  const writer = new Database(path);
  try {
    writer.exec(`DELETE FROM tool_uses WHERE id < 1000; DELETE FROM observations WHERE id < 1000;
      UPDATE tool_uses SET tool_name = 'Artifact', created_at_epoch = 200;
      UPDATE observations SET files_modified = '["/synthetic.png"]', created_at_epoch = 200;`);
  } finally { writer.close(); }
  const db = new Database(path, { readonly: true, create: false });
  try {
    db.exec('PRAGMA query_only = ON');
    db.exec('BEGIN');
    return { rowsPerTable: denseRows, cutoff: 1, limit: 2000, candidates: candidateRanges(db, 1), discovery: compareProductReads(db, 1), queries: compareQueries(db, 1) };
  } finally { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); }
}

try {
  if (temporary) createFixture(databasePath);
  // Every projection connection is read-only, including the synthetic case.
  const cold: number[] = [];
  for (let run = 0; run < coldRuns; run++) {
    const source = new WorkStateSource({ databasePath, ledgerDir });
    try { cold.push(timedRead(source, 0).durationMs); } finally { source.close(); }
  }
  const source = new WorkStateSource({ databasePath, ledgerDir });
  let last: ReturnType<typeof timedRead>;
  let recentCutoff = 0;
  const warm: number[] = [], cached: number[] = [];
  try {
    last = timedRead(source, 0);
    for (let run = 0; run < warmRuns; run++) warm.push(timedRead(source, 0).durationMs);
    for (let run = 0; run < warmRuns; run++) cached.push(timedRead(source, 120_000).durationMs);
    // Match readAgentRecords: its product window is the oldest of the 240
    // latest list/task updates, not the newest raw work-state entry.
    const workTimes = (source as any).cachedState.lists.flatMap((list: any) => [list.stateUpdatedAtEpoch,
      ...list.tasks.map((task: any) => task.updatedAtEpoch)]).filter(Boolean).sort((a: number, b: number) => b - a).slice(0, 240);
    recentCutoff = workTimes.length ? workTimes.at(-1)! - 5000 : 0;
  } finally { source.close(); }
  const db = new Database(databasePath, { readonly: true, create: false });
  let queryWindows;
  try {
    db.exec('PRAGMA query_only = ON');
    db.exec('BEGIN');
    // Compare one consistent snapshot per report, including no-cutoff reads.
    queryWindows = [
      { cutoff: 'recent-work-state', sinceEpoch: recentCutoff, candidates: candidateRanges(db, recentCutoff), discovery: compareProductReads(db, recentCutoff), queries: compareQueries(db, recentCutoff) },
      { cutoff: 'all-history', sinceEpoch: 0, candidates: candidateRanges(db, 0), discovery: compareProductReads(db, 0), queries: compareQueries(db, 0) },
    ];
  } finally { if (db.inTransaction) db.exec('ROLLBACK'); db.close(); }
  const report = {
    capturedAt: new Date().toISOString(), mode: temporary ? 'synthetic-sparse-history' : 'explicit-read-only-database',
    databaseBytes: statSync(databasePath).size,
    synthetic: temporary ? { historicalRowsPerTable: rows, payloadBytes, recentRequests: 140 } : null,
    caveat: 'New-reader is not cold OS cache. Query pairs alternate order and compare a shared read transaction. Small synthetic fixtures do not prove the large-database production target.',
    newReader: summary(cold), warm: summary(warm), cachedBackground: summary(cached),
    snapshot: { payloadBytes: last!.payloadBytes, serializationMs: round(last!.serializationMs), requestCount: last!.requestCount }, queryWindows,
    densePositive: denseRows ? compareDensePositiveRange(join(temporary!, 'dense.db')) : null,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    assertReportOutput();
    // Replace the output entry atomically instead of following a symlink or
    // truncating a hardlink if its target changed while the benchmark ran.
    const temporaryOutput = `${output}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryOutput, json, { mode: 0o600, flag: 'wx' });
      renameSync(temporaryOutput, output);
    } finally { rmSync(temporaryOutput, { force: true }); }
  }
  console.log(json);
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
