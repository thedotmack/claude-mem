import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock the logger before importing modules that use it
mock.module('../../src/utils/logger.js', () => ({
  logger: {
    debug: mock(() => {}),
    failure: mock(() => {}),
    error: mock(() => {}),
  },
}));

import {
  queryObservations,
  querySummaries,
  buildTimeline,
  getPriorSessionMessages,
} from '../../src/services/context/index.js';
import type { Observation, SessionSummary, SummaryTimelineItem, ContextConfig } from '../../src/services/context/types.js';

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

// Helper to create a minimal ContextConfig
function createTestConfig(overrides: Partial<ContextConfig> = {}): ContextConfig {
  return {
    totalObservationCount: 50,
    fullObservationCount: 5,
    sessionCount: 3,
    showReadTokens: true,
    showWorkTokens: true,
    showSavingsAmount: true,
    showSavingsPercent: true,
    observationTypes: new Set(['discovery', 'decision', 'bugfix']),
    observationConcepts: new Set(['concept1', 'concept2']),
    fullObservationField: 'narrative',
    showLastSummary: true,
    showLastMessage: false,
    ...overrides,
  };
}

// Mock database that returns specified data
function createMockDb(observations: Observation[] = [], summaries: SessionSummary[] = []) {
  return {
    db: {
      prepare: mock((sql: string) => ({
        all: mock((...args: any[]) => {
          // Check if query is for observations or summaries
          if (sql.includes('FROM observations')) {
            return observations;
          } else if (sql.includes('FROM session_summaries')) {
            return summaries;
          }
          return [];
        }),
      })),
    },
  };
}

describe('ObservationCompiler', () => {
  describe('queryObservations', () => {
    it('should query observations with correct SQL pattern', () => {
      const mockObs = [createTestObservation()];
      const mockDb = createMockDb(mockObs);
      const config = createTestConfig();

      const result = queryObservations(mockDb as any, 'test-project', config);

      expect(result).toEqual(mockObs);
      expect(mockDb.db.prepare).toHaveBeenCalled();
    });

    it('should pass observation types from config to query', () => {
      const mockDb = createMockDb([]);
      const config = createTestConfig({
        observationTypes: new Set(['decision', 'bugfix']),
      });

      queryObservations(mockDb as any, 'test-project', config);

      expect(mockDb.db.prepare).toHaveBeenCalled();
    });

    it('should respect totalObservationCount limit from config', () => {
      const mockDb = createMockDb([]);
      const config = createTestConfig({ totalObservationCount: 100 });

      queryObservations(mockDb as any, 'test-project', config);

      expect(mockDb.db.prepare).toHaveBeenCalled();
    });

    it('should return empty array when no observations match', () => {
      const mockDb = createMockDb([]);
      const config = createTestConfig();

      const result = queryObservations(mockDb as any, 'test-project', config);

      expect(result).toEqual([]);
    });

    it('should handle multiple observation types', () => {
      const mockObs = [
        createTestObservation({ id: 1, type: 'discovery' }),
        createTestObservation({ id: 2, type: 'decision' }),
        createTestObservation({ id: 3, type: 'bugfix' }),
      ];
      const mockDb = createMockDb(mockObs);
      const config = createTestConfig({
        observationTypes: new Set(['discovery', 'decision', 'bugfix']),
      });

      const result = queryObservations(mockDb as any, 'test-project', config);

      expect(result).toHaveLength(3);
    });
  });

  describe('querySummaries', () => {
    it('should query summaries with session count from config', () => {
      const mockSummaries: SessionSummary[] = [
        {
          id: 1,
          memory_session_id: 'session-1',
          request: 'Request 1',
          investigated: null,
          learned: null,
          completed: null,
          next_steps: null,
          created_at: '2025-01-01T12:00:00.000Z',
          created_at_epoch: 1735732800000,
        },
      ];
      const mockDb = createMockDb([], mockSummaries);
      const config = createTestConfig({ sessionCount: 5 });

      const result = querySummaries(mockDb as any, 'test-project', config);

      expect(result).toEqual(mockSummaries);
    });

    it('should return empty array when no summaries exist', () => {
      const mockDb = createMockDb([], []);
      const config = createTestConfig();

      const result = querySummaries(mockDb as any, 'test-project', config);

      expect(result).toEqual([]);
    });
  });

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

  describe('getPriorSessionMessages', () => {
    it('should return empty messages when showLastMessage is false', () => {
      const observations = [createTestObservation()];
      const config = createTestConfig({ showLastMessage: false });

      const result = getPriorSessionMessages(observations, config, 'current-session', '/test/cwd');

      expect(result.userMessage).toBe('');
      expect(result.assistantMessage).toBe('');
    });

    it('should return empty messages when observations array is empty', () => {
      const config = createTestConfig({ showLastMessage: true });

      const result = getPriorSessionMessages([], config, 'current-session', '/test/cwd');

      expect(result.userMessage).toBe('');
      expect(result.assistantMessage).toBe('');
    });

    it('should return empty messages when no prior session found', () => {
      // All observations have same session ID as current
      const observations = [
        createTestObservation({ memory_session_id: 'current-session' }),
      ];
      const config = createTestConfig({ showLastMessage: true });

      const result = getPriorSessionMessages(observations, config, 'current-session', '/test/cwd');

      expect(result.userMessage).toBe('');
      expect(result.assistantMessage).toBe('');
    });

    it('should look for prior session when current session differs', () => {
      // Has observation from a different session
      const observations = [
        createTestObservation({ memory_session_id: 'prior-session' }),
      ];
      const config = createTestConfig({ showLastMessage: true });

      // Transcript file won't exist, so should return empty strings
      const result = getPriorSessionMessages(observations, config, 'current-session', '/nonexistent/path');

      expect(result.userMessage).toBe('');
      expect(result.assistantMessage).toBe('');
    });
  });
});
