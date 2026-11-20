import { describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { backfillProjectDedup, sweepProjectCandidates } from '../../src/services/sqlite/dedup-store.js';

const cfg = { cosineThreshold: 0.1, idfVetoDf: 10, minSharedTokens: 2, maxScan: 2000, maxBackfillRows: 50000 };

describe('full dedup sweep across overlapping postings', () => {
  it('retains every unique reorder pair, its score and review status across interleaved projects', () => {
    const store = new SessionStore(':memory:');
    try {
      for (const project of ['project', 'other']) {
        const session = store.createSDKSession(`content-${project}`, project, 'prompt');
        store.updateMemorySessionId(session, `memory-${project}`);
      }
      const insert = store.db.prepare(`INSERT INTO observations
        (memory_session_id, project, type, title, created_at, created_at_epoch)
        VALUES (?, ?, 'discovery', ?, '2026-01-01T00:00:00.000Z', 1)`);
      const expected: number[][] = [];
      store.db.transaction(() => {
        for (let group = 0; group < 12; group++) {
          const a = `topic-${group}`;
          const b = `component-${group}`;
          const titles = [`${a} ${b} common`, `${b} ${a} common`, `common ${a} ${a} ${b}`,
            ...Array.from({ length: 5 }, (_, member) => `${a} ${b} common revision-${group}-${member}`)];
          const ids = titles.map(title => {
            const id = Number(insert.run('memory-project', 'project', title).lastInsertRowid);
            insert.run('memory-other', 'other', title);
            return id;
          });
          expected.push([ids[1], ids[0]], [ids[2], ids[0]], [ids[2], ids[1]]);
        }
      })();
      backfillProjectDedup(store.db, 'project');
      backfillProjectDedup(store.db, 'other');
      expect(sweepProjectCandidates(store.db, 'project', cfg)).toBe(expected.length);
      const candidates = store.db.prepare(`SELECT observation_id, duplicate_of_id, score, status
        FROM observation_dedup_candidates ORDER BY observation_id, duplicate_of_id`).all() as Array<{
        observation_id: number; duplicate_of_id: number; score: number; status: string;
      }>;
      expect(candidates.map(row => [row.observation_id, row.duplicate_of_id])).toEqual(expected);
      for (const candidate of candidates) {
        expect(candidate.score).toBeCloseTo(1, 12);
        expect(candidate.status).toBe('pending');
      }
      store.db.exec("UPDATE observation_dedup_candidates SET status = 'dismissed'");
      expect(sweepProjectCandidates(store.db, 'project', cfg)).toBe(0);
      expect(store.db.prepare("SELECT COUNT(*) count FROM observation_dedup_candidates WHERE status = 'dismissed'").get())
        .toEqual({ count: expected.length });

      // 'common' appears in every title and is excluded from the posting gate.
      // Repeated copies of a token must not count as additional shared tokens.
      expect(sweepProjectCandidates(store.db, 'other', { ...cfg, minSharedTokens: 3 })).toBe(0);
      expect(store.db.prepare("SELECT COUNT(*) count FROM observation_dedup_candidates WHERE project = 'other'").get())
        .toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });
});
