import { describe, it, expect } from 'bun:test';
import { jaccardSimilarity, dedupResults } from '../../../src/services/worker/search/dedup.js';
import type { DedupableResult } from '../../../src/services/worker/search/dedup.js';

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical texts', () => {
    expect(jaccardSimilarity('hello world foo', 'hello world foo')).toBe(1.0);
  });

  it('returns 0.0 for completely different texts', () => {
    expect(jaccardSimilarity('hello world', 'foo bar baz')).toBe(0.0);
  });

  it('returns correct similarity for partially overlapping texts', () => {
    const sim = jaccardSimilarity(
      'fixed authentication bug in login handler',
      'fixed authentication bug in the login handler code'
    );
    // Intersection: {fixed, authentication, bug, in, login, handler} = 6
    // Union: {fixed, authentication, bug, in, login, handler, the, code} = 8
    // Jaccard = 6/8 = 0.75
    expect(sim).toBeCloseTo(0.75, 1);
  });

  it('returns 0.0 for empty strings', () => {
    expect(jaccardSimilarity('', '')).toBe(0.0);
  });
});

// Helper to create mock results
function mockResult(overrides: Partial<DedupableResult> & { id: number }): DedupableResult {
  return {
    text: `Observation ${overrides.id}`,
    title: `Title ${overrides.id}`,
    narrative: null,
    score: 1.0 - overrides.id * 0.1,
    memory_session_id: 'session-1',
    project: 'project-a',
    ...overrides,
  };
}

