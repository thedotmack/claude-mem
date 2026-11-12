/**
 * Offline full-corpus dedup benchmark: bun scripts/bench-dedup-sweep.ts [groups=100] [width=100].
 * Uses synthetic titles in an in-memory SQLite database; no model or network calls.
 * Run each revision in a fresh process to compare process peak RSS as well as sweep time.
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { bumpTokenDf, sweepProjectCandidates } from '../src/services/sqlite/dedup-store.js';

const groups = Number(process.argv[2] ?? 100);
const width = Number(process.argv[3] ?? 100);
if (!Number.isSafeInteger(groups) || groups < 1 || !Number.isSafeInteger(width) || width < 2) {
  throw new Error('groups must be a positive integer and width must be an integer >= 2');
}
const db = new Database(':memory:');
try {
  db.exec(`
    CREATE TABLE observations (id INTEGER PRIMARY KEY, project TEXT NOT NULL, title TEXT);
    CREATE INDEX observations_project ON observations(project);
    CREATE TABLE token_df (project TEXT, token TEXT, df INTEGER, PRIMARY KEY(project, token));
    CREATE TABLE dedup_meta (project TEXT PRIMARY KEY, doc_count INTEGER);
    CREATE TABLE observation_dedup_candidates (
      observation_id INTEGER, duplicate_of_id INTEGER, project TEXT, method TEXT, score REAL,
      status TEXT, created_at TEXT, created_at_epoch INTEGER,
      UNIQUE(observation_id, duplicate_of_id)
    );
  `);
  const insert = db.prepare('INSERT INTO observations (project, title) VALUES (?, ?)');
  const inputHash = createHash('sha256');
  db.transaction(() => {
    for (let group = 0; group < groups; group++) {
      for (let member = 0; member < width; member++) {
        const a = `topic-${group}`;
        const b = `component-${group}`;
        const title = member === 0 ? `${a} ${b} ready-${group}`
          : member === 1 ? `${b} ${a} ready-${group}`
          : `${a} ${b} revision-${group}-${member}`;
        insert.run('benchmark', title);
        bumpTokenDf(db, 'benchmark', title);
        inputHash.update(title + '\n');
      }
    }
  })();
  Bun.gc(true);
  const cpu = process.cpuUsage();
  const started = performance.now();
  const added = sweepProjectCandidates(db, 'benchmark', {
    cosineThreshold: 0.1, idfVetoDf: 10, minSharedTokens: 2,
    maxScan: 2000, maxBackfillRows: groups * width,
  });
  const elapsedMs = performance.now() - started;
  const cpuUsed = process.cpuUsage(cpu);
  const pairs = db.prepare(`SELECT observation_id, duplicate_of_id, method, score, status
    FROM observation_dedup_candidates ORDER BY observation_id, duplicate_of_id`).all();
  console.log(JSON.stringify({
    rows: groups * width, groups, width, candidates: added,
    inputSha256: inputHash.digest('hex'),
    outputSha256: createHash('sha256').update(JSON.stringify(pairs)).digest('hex'),
    elapsedMs, cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
    processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
  }));
} finally {
  db.close();
}
