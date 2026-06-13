import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { buildTimeline } from '../../src/services/context/index.js';
import {
  queryObservations,
  queryObservationsMulti,
  querySummaries,
  querySummariesMulti,
} from '../../src/services/context/ObservationCompiler.js';
import type {
  ContextConfig,
  Observation,
  SummaryTimelineItem,
} from '../../src/services/context/types.js';

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

const queryConfig: ContextConfig = {
  totalObservationCount: 20,
  fullObservationCount: 0,
  sessionCount: 20,
  showReadTokens: false,
  showWorkTokens: false,
  showSavingsAmount: false,
  showSavingsPercent: false,
  observationTypes: new Set(['discovery']),
  observationConcepts: new Set(['gotcha']),
  fullObservationField: 'narrative',
  showLastSummary: true,
  showLastMessage: false,
};

function iso(epoch: number): string {
  return new Date(epoch).toISOString();
}

function seedSession(
  store: SessionStore,
  contentSessionId: string,
  memorySessionId: string,
  project: string,
  startedAtEpoch: number
): void {
  store.importSdkSession({
    content_session_id: contentSessionId,
    memory_session_id: memorySessionId,
    project,
    user_prompt: `Prompt for ${memorySessionId}`,
    started_at: iso(startedAtEpoch),
    started_at_epoch: startedAtEpoch,
    completed_at: iso(startedAtEpoch + 1),
    completed_at_epoch: startedAtEpoch + 1,
    status: 'completed',
  });
}

function seedObservation(
  store: SessionStore,
  memorySessionId: string,
  project: string,
  title: string,
  createdAtEpoch: number
): number {
  return store.importObservation({
    memory_session_id: memorySessionId,
    project,
    text: null,
    type: 'discovery',
    title,
    subtitle: null,
    facts: '["fact"]',
    narrative: `${title} narrative`,
    concepts: '["gotcha"]',
    files_read: null,
    files_modified: null,
    prompt_number: 1,
    discovery_tokens: 10,
    created_at: iso(createdAtEpoch),
    created_at_epoch: createdAtEpoch,
  }).id;
}

function seedSummary(
  store: SessionStore,
  memorySessionId: string,
  project: string,
  request: string,
  createdAtEpoch: number
): number {
  return store.importSessionSummary({
    memory_session_id: memorySessionId,
    project,
    request,
    investigated: null,
    learned: null,
    completed: `${request} completed`,
    next_steps: null,
    files_read: null,
    files_edited: null,
    notes: null,
    prompt_number: 1,
    discovery_tokens: 0,
    created_at: iso(createdAtEpoch),
    created_at_epoch: createdAtEpoch,
  }).id;
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

      expect(timeline[0].type).toBe('summary');
      expect(timeline[1].type).toBe('observation');
    });
});

describe('session-scoped context queries', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('filters single-project observations and summaries by memory session when provided', () => {
    const project = 'shared-project';

    seedSession(store, 'content-a', 'session-a', project, 1_700_000_000_000);
    seedSession(store, 'content-b', 'session-b', project, 1_700_000_010_000);

    seedObservation(store, 'session-a', project, 'Session A observation', 1_700_000_020_000);
    seedObservation(store, 'session-b', project, 'Session B observation', 1_700_000_030_000);
    seedSummary(store, 'session-a', project, 'Session A summary', 1_700_000_040_000);
    seedSummary(store, 'session-b', project, 'Session B summary', 1_700_000_050_000);

    const scopedObservations = queryObservations(store, project, queryConfig, 'session-a');
    const scopedSummaries = querySummaries(store, project, queryConfig, 'session-a');
    const legacyObservations = queryObservations(store, project, queryConfig);
    const legacySummaries = querySummaries(store, project, queryConfig);

    expect(scopedObservations.map(obs => obs.title)).toEqual(['Session A observation']);
    expect(scopedSummaries.map(summary => summary.request)).toEqual(['Session A summary']);
    expect(legacyObservations.map(obs => obs.title)).toEqual([
      'Session B observation',
      'Session A observation',
    ]);
    expect(legacySummaries.map(summary => summary.request)).toEqual([
      'Session B summary',
      'Session A summary',
    ]);
  });

  it('filters multi-project observations and summaries by memory session without changing project selection', () => {
    const parentProject = 'shared-project';
    const worktreeProject = 'shared-project/worktree-a';
    const projects = [parentProject, worktreeProject];

    seedSession(store, 'content-a', 'session-a', worktreeProject, 1_700_000_100_000);
    seedSession(store, 'content-b', 'session-b', worktreeProject, 1_700_000_110_000);

    const sessionAObservationId = seedObservation(
      store,
      'session-a',
      worktreeProject,
      'Session A worktree observation',
      1_700_000_120_000
    );
    const sessionBObservationId = seedObservation(
      store,
      'session-b',
      worktreeProject,
      'Session B worktree observation',
      1_700_000_130_000
    );
    const sessionASummaryId = seedSummary(
      store,
      'session-a',
      worktreeProject,
      'Session A worktree summary',
      1_700_000_140_000
    );
    const sessionBSummaryId = seedSummary(
      store,
      'session-b',
      worktreeProject,
      'Session B worktree summary',
      1_700_000_150_000
    );

    store.db.prepare('UPDATE observations SET merged_into_project = ? WHERE id IN (?, ?)')
      .run(parentProject, sessionAObservationId, sessionBObservationId);
    store.db.prepare('UPDATE session_summaries SET merged_into_project = ? WHERE id IN (?, ?)')
      .run(parentProject, sessionASummaryId, sessionBSummaryId);

    const scopedObservations = queryObservationsMulti(store, projects, queryConfig, 'session-a');
    const scopedSummaries = querySummariesMulti(store, projects, queryConfig, 'session-a');
    const legacyObservations = queryObservationsMulti(store, projects, queryConfig);
    const legacySummaries = querySummariesMulti(store, projects, queryConfig);

    expect(scopedObservations.map(obs => obs.title)).toEqual(['Session A worktree observation']);
    expect(scopedSummaries.map(summary => summary.request)).toEqual(['Session A worktree summary']);
    expect(legacyObservations.map(obs => obs.title)).toEqual([
      'Session B worktree observation',
      'Session A worktree observation',
    ]);
    expect(legacySummaries.map(summary => summary.request)).toEqual([
      'Session B worktree summary',
      'Session A worktree summary',
    ]);
  });
});
