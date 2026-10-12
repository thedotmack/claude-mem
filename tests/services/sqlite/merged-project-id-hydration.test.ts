import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

describe('merged project ID hydration', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function seedObservation(memorySessionId: string, project: string, title: string): number {
    const sdkSessionId = store.createSDKSession(`content-${memorySessionId}`, project, 'prompt');
    store.ensureMemorySessionIdRegistered(sdkSessionId, memorySessionId);
    const result = store.storeObservations(memorySessionId, project, [{
      type: 'discovery',
      title,
      subtitle: null,
      facts: [],
      narrative: `${title} narrative`,
      concepts: [],
      files_read: [],
      files_modified: [],
    }], null, 1, 0, 1_700_000_000_000);
    return result.observationIds[0];
  }

  function seedSummary(memorySessionId: string, project: string, request: string): number {
    const sdkSessionId = store.createSDKSession(`content-${memorySessionId}`, project, 'prompt');
    store.ensureMemorySessionIdRegistered(sdkSessionId, memorySessionId);
    return store.importSessionSummary({
      memory_session_id: memorySessionId,
      project,
      request,
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      files_read: null,
      files_edited: null,
      notes: null,
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(1_700_000_000_000).toISOString(),
      created_at_epoch: 1_700_000_000_000,
    }).id;
  }

  it('hydrates a redirected observation by ID under the merged parent project', () => {
    const observationId = seedObservation('merged-observation', 'parent/worktree', 'redirected observation');
    store.db.prepare('UPDATE observations SET merged_into_project = ? WHERE id = ?').run('parent', observationId);

    const results = store.getObservationsByIds([observationId], { orderBy: 'relevance', project: 'parent' });

    expect(results.map(result => result.id)).toEqual([observationId]);
  });

  it('hydrates a redirected session summary by ID under the merged parent project', () => {
    const summaryId = seedSummary('merged-summary', 'parent/worktree', 'redirected summary');
    store.db.prepare('UPDATE session_summaries SET merged_into_project = ? WHERE id = ?').run('parent', summaryId);

    const results = store.getSessionSummariesByIds([summaryId], { orderBy: 'relevance', project: 'parent' });

    expect(results.map(result => result.id)).toEqual([summaryId]);
  });

  it('keeps native rows in and foreign rows out while widening merged-project hydration', () => {
    const nativeObservationId = seedObservation('native-observation', 'parent', 'native observation');
    const foreignObservationId = seedObservation('foreign-observation', 'other', 'foreign observation');
    const nativeSummaryId = seedSummary('native-summary', 'parent', 'native summary');
    const foreignSummaryId = seedSummary('foreign-summary', 'other', 'foreign summary');

    expect(store.getObservationsByIds([nativeObservationId, foreignObservationId], { orderBy: 'relevance', project: 'parent' }).map(result => result.id))
      .toEqual([nativeObservationId]);
    expect(store.getSessionSummariesByIds([nativeSummaryId, foreignSummaryId], { orderBy: 'relevance', project: 'parent' }).map(result => result.id))
      .toEqual([nativeSummaryId]);
  });

  it('keeps redirected timeline context under the merged parent project', () => {
    const observationId = seedObservation('timeline-observation', 'parent/worktree', 'redirected observation');
    const summaryId = seedSummary('timeline-summary', 'parent/worktree', 'redirected summary');
    store.db.prepare('UPDATE observations SET merged_into_project = ? WHERE id = ?').run('parent', observationId);
    store.db.prepare('UPDATE session_summaries SET merged_into_project = ? WHERE id = ?').run('parent', summaryId);

    const timeline = store.getTimelineAroundObservation(
      observationId,
      1_700_000_000_000,
      0,
      0,
      'parent'
    );

    expect(timeline.observations.map(result => result.id)).toEqual([observationId]);
    expect(timeline.sessions.map(result => result.id)).toEqual([summaryId]);
    expect(timeline.prompts).toEqual([]);
  });

  it('keeps prompt hydration native-session scoped on this target', () => {
    const parentSessionId = store.createSDKSession('parent-prompt-session', 'parent', 'prompt');
    const foreignSessionId = store.createSDKSession('foreign-prompt-session', 'other', 'prompt');
    const parentPromptId = store.saveUserPrompt('parent-prompt-session', 1, 'parent prompt', parentSessionId);
    const foreignPromptId = store.saveUserPrompt('foreign-prompt-session', 1, 'foreign prompt', foreignSessionId);

    const results = store.getUserPromptsByIds([parentPromptId, foreignPromptId], { orderBy: 'relevance', project: 'parent' });

    expect(results.map(result => result.id)).toEqual([parentPromptId]);
  });
});
