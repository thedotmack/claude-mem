import { describe, it, expect } from 'bun:test';

import {
  applyTokenBudget,
  calculateSummaryTokens,
  calculateObservationTokens,
  calculateTokenEconomics,
} from '../../src/services/context/TokenCalculator.js';
import type { Observation, SessionSummary } from '../../src/services/context/types.js';

function createTestObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 1,
    memory_session_id: 'session-123',
    type: 'discovery',
    title: null,
    subtitle: null,
    narrative: null,
    facts: null,
    concepts: null,
    files_read: null,
    files_modified: null,
    discovery_tokens: null,
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: 1735732800000,
    ...overrides,
  };
}

function createTestSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    memory_session_id: 'session-123',
    request: null,
    investigated: null,
    learned: null,
    completed: null,
    next_steps: null,
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: 1735732800000,
    ...overrides,
  };
}

describe('calculateSummaryTokens', () => {
  it('should return 0 for a summary with no content', () => {
    expect(calculateSummaryTokens(createTestSummary())).toBe(0);
  });

  it('should sum the chars/4 estimate across all summary fields', () => {
    const summary = createTestSummary({
      request: 'A'.repeat(40),      // 10 tokens
      investigated: 'B'.repeat(20), // 5 tokens
      learned: 'C'.repeat(8),       // 2 tokens
      completed: 'D'.repeat(4),     // 1 token
      next_steps: 'E'.repeat(12),   // 3 tokens
    });
    expect(calculateSummaryTokens(summary)).toBe(21);
  });
});

describe('applyTokenBudget', () => {
  // Newest-first ordering, matching the ORDER BY created_at_epoch DESC query.
  const newestObservation = createTestObservation({ id: 3, title: 'A'.repeat(400) }); // ~101 tokens
  const middleObservation = createTestObservation({ id: 2, title: 'B'.repeat(400) }); // ~101 tokens
  const oldestObservation = createTestObservation({ id: 1, title: 'C'.repeat(400) }); // ~101 tokens
  const observations = [newestObservation, middleObservation, oldestObservation];

  it('should not trim when budget is 0 (unlimited, and what full=true sets)', () => {
    const result = applyTokenBudget(observations, [], 0);

    expect(result.observations).toEqual(observations);
    expect(result.observationsTrimmedByBudget).toBe(0);
  });

  it('should not trim when budget covers everything', () => {
    const result = applyTokenBudget(observations, [], 100000);

    expect(result.observations).toEqual(observations);
    expect(result.observationsTrimmedByBudget).toBe(0);
  });

  it('should always keep the newest observation even when it exceeds the budget', () => {
    const result = applyTokenBudget(observations, [], 1);

    expect(result.observations).toEqual([newestObservation]);
    expect(result.observationsTrimmedByBudget).toBe(2);
  });

  it('should keep totalReadTokens within budget when trimming past the newest', () => {
    const budget = 250; // fits two ~101-token observations, not three
    const result = applyTokenBudget(observations, [], budget);

    expect(result.observations).toEqual([newestObservation, middleObservation]);
    expect(result.observationsTrimmedByBudget).toBe(1);
    expect(calculateTokenEconomics(result.observations).totalReadTokens).toBeLessThanOrEqual(budget);
  });

  it('should charge summaries against the budget before observations', () => {
    const budget = 250;
    const summary = createTestSummary({ request: 'S'.repeat(500) }); // 125 tokens

    const withoutSummary = applyTokenBudget(observations, [], budget);
    const withSummary = applyTokenBudget(observations, [summary], budget);

    expect(withoutSummary.observations.length).toBe(2);
    expect(withSummary.observations).toEqual([newestObservation]);
    expect(withSummary.observationsTrimmedByBudget).toBe(2);
  });

  it('should greedy-fill: skip an observation that does not fit but keep a smaller older one', () => {
    const smallOldest = createTestObservation({ id: 1, title: 'C'.repeat(40) }); // ~11 tokens
    const mixed = [newestObservation, middleObservation, smallOldest];
    const budget = 120; // newest (~101) fits, middle (~101) does not, small oldest (~11) does

    const result = applyTokenBudget(mixed, [], budget);

    expect(result.observations).toEqual([newestObservation, smallOldest]);
    expect(result.observationsTrimmedByBudget).toBe(1);
    expect(calculateTokenEconomics(result.observations).totalReadTokens).toBeLessThanOrEqual(budget);
  });

  it('should preserve newest-first ordering in the kept set', () => {
    const result = applyTokenBudget(observations, [], 250);

    expect(result.observations.map(obs => obs.id)).toEqual([3, 2]);
  });

  it('should sanity-check per-observation sizes used above', () => {
    expect(calculateObservationTokens(newestObservation)).toBe(101);
  });

  it('should handle an empty observation list', () => {
    const result = applyTokenBudget([], [createTestSummary({ request: 'S'.repeat(500) })], 10);

    expect(result.observations).toEqual([]);
    expect(result.observationsTrimmedByBudget).toBe(0);
  });
});