describe('dedupResults', () => {
  describe('Layer 1: Project diversity (no project > 60%)', () => {
    it('enforces project diversity cap', () => {
      const results: DedupableResult[] = Array.from({ length: 10 }, (_, i) => mockResult({
        id: i + 1,
        score: 1 - i * 0.05,
        text: `Unique observation number ${i} about topic ${i}`,
        memory_session_id: `sess-${i}`,
        project: i < 8 ? 'project-a' : 'project-b',
      }));
      const deduped = dedupResults(results, { maxPerSession: 100 }); // disable L2 to isolate L1
      const projectACounts = deduped.filter(r => r.project === 'project-a').length;
      expect(projectACounts).toBeLessThanOrEqual(Math.ceil(deduped.length * 0.6) + 1);
    });

    it('keeps all results when projects are balanced', () => {
      const results: DedupableResult[] = [
        mockResult({ id: 1, project: 'proj-a', memory_session_id: 'sess-1' }),
        mockResult({ id: 2, project: 'proj-b', memory_session_id: 'sess-2' }),
        mockResult({ id: 3, project: 'proj-c', memory_session_id: 'sess-3' }),
      ];
      const deduped = dedupResults(results, { maxPerSession: 100 });
      expect(deduped).toHaveLength(3);
    });
  });

  describe('Layer 2: Session cap', () => {
    it('caps results per session with default cap of 8', () => {
      const results: DedupableResult[] = Array.from({ length: 12 }, (_, i) => mockResult({
        id: i + 1,
        score: 1 - i * 0.05,
        text: `Observation ${i} about different topic ${i}`,
        memory_session_id: 'sess-1',
      }));
      const deduped = dedupResults(results);
      expect(deduped).toHaveLength(8); // default cap = 8
    });

    it('caps results per session with custom cap', () => {
      const results: DedupableResult[] = [
        mockResult({ id: 1, score: 0.9, memory_session_id: 'sess-1' }),
        mockResult({ id: 2, score: 0.8, memory_session_id: 'sess-1' }),
        mockResult({ id: 3, score: 0.7, memory_session_id: 'sess-1' }),
        mockResult({ id: 4, score: 0.6, memory_session_id: 'sess-2', project: 'project-b' }),
      ];
      const deduped = dedupResults(results, { maxPerSession: 2 });
      const sess1 = deduped.filter(r => r.memory_session_id === 'sess-1');
      expect(sess1).toHaveLength(2);
      expect(deduped.map(r => r.id)).toContain(4); // sess-2 item preserved
    });

    it('preserves session diversity with cap=8 (isolated from L1)', () => {
      // Use diverse projects so L1 (project diversity 60%) does NOT interfere:
      // 6 different projects across 16 items -> no single project exceeds 60% cap
      const results: DedupableResult[] = [
        ...Array.from({ length: 10 }, (_, i) => mockResult({
          id: i + 1, score: 1 - i * 0.05, memory_session_id: 'sess-1',
          project: `proj-${i % 4}`, // spread across 4 projects
        })),
        ...Array.from({ length: 5 }, (_, i) => mockResult({
          id: 20 + i, score: 0.5 - i * 0.05, memory_session_id: 'sess-2',
          project: 'proj-4',
        })),
        mockResult({ id: 30, score: 0.3, memory_session_id: 'sess-3', project: 'proj-5' }),
      ];
      const deduped = dedupResults(results, { maxPerSession: 8 });
      const sess1 = deduped.filter(r => r.memory_session_id === 'sess-1');
      const sess2 = deduped.filter(r => r.memory_session_id === 'sess-2');
      const sess3 = deduped.filter(r => r.memory_session_id === 'sess-3');
      expect(sess1).toHaveLength(8);  // capped at 8 (was 10)
      expect(sess2).toHaveLength(5);  // all 5 kept (under cap)
      expect(sess3).toHaveLength(1);  // single item kept
    });
  });

  describe('Combined layers', () => {
    it('L1 project diversity filters before L2 session cap', () => {
      // 10 results: all from sess-1, but 8 from project-a and 2 from project-b
      // Step 1 - L1 (project 60%): maxPerProject = ceil(10 * 0.6) = 6
      //   project-a: 8 items -> capped to 6 (ids 1-6), drops ids 7,8
      //   project-b: 2 items -> kept (ids 9,10)
      //   After L1: 8 items remain
      // Step 2 - L2 (session cap=3): all 8 are sess-1 -> capped to 3 (ids 1,2,3)
      const results: DedupableResult[] = Array.from({ length: 10 }, (_, i) => mockResult({
        id: i + 1,
        score: 1 - i * 0.05,
        memory_session_id: 'sess-1',
        project: i < 8 ? 'project-a' : 'project-b',
      }));
      const deduped = dedupResults(results, { maxPerSession: 3 });
      expect(deduped).toHaveLength(3);
      // First 3 items after L1 are ids 1,2,3 (all project-a, highest scores)
      expect(deduped.map(r => r.id)).toEqual([1, 2, 3]);
    });

    it('both layers compose: diversity limits project, cap limits session', () => {
      // 2 sessions, 2 projects — designed so both layers filter something
      // sess-1: 6 items (project-a), sess-2: 4 items (project-a)
      // Total: 10, all project-a -> L1 caps project-a to ceil(10*0.6)=6
      // After L1: first 6 by score (ids 1-6) — sess-1 has 6, sess-2 has 0
      // Wait, scores matter. Let's interleave:
      const results: DedupableResult[] = [
        mockResult({ id: 1, score: 1.0, memory_session_id: 'sess-1', project: 'project-a' }),
        mockResult({ id: 2, score: 0.9, memory_session_id: 'sess-2', project: 'project-a' }),
        mockResult({ id: 3, score: 0.8, memory_session_id: 'sess-1', project: 'project-a' }),
        mockResult({ id: 4, score: 0.7, memory_session_id: 'sess-2', project: 'project-a' }),
        mockResult({ id: 5, score: 0.6, memory_session_id: 'sess-1', project: 'project-a' }),
        mockResult({ id: 6, score: 0.5, memory_session_id: 'sess-2', project: 'project-a' }),
        mockResult({ id: 7, score: 0.4, memory_session_id: 'sess-1', project: 'project-a' }),
        // project-b items at the end
        mockResult({ id: 8, score: 0.3, memory_session_id: 'sess-1', project: 'project-b' }),
        mockResult({ id: 9, score: 0.2, memory_session_id: 'sess-2', project: 'project-b' }),
      ];
      // L1: 9 items, maxPerProject = ceil(9*0.6) = 6
      //   project-a has 7 -> drops id 7 (lowest score project-a item)
      //   project-b has 2 -> kept
      //   After L1: [1,2,3,4,5,6,8,9] = 8 items
      // L2 (cap=3): sess-1 has ids [1,3,5,8] -> keeps [1,3,5], sess-2 has [2,4,6,9] -> keeps [2,4,6]
      const deduped = dedupResults(results, { maxPerSession: 3 });
      expect(deduped).toHaveLength(6);
      expect(deduped.map(r => r.id)).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  describe('Edge cases', () => {
    it('handles empty array', () => {
      expect(dedupResults([])).toEqual([]);
    });

    it('handles single result', () => {
      const results = [mockResult({ id: 1 })];
      expect(dedupResults(results)).toHaveLength(1);
    });

    it('respects custom maxPerSession option', () => {
      const results: DedupableResult[] = [
        mockResult({ id: 1, score: 0.9, memory_session_id: 'sess-1' }),
        mockResult({ id: 2, score: 0.8, memory_session_id: 'sess-1' }),
      ];
      const deduped = dedupResults(results, { maxPerSession: 1 });
      expect(deduped).toHaveLength(1);
    });

    it('respects custom maxProjectRatio option', () => {
      const results: DedupableResult[] = Array.from({ length: 10 }, (_, i) => mockResult({
        id: i + 1,
        score: 1 - i * 0.05,
        memory_session_id: `sess-${i}`,
        project: i < 9 ? 'project-a' : 'project-b',
      }));
      const deduped = dedupResults(results, { maxProjectRatio: 0.5, maxPerSession: 100 });
      const projectACounts = deduped.filter(r => r.project === 'project-a').length;
      expect(projectACounts).toBeLessThanOrEqual(Math.ceil(10 * 0.5));
    });
  });
});
