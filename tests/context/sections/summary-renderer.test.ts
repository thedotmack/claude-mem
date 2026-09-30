import { describe, it, expect } from 'bun:test';
import { shouldShowSummary } from '../../../src/services/context/sections/SummaryRenderer.js';
import type { ContextConfig, Observation, SessionSummary } from '../../../src/services/context/types.js';

function createTestConfig(overrides: Partial<ContextConfig> = {}): ContextConfig {
  return {
    totalObservationCount: 10,
    fullObservationCount: 3,
    sessionCount: 3,
    showReadTokens: true,
    showWorkTokens: true,
    showSavingsAmount: true,
    showSavingsPercent: true,
    observationTypes: new Set(),
    observationConcepts: new Set(),
    fullObservationField: 'narrative',
    showLastSummary: true,
    showLastMessage: true,
    ...overrides,
  };
}

function createTestSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 1,
    memory_session_id: 'session-123',
    request: 'Test request',
    investigated: 'Investigated things',
    learned: 'Learned things',
    completed: 'Completed things',
    next_steps: 'Next steps',
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: 1735732800000,
    ...overrides,
  };
}

function createTestObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 1,
    memory_session_id: 'session-123',
    type: 'discovery',
    title: 'Test observation',
    subtitle: null,
    narrative: 'A test narrative',
    facts: '["fact1"]',
    concepts: '["concept1"]',
    files_read: null,
    files_modified: null,
    discovery_tokens: 100,
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: 1735732800000,
    ...overrides,
  };
}

describe('shouldShowSummary', () => {
  it('shows the last summary when its observation shares the same created_at_epoch (Issue: same-batch write)', () => {
    // storeObservations() stamps a session's final observations and its
    // summary with one shared timestampEpoch in the same insert transaction,
    // so on the very next session's context injection the newest observation
    // and the newest summary are routinely tied. That tie is not "newer work
    // happened after the summary" and must not hide it.
    const config = createTestConfig();
    const summary = createTestSummary({ created_at_epoch: 5000 });
    const observation = createTestObservation({ created_at_epoch: 5000 });

    expect(shouldShowSummary(config, summary, observation)).toBe(true);
  });

  it('hides the summary when a strictly newer observation exists', () => {
    const config = createTestConfig();
    const summary = createTestSummary({ created_at_epoch: 5000 });
    const observation = createTestObservation({ created_at_epoch: 6000 });

    expect(shouldShowSummary(config, summary, observation)).toBe(false);
  });

  it('shows the summary when it is newer than the most recent observation', () => {
    const config = createTestConfig();
    const summary = createTestSummary({ created_at_epoch: 6000 });
    const observation = createTestObservation({ created_at_epoch: 5000 });

    expect(shouldShowSummary(config, summary, observation)).toBe(true);
  });

  it('shows the summary when there is no observation to compare against', () => {
    const config = createTestConfig();
    const summary = createTestSummary();

    expect(shouldShowSummary(config, summary, undefined)).toBe(true);
  });

  it('respects showLastSummary=false regardless of timestamps', () => {
    const config = createTestConfig({ showLastSummary: false });
    const summary = createTestSummary();

    expect(shouldShowSummary(config, summary, undefined)).toBe(false);
  });

  it('hides an empty summary with no content fields', () => {
    const config = createTestConfig();
    const summary = createTestSummary({
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
    });

    expect(shouldShowSummary(config, summary, undefined)).toBe(false);
  });
});
