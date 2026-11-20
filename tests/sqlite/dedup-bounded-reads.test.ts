import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { backfillProjectDedup, buildProjectIdf, recordTier1Candidates, sweepProjectCandidates } from '../../src/services/sqlite/dedup-store.js';
import { classifyPair } from '../../src/services/dedup/nearDuplicate.js';
import { idf } from '../../src/services/dedup/idf.js';

const cfg = { cosineThreshold: 0.8, idfVetoDf: 3, minSharedTokens: 2, maxScan: 2, maxBackfillRows: 50000 };

function seed(store: SessionStore, titles: string[], project = 'project'): number[] {
  const session = store.createSDKSession(`content-${project}`, project, 'prompt');
  store.updateMemorySessionId(session, `memory-${project}`);
  const insert = store.db.prepare(`INSERT INTO observations
    (memory_session_id, project, type, title, created_at, created_at_epoch)
    VALUES (?, ?, 'discovery', ?, ?, ?)`);
  const ids: number[] = [];
  store.db.transaction(() => {
    titles.forEach((title, index) => ids.push(Number(insert.run(`memory-${project}`, project, title,
      new Date(index + 1).toISOString(), index + 1).lastInsertRowid)));
  })();
  backfillProjectDedup(store.db, project);
  return ids;
}

/** Count actual rows returned by the real SQLite statements, not just query strings. */
function metered(db: Database): { db: Database; reads: { df: number; titles: number } } {
  const reads = { df: 0, titles: 0 };
  return { reads, db: new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(stmt, member) {
        if (member === 'all') return (...args: unknown[]) => {
          const rows = (stmt.all as Function).apply(stmt, args);
          if (/SELECT token, df FROM token_df/.test(sql)) reads.df += rows.length;
          if (/SELECT id, title FROM observations/.test(sql)) reads.titles += rows.length;
          return rows;
        };
        const value = Reflect.get(stmt, member);
        return typeof value === 'function' ? value.bind(stmt) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) };
}

describe('dedup query memory bounds', () => {
  it('classifies the same recent pairs without materializing unrelated project vocabulary per insert', () => {
    const store = new SessionStore(':memory:');
    try {
      const titles = [...Array.from({ length: 2000 }, (_, index) => `old-vocabulary-${index}`),
        'build the worker service module', 'unrelated latest subject', 'worker build the service module'];
      const ids = seed(store, titles);
      const title = titles.at(-1)!;
      const reference = buildProjectIdf(store.db, 'project');
      const expected = titles.slice(-3, -1).filter(candidate => classifyPair(title, candidate, reference.idfFn, {
        ...cfg, vetoThetaIdf: idf(cfg.idfVetoDf + 1, reference.docCount),
      }).tier === 'candidate').length;
      const measured = metered(store.db);
      expect(recordTier1Candidates(measured.db, 'project', ids.at(-1)!, title, cfg)).toBe(expected);
      expect(expected).toBe(1);
      expect(measured.reads.titles).toBe(2);
      expect(measured.reads.df).toBeGreaterThan(0);
      expect(measured.reads.df).toBeLessThan(20);
      expect(recordTier1Candidates(measured.db, 'project', ids.at(-1)!, title, cfg)).toBe(0);
    } finally { store.close(); }
  });

  it('does not load an IDF model when the recent scan has no other title to compare', () => {
    const store = new SessionStore(':memory:');
    try {
      const [id] = seed(store, ['single new title']);
      const measured = metered(store.db);
      expect(recordTier1Candidates(measured.db, 'project', id, 'single new title', cfg)).toBe(0);
      expect(measured.reads.df).toBe(0);
    } finally { store.close(); }
  });

  it('rejects an oversized full scan after reading at most one title beyond its cap', () => {
    const store = new SessionStore(':memory:');
    try {
      seed(store, Array.from({ length: 500 }, (_, index) => `title number ${index}`));
      const measured = metered(store.db);
      expect(sweepProjectCandidates(measured.db, 'project', { ...cfg, maxBackfillRows: 10 })).toBe(0);
      expect(measured.reads.titles).toBe(11);
      expect(measured.reads.df).toBe(0);
      expect(store.listDedupCandidates('project')).toHaveLength(0);
    } finally { store.close(); }
  });

  it('retains full-scan candidates at the cap and rare-token vetoes in the live scan', () => {
    const store = new SessionStore(':memory:');
    try {
      const titles = ['build the worker service module', 'worker build the service module',
        'worker build the service different-identifier'];
      const ids = seed(store, titles);
      expect(sweepProjectCandidates(store.db, 'project', { ...cfg, maxBackfillRows: 3 })).toBe(1);
      expect(recordTier1Candidates(store.db, 'project', ids[2], titles[2], { ...cfg, cosineThreshold: 0.1 })).toBe(0);
    } finally { store.close(); }
  });

  it('handles more tokens than the legacy SQLite binding limit without changing pair scores', () => {
    const store = new SessionStore(':memory:');
    try {
      const tokens = Array.from({ length: 1100 }, (_, index) => `token-${index}`);
      const titles = [tokens.join(' '), [...tokens].reverse().join(' ')];
      const ids = seed(store, titles);
      expect(recordTier1Candidates(store.db, 'project', ids[1], titles[1], cfg)).toBe(1);
      const [candidate] = store.listDedupCandidates('project');
      expect(candidate.score).toBe(1);
    } finally { store.close(); }
  });
});
