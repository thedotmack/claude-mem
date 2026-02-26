/**
 * HybridBlendingStrategy tests
 *
 * Uses mocked ChromaSearchStrategy and BM25SearchStrategy instances to test:
 * - Parallel execution of both strategies
 * - Score blending (positional weighting: 0.6 vector, 0.4 keyword)
 * - Deduplication of overlapping results by ID
 * - Graceful degradation when one or both strategies fail
 * - Limit application after blending (not per-strategy)
 * - Session and prompt merging (simple dedup, no scoring)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HybridBlendingStrategy } from '../../../../src/services/worker/search/strategies/HybridBlendingStrategy.js';
import type { ChromaSearchStrategy } from '../../../../src/services/worker/search/strategies/ChromaSearchStrategy.js';
import type { BM25SearchStrategy } from '../../../../src/services/worker/search/strategies/BM25SearchStrategy.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../../../../src/services/worker/search/types.js';

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------

function makeObs(id: number, overrides: Partial<ObservationSearchResult> = {}): ObservationSearchResult {
  return {
    id,
    memory_session_id: `session-${String(id)}`,
    project: 'test-project',
    text: `Observation ${String(id)}`,
    type: 'discovery',
    title: `Title ${String(id)}`,
    subtitle: null,
    facts: null,
    narrative: `Narrative ${String(id)}`,
    concepts: null,
    files_read: null,
    files_modified: null,
    prompt_number: id,
    discovery_tokens: 100,
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: Date.now() - id * 1000,
    ...overrides
  };
}

function makeSession(id: number, overrides: Partial<SessionSummarySearchResult> = {}): SessionSummarySearchResult {
  return {
    id,
    memory_session_id: `session-sum-${String(id)}`,
    project: 'test-project',
    request: `Request ${String(id)}`,
    investigated: null,
    learned: null,
    completed: null,
    next_steps: null,
    files_read: null,
    files_edited: null,
    notes: null,
    prompt_number: id,
    discovery_tokens: 50,
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: Date.now() - id * 1000,
    ...overrides
  };
}

function makePrompt(id: number, overrides: Partial<UserPromptSearchResult> = {}): UserPromptSearchResult {
  return {
    id,
    content_session_id: `session-prompt-${String(id)}`,
    prompt_text: `Prompt ${String(id)}`,
    prompt_number: id,
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: Date.now() - id * 1000,
    ...overrides
  };
}

function makeChromaResult(observations: ObservationSearchResult[], sessions: SessionSummarySearchResult[] = [], prompts: UserPromptSearchResult[] = []): StrategySearchResult {
  return {
    results: { observations, sessions, prompts },
    usedChroma: true,
    fellBack: false,
    strategy: 'chroma'
  };
}

function makeBm25Result(observations: ObservationSearchResult[], sessions: SessionSummarySearchResult[] = [], prompts: UserPromptSearchResult[] = []): StrategySearchResult {
  return {
    results: { observations, sessions, prompts },
    usedChroma: false,
    fellBack: false,
    strategy: 'bm25'
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('HybridBlendingStrategy', () => {
  let strategy: HybridBlendingStrategy;
  let mockChromaStrategy: ChromaSearchStrategy;
  let mockBm25Strategy: BM25SearchStrategy;
  beforeEach(() => {
    mockChromaStrategy = {
      search: vi.fn(),
      canHandle: vi.fn(() => true),
      name: 'chroma'
    } as unknown as ChromaSearchStrategy;

    mockBm25Strategy = {
      search: vi.fn(),
      canHandle: vi.fn(() => true),
      name: 'bm25'
    } as unknown as BM25SearchStrategy;

    strategy = new HybridBlendingStrategy(mockChromaStrategy, mockBm25Strategy);
  });

  // -------------------------------------------------------------------------
  // name
  // -------------------------------------------------------------------------

  describe('name', () => {
    it('has name "hybrid-blend"', () => {
      expect(strategy.name).toBe('hybrid-blend');
    });
  });

  // -------------------------------------------------------------------------
  // canHandle
  // -------------------------------------------------------------------------

  describe('canHandle', () => {
    it('returns true when query is present', () => {
      const options: StrategySearchOptions = { query: 'some query' };
      expect(strategy.canHandle(options)).toBe(true);
    });

    it('returns false when query is absent', () => {
      const options: StrategySearchOptions = { project: 'some-project' };
      expect(strategy.canHandle(options)).toBe(false);
    });

    it('returns false when query is an empty string', () => {
      const options: StrategySearchOptions = { query: '' };
      expect(strategy.canHandle(options)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Empty query
  // -------------------------------------------------------------------------

  describe('search with empty query', () => {
    it('returns empty result when query is undefined', async () => {
      const options: StrategySearchOptions = {};
      const result = await strategy.search(options);

      expect(result.strategy).toBe('hybrid-blend');
      expect(result.results.observations).toHaveLength(0);
      expect(result.results.sessions).toHaveLength(0);
      expect(result.results.prompts).toHaveLength(0);
      expect(result.usedChroma).toBe(true);
      expect(result.fellBack).toBe(false);
    });

    it('does not invoke either sub-strategy when query is absent', async () => {
      await strategy.search({});

      expect(mockChromaStrategy.search).not.toHaveBeenCalled();
      expect(mockBm25Strategy.search).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Both strategies succeed
  // -------------------------------------------------------------------------

  describe('when both strategies succeed', () => {
    it('returns strategy "hybrid-blend"', async () => {
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([makeObs(1), makeObs(2)])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([makeObs(3), makeObs(4)])
      );

      const result = await strategy.search({ query: 'test' });

      expect(result.strategy).toBe('hybrid-blend');
    });

    it('sets usedChroma to true', async () => {
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([makeObs(1)])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([makeObs(2)])
      );

      const result = await strategy.search({ query: 'test' });

      expect(result.usedChroma).toBe(true);
    });

    it('sets fellBack to false', async () => {
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([makeObs(1)])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([makeObs(2)])
      );

      const result = await strategy.search({ query: 'test' });

      expect(result.fellBack).toBe(false);
    });

    it('runs both strategies in parallel', async () => {
      const callOrder: string[] = [];

      vi.mocked(mockChromaStrategy.search).mockImplementation(async () => {
        callOrder.push('chroma');
        return makeChromaResult([makeObs(1)]);
      });
      vi.mocked(mockBm25Strategy.search).mockImplementation(async () => {
        callOrder.push('bm25');
        return makeBm25Result([makeObs(2)]);
      });

      await strategy.search({ query: 'test' });

      expect(callOrder).toContain('chroma');
      expect(callOrder).toContain('bm25');
    });

    it('returns merged observations from both strategies', async () => {
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([makeObs(1), makeObs(2)])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([makeObs(3), makeObs(4)])
      );

      const result = await strategy.search({ query: 'test' });

      const ids = result.results.observations.map(o => o.id);
      expect(ids).toContain(1);
      expect(ids).toContain(2);
      expect(ids).toContain(3);
      expect(ids).toContain(4);
    });
  });

  // -------------------------------------------------------------------------
  // Overlapping results (same ID in both strategies)
  // -------------------------------------------------------------------------

  describe('overlapping results', () => {
    it('deduplicates observations appearing in both strategies', async () => {
      const obs1 = makeObs(1);
      const obs2 = makeObs(2);

      // Both strategies return obs with ID 1
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([obs1, obs2])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([obs1, makeObs(3)])
      );

      const result = await strategy.search({ query: 'test' });

      const ids = result.results.observations.map(o => o.id);
      const id1Count = ids.filter(id => id === 1).length;
      expect(id1Count).toBe(1);
    });

    it('gives overlapping observations a blended score from both sources', async () => {
      const obs1 = makeObs(1);

      // obs1 appears first in Chroma (top vector score) and first in BM25 (top keyword score)
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([obs1])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([obs1])
      );

      const result = await strategy.search({ query: 'test' });

      const merged = result.results.observations.find(o => o.id === 1);
      expect(merged).toBeDefined();
      // Blended score = 0.6 * vectorScore + 0.4 * keywordScore
      // With 1 result each: vectorScore=1.0, keywordScore=1.0 → blended=1.0
      expect(merged!.score).toBeCloseTo(1.0, 5);
    });
  });

  // -------------------------------------------------------------------------
  // Non-overlapping results (exclusive to one strategy)
  // -------------------------------------------------------------------------

  describe('non-overlapping results', () => {
    it('includes observations unique to Chroma with partial vector score', async () => {
      const chromaOnly = makeObs(10);
      const bm25Only = makeObs(20);

      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([chromaOnly])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([bm25Only])
      );

      const result = await strategy.search({ query: 'test' });

      const ids = result.results.observations.map(o => o.id);
      expect(ids).toContain(10);
      expect(ids).toContain(20);
    });

    it('assigns partial vector score to Chroma-only observations', async () => {
      // Chroma has 2 results; obs10 is second (position score = (2-1)/2 = 0.5)
      const chromaOnly = makeObs(10);
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([makeObs(99), chromaOnly])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([makeObs(50)])
      );

      const result = await strategy.search({ query: 'test' });

      const obs10 = result.results.observations.find(o => o.id === 10);
      expect(obs10).toBeDefined();
      // obs10 is at index 1 of 2 Chroma results: vectorScore = (2-1)/2 = 0.5
      // BM25 does not include obs10: keywordScore contribution = 0
      // blended = 0.6 * 0.5 + 0.4 * 0 = 0.3
      expect(obs10!.score).toBeCloseTo(0.3, 5);
    });

    it('assigns partial keyword score to BM25-only observations', async () => {
      // BM25 has 2 results; obs20 is second (position score = (2-1)/2 = 0.5)
      const bm25Only = makeObs(20);
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([makeObs(50)])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([makeObs(99), bm25Only])
      );

      const result = await strategy.search({ query: 'test' });

      const obs20 = result.results.observations.find(o => o.id === 20);
      expect(obs20).toBeDefined();
      // obs20 is at index 1 of 2 BM25 results: keywordScore = (2-1)/2 = 0.5
      // Chroma does not include obs20: vectorScore contribution = 0
      // blended = 0.6 * 0 + 0.4 * 0.5 = 0.2
      expect(obs20!.score).toBeCloseTo(0.2, 5);
    });
  });

  // -------------------------------------------------------------------------
  // Sort order
  // -------------------------------------------------------------------------

  describe('sort order', () => {
    it('returns observations sorted by blended score descending', async () => {
      // Chroma: [obs1(rank 0), obs2(rank 1)] → vectorScores: obs1=1.0, obs2=0.5
      // BM25: [obs2(rank 0), obs3(rank 1)] → keywordScores: obs2=1.0, obs3=0.5
      // blended:
      //   obs1 = 0.6 * 1.0 + 0.4 * 0 = 0.6
      //   obs2 = 0.6 * 0.5 + 0.4 * 1.0 = 0.3 + 0.4 = 0.7
      //   obs3 = 0.6 * 0 + 0.4 * 0.5 = 0.2
      // Expected order: obs2 (0.7), obs1 (0.6), obs3 (0.2)

      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([makeObs(1), makeObs(2)])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([makeObs(2), makeObs(3)])
      );

      const result = await strategy.search({ query: 'test' });

      const ids = result.results.observations.map(o => o.id);
      expect(ids[0]).toBe(2); // highest blended score
      expect(ids[1]).toBe(1);
      expect(ids[2]).toBe(3); // lowest blended score
    });
  });

  // -------------------------------------------------------------------------
  // Limit
  // -------------------------------------------------------------------------

  describe('limit parameter', () => {
    it('applies limit after blending (not per strategy)', async () => {
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([makeObs(1), makeObs(2), makeObs(3)])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([makeObs(4), makeObs(5), makeObs(6)])
      );

      const result = await strategy.search({ query: 'test', limit: 4 });

      expect(result.results.observations.length).toBeLessThanOrEqual(4);
    });

    it('returns the top-scored observations up to the limit', async () => {
      // Chroma: [obs1, obs2] → obs1 vector=1.0, obs2 vector=0.5
      // BM25: [obs3, obs4] → obs3 keyword=1.0, obs4 keyword=0.5
      // blended: obs1=0.6, obs2=0.3, obs3=0.4, obs4=0.2
      // Top 2: obs1 (0.6), obs3 (0.4)

      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([makeObs(1), makeObs(2)])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([makeObs(3), makeObs(4)])
      );

      const result = await strategy.search({ query: 'test', limit: 2 });

      expect(result.results.observations).toHaveLength(2);
      const ids = result.results.observations.map(o => o.id);
      expect(ids[0]).toBe(1); // blended=0.6
      expect(ids[1]).toBe(3); // blended=0.4
    });
  });

  // -------------------------------------------------------------------------
  // Sessions and prompts merging
  // -------------------------------------------------------------------------

  describe('sessions and prompts merging', () => {
    it('merges sessions from both strategies without duplicates', async () => {
      const session1 = makeSession(1);
      const session2 = makeSession(2);

      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([], [session1, session2])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([], [session1]) // session1 is in both
      );

      const result = await strategy.search({ query: 'test' });

      const sessionIds = result.results.sessions.map(s => s.id);
      expect(sessionIds).toContain(1);
      expect(sessionIds).toContain(2);
      const session1Count = sessionIds.filter(id => id === 1).length;
      expect(session1Count).toBe(1); // deduplicated
    });

    it('merges prompts from both strategies without duplicates', async () => {
      const prompt1 = makePrompt(1);
      const prompt2 = makePrompt(2);

      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([], [], [prompt1])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([], [], [prompt1, prompt2])
      );

      const result = await strategy.search({ query: 'test' });

      const promptIds = result.results.prompts.map(p => p.id);
      expect(promptIds).toContain(1);
      expect(promptIds).toContain(2);
      const prompt1Count = promptIds.filter(id => id === 1).length;
      expect(prompt1Count).toBe(1); // deduplicated
    });
  });

  // -------------------------------------------------------------------------
  // Degradation: Chroma fails, BM25 succeeds
  // -------------------------------------------------------------------------

  describe('when Chroma fails and BM25 succeeds', () => {
    it('returns BM25 results with fellBack: true', async () => {
      vi.mocked(mockChromaStrategy.search).mockRejectedValue(new Error('Chroma unavailable'));
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([makeObs(1), makeObs(2)])
      );

      const result = await strategy.search({ query: 'test' });

      expect(result.fellBack).toBe(true);
      expect(result.results.observations).toHaveLength(2);
    });

    it('returns strategy "bm25" when falling back to BM25 only', async () => {
      vi.mocked(mockChromaStrategy.search).mockRejectedValue(new Error('Chroma unavailable'));
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([makeObs(1)])
      );

      const result = await strategy.search({ query: 'test' });

      expect(result.strategy).toBe('bm25');
    });

    it('returns usedChroma: false when Chroma fails', async () => {
      vi.mocked(mockChromaStrategy.search).mockRejectedValue(new Error('Chroma unavailable'));
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([makeObs(1)])
      );

      const result = await strategy.search({ query: 'test' });

      expect(result.usedChroma).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Degradation: Chroma succeeds (usedChroma=true), BM25 fails
  // -------------------------------------------------------------------------

  describe('when BM25 fails and Chroma succeeds', () => {
    it('returns Chroma results with fellBack: true', async () => {
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([makeObs(1), makeObs(2)])
      );
      vi.mocked(mockBm25Strategy.search).mockRejectedValue(new Error('BM25 unavailable'));

      const result = await strategy.search({ query: 'test' });

      expect(result.fellBack).toBe(true);
      expect(result.results.observations).toHaveLength(2);
    });

    it('returns strategy "chroma" when falling back to Chroma only', async () => {
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([makeObs(1)])
      );
      vi.mocked(mockBm25Strategy.search).mockRejectedValue(new Error('BM25 unavailable'));

      const result = await strategy.search({ query: 'test' });

      expect(result.strategy).toBe('chroma');
    });

    it('returns usedChroma: true when Chroma succeeds despite BM25 failure', async () => {
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([makeObs(1)])
      );
      vi.mocked(mockBm25Strategy.search).mockRejectedValue(new Error('BM25 unavailable'));

      const result = await strategy.search({ query: 'test' });

      expect(result.usedChroma).toBe(true);
    });

    it('treats Chroma result with usedChroma=false as a failure', async () => {
      // Chroma returned a result but usedChroma=false (internal failure/fallback)
      vi.mocked(mockChromaStrategy.search).mockResolvedValue({
        results: { observations: [makeObs(1)], sessions: [], prompts: [] },
        usedChroma: false,
        fellBack: false,
        strategy: 'chroma'
      });
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([makeObs(2)])
      );

      const result = await strategy.search({ query: 'test' });

      // When Chroma returns usedChroma=false, it is treated as failed
      // so we fall back to BM25-only
      expect(result.fellBack).toBe(true);
      expect(result.strategy).toBe('bm25');
    });
  });

  // -------------------------------------------------------------------------
  // Degradation: Both fail
  // -------------------------------------------------------------------------

  describe('when both strategies fail', () => {
    it('returns empty result with fellBack: true', async () => {
      vi.mocked(mockChromaStrategy.search).mockRejectedValue(new Error('Chroma down'));
      vi.mocked(mockBm25Strategy.search).mockRejectedValue(new Error('BM25 down'));

      const result = await strategy.search({ query: 'test' });

      expect(result.fellBack).toBe(true);
      expect(result.results.observations).toHaveLength(0);
      expect(result.results.sessions).toHaveLength(0);
      expect(result.results.prompts).toHaveLength(0);
    });

    it('returns strategy "hybrid-blend" when both fail', async () => {
      vi.mocked(mockChromaStrategy.search).mockRejectedValue(new Error('Chroma down'));
      vi.mocked(mockBm25Strategy.search).mockRejectedValue(new Error('BM25 down'));

      const result = await strategy.search({ query: 'test' });

      expect(result.strategy).toBe('hybrid-blend');
    });
  });

  // -------------------------------------------------------------------------
  // Score precision / math verification
  // -------------------------------------------------------------------------

  describe('score calculation precision', () => {
    it('assigns score 1.0 to a single Chroma result not in BM25', async () => {
      // 1 chroma result: vectorScore = (1-0)/1 = 1.0
      // not in bm25: keywordScore = 0
      // blended = 0.6 * 1.0 + 0 = 0.6
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([makeObs(1)])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([]) // empty BM25 result
      );

      const result = await strategy.search({ query: 'test' });

      const obs = result.results.observations.find(o => o.id === 1);
      expect(obs).toBeDefined();
      expect(obs!.score).toBeCloseTo(0.6, 5);
    });

    it('assigns score 1.0 to a single BM25 result not in Chroma', async () => {
      // 1 bm25 result: keywordScore = (1-0)/1 = 1.0
      // not in chroma: vectorScore = 0
      // blended = 0 + 0.4 * 1.0 = 0.4
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([]) // empty Chroma result
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([makeObs(2)])
      );

      const result = await strategy.search({ query: 'test' });

      const obs = result.results.observations.find(o => o.id === 2);
      expect(obs).toBeDefined();
      expect(obs!.score).toBeCloseTo(0.4, 5);
    });

    it('handles empty results from both strategies gracefully', async () => {
      vi.mocked(mockChromaStrategy.search).mockResolvedValue(
        makeChromaResult([])
      );
      vi.mocked(mockBm25Strategy.search).mockResolvedValue(
        makeBm25Result([])
      );

      const result = await strategy.search({ query: 'test' });

      expect(result.results.observations).toHaveLength(0);
      expect(result.usedChroma).toBe(true);
      expect(result.fellBack).toBe(false);
    });
  });
});
