/** Run with `bun scripts/bench-session-catalog.ts [session-count]` on each revision. */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';

const sessionCount = Number(process.argv[2] ?? 100_000);
if (!Number.isSafeInteger(sessionCount) || sessionCount < 1) throw new Error('session-count must be a positive integer');
const dir = mkdtempSync(join(tmpdir(), 'bench-session-catalog-'));
const path = join(dir, 'memory.db');
let store = new SessionStore(path);

function allocatedBytes(): number {
  const pages = store.db.query('PRAGMA page_count').get() as { page_count: number };
  const free = store.db.query('PRAGMA freelist_count').get() as { freelist_count: number };
  const size = store.db.query('PRAGMA page_size').get() as { page_size: number };
  return (pages.page_count - free.freelist_count) * size.page_size;
}

try {
  const insertSession = store.db.prepare(`INSERT INTO sdk_sessions
    (content_session_id, project, platform_source, custom_title, started_at, started_at_epoch)
    VALUES (?, ?, ?, ?, '2026-11-01T00:00:00Z', ?)`);
  const insertPrompt = store.db.prepare(`INSERT INTO user_prompts
    (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, 1, 'saved prompt', '2026-11-01T00:00:00Z', ?)`);
  store.db.transaction(() => {
    for (let i = 0; i < sessionCount; i++) {
      const contentId = `catalog-${i}`;
      const epoch = Math.floor(i / 4);
      const inserted = insertSession.run(contentId,
        i % 3 === 0 ? 'other' : i % 2 === 0 ? 'Repo' : 'repo',
        i % 2 === 0 ? 'claude' : 'codex', `title ${i}`, epoch);
      if (i % 10 === 0) insertPrompt.run(inserted.lastInsertRowid, contentId, epoch);
    }
  })();
  // Model reopening an existing pre-index database, including populated pages.
  store.db.run('DROP INDEX IF EXISTS idx_sdk_sessions_project_nocase_recent');
  const bytesBeforeOpen = allocatedBytes();
  store.close();
  const openStart = performance.now();
  store = new SessionStore(path);
  const reopenMs = performance.now() - openStart;
  const addedAllocatedBytes = allocatedBytes() - bytesBeforeOpen;

  const workloads = [
    { project: 'REPO', limit: 50 },
    { project: 'REPO', platformSource: 'codex', limit: 50, offset: 50 },
  ];
  const prepare = store.db.prepare;
  const statements: ReturnType<typeof prepare>[] = [];
  store.db.prepare = ((...args: Parameters<typeof prepare>) => {
    const statement = prepare.apply(store.db, args);
    statements.push(statement);
    return statement;
  }) as typeof prepare;
  let expected: ReturnType<SessionStore['getSessionCatalog']>[];
  try {
    expected = workloads.map(options => store.getSessionCatalog(options));
  } finally {
    store.db.prepare = prepare;
  }
  const plans = statements.map(statement =>
    store.db.query(`EXPLAIN QUERY PLAN ${statement.toString()}`).all());
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const outputHash = digest(expected);
  for (let warmup = 0; warmup < 3; warmup++) {
    for (const options of workloads) store.getSessionCatalog(options);
  }
  const iterations = 10;
  const samplesMs: number[] = [];
  for (let sample = 0; sample < 5; sample++) {
    const started = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) {
      for (const options of workloads) store.getSessionCatalog(options);
    }
    samplesMs.push(performance.now() - started);
  }
  if (digest(workloads.map(options => store.getSessionCatalog(options))) !== outputHash) {
    throw new Error('catalog changed during benchmark');
  }
  console.log(JSON.stringify({ sessionCount, workloads, readsPerSample: workloads.length * iterations,
    samplesMs, outputHash, reopenMs, addedAllocatedBytes, allocatedBytes: allocatedBytes(), plans }, null, 2));
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
