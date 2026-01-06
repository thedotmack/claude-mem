import { describe, it, expect } from 'bun:test';
import { buildTimeline } from '../../src/services/context/index.js';
import type { Observation, SummaryTimelineItem } from '../../src/services/context/types.js';

/**
 * Timeline building tests - validates real sorting and merging logic
 *
 * Removed: queryObservations, querySummaries tests (mock database - not testing real behavior)
 * Kept: buildTimeline tests (tests actual sorting algorithm)
 */

// Helper to create a minimal observation
function createTestObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 1,
    memory_session_id: 'session-123',
    type: 'discovery',
    title: 'Test Observation',
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

// Helper to create a summary timeline item
function createTestSummaryTimelineItem(overrides: Partial<SummaryTimelineItem> = {}): SummaryTimelineItem {
  return {
    id: 1,
    memory_session_id: 'session-123',
    request: 'Test Request',
    investigated: 'Investigated things',
    learned: 'Learned things',
    completed: 'Completed things',
    next_steps: 'Next steps',
    created_at: '2025-01-01T12:00:00.000Z',
    created_at_epoch: 1735732800000,
    displayEpoch: 1735732800000,
    displayTime: '2025-01-01T12:00:00.000Z',
    shouldShowLink: false,
    ...overrides,
  };
}

describe('buildTimeline', () => {
    it('should combine observations and summaries into timeline', () => {
      const observations = [
        createTestObservation({ id: 1, created_at_epoch: 1000 }),
      ];
      const summaries = [
        createTestSummaryTimelineItem({ id: 1, displayEpoch: 2000 }),
      ];

      const timeline = buildTimeline(observations, summaries);

      expect(timeline).toHaveLength(2);
    });

    it('should sort timeline items chronologically by epoch', () => {
      const observations = [
        createTestObservation({ id: 1, created_at_epoch: 3000 }),
        createTestObservation({ id: 2, created_at_epoch: 1000 }),
      ];
      const summaries = [
        createTestSummaryTimelineItem({ id: 1, displayEpoch: 2000 }),
      ];

      const timeline = buildTimeline(observations, summaries);

      // Should be sorted: obs2 (1000), summary (2000), obs1 (3000)
      expect(timeline).toHaveLength(3);
      expect(timeline[0].type).toBe('observation');
      expect((timeline[0].data as Observation).id).toBe(2);
      expect(timeline[1].type).toBe('summary');
      expect(timeline[2].type).toBe('observation');
      expect((timeline[2].data as Observation).id).toBe(1);
    });

    it('should handle empty observations array', () => {
      const summaries = [
        createTestSummaryTimelineItem({ id: 1, displayEpoch: 1000 }),
      ];

      const timeline = buildTimeline([], summaries);

      expect(timeline).toHaveLength(1);
      expect(timeline[0].type).toBe('summary');
    });

    it('should handle empty summaries array', () => {
      const observations = [
        createTestObservation({ id: 1, created_at_epoch: 1000 }),
      ];

      const timeline = buildTimeline(observations, []);

      expect(timeline).toHaveLength(1);
      expect(timeline[0].type).toBe('observation');
    });

    it('should handle both empty arrays', () => {
      const timeline = buildTimeline([], []);

      expect(timeline).toHaveLength(0);
    });

    it('should correctly tag items with their type', () => {
      const observations = [createTestObservation()];
      const summaries = [createTestSummaryTimelineItem()];

      const timeline = buildTimeline(observations, summaries);

      const observationItem = timeline.find(item => item.type === 'observation');
      const summaryItem = timeline.find(item => item.type === 'summary');

      expect(observationItem).toBeDefined();
      expect(summaryItem).toBeDefined();
      expect(observationItem!.data).toHaveProperty('narrative');
      expect(summaryItem!.data).toHaveProperty('request');
    });

    it('should use displayEpoch for summary sorting, not created_at_epoch', () => {
      const observations = [
        createTestObservation({ id: 1, created_at_epoch: 2000 }),
      ];
      const summaries = [
        createTestSummaryTimelineItem({
          id: 1,
          created_at_epoch: 3000, // Created later
          displayEpoch: 1000,     // But displayed earlier
        }),
      ];

      const timeline = buildTimeline(observations, summaries);

      // Summary should come first because its displayEpoch is earlier
      expect(timeline[0].type).toBe('summary');
      expect(timeline[1].type).toBe('observation');
    });
});
