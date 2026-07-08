import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { getObservationsByFilePath } from '../../../src/services/sqlite/observations/get.js';
import { queryObservationsMulti } from '../../../src/services/context/ObservationCompiler.js';
import type { ContextConfig } from '../../../src/services/context/types.js';

const PROJECT = 'dismiss-proj';
const TARGET_FILE = '/proj/src/target.ts';
const SEARCH_TOKEN = 'zqxwtoken';

const CONFIG: ContextConfig = {
  totalObservationCount: 50,
  fullObservationCount: 3,
  sessionCount: 20,
  showReadTokens: true,
  showWorkTokens: true,
  showSavingsAmount: true,
  showSavingsPercent: true,
  observationTypes: new Set(['discovery']),
  observationConcepts: new Set(['dismiss-test']),
  fullObservationField: 'narrative',
  showLastSummary: true,
  showLastMessage: false,
};

function sortedIds(rows: Array<{ id: number }>): number[] {
  return rows.map(r => r.id).sort((a, b) => a - b);
}

describe('reversible observation dismiss', () => {
  let store: SessionStore;
  let search: SessionSearch;
  let visibleId: number;
  let dismissedId: number;

  function seed(memorySessionId: string, title: string, epoch: number): number {
    const sdkId = store.createSDKSession(`content-${memorySessionId}`, PROJECT, 'prompt');
    store.updateMemorySessionId(sdkId, memorySessionId);
    return store.storeObservation(
      memorySessionId,
      PROJECT,
      {
        type: 'discovery',
        title,
        subtitle: null,
        facts: [],
        narrative: `narrative ${title} ${SEARCH_TOKEN}`,
        concepts: ['dismiss-test'],
        files_read: [TARGET_FILE],
        files_modified: [],
      },
      1,
      0,
      epoch,
    ).id;
  }

  beforeEach(() => {
    store = new SessionStore(':memory:');
    search = new SessionSearch(store.db);
    visibleId = seed('mem-visible', 'Visible', 1_700_000_000_000);
    dismissedId = seed('mem-dismissed', 'Dismissed', 1_700_000_001_000);
  });

  afterEach(() => {
    store.close();
  });

  it('hides dismissed observations from file-context lookup', () => {
    expect(sortedIds(getObservationsByFilePath(store.db, TARGET_FILE))).toEqual(sortedIds([{ id: visibleId }, { id: dismissedId }]));

    store.dismissObservation(dismissedId);

    const after = getObservationsByFilePath(store.db, TARGET_FILE).map(o => o.id);
    expect(after).toContain(visibleId);
    expect(after).not.toContain(dismissedId);
  });

  it('hides dismissed observations from FTS and filter-only search', () => {
    store.dismissObservation(dismissedId);

    const fts = search.searchObservations(SEARCH_TOKEN, { project: PROJECT }).map(o => o.id);
    expect(fts).toContain(visibleId);
    expect(fts).not.toContain(dismissedId);

    const filterOnly = search.searchObservations(undefined, { project: PROJECT }).map(o => o.id);
    expect(filterOnly).toContain(visibleId);
    expect(filterOnly).not.toContain(dismissedId);
  });

  it('hides dismissed observations from session-start context', () => {
    store.dismissObservation(dismissedId);

    const surfaced = queryObservationsMulti(store, [PROJECT], CONFIG).map(o => o.id);
    expect(surfaced).toContain(visibleId);
    expect(surfaced).not.toContain(dismissedId);
  });

  it('keeps dismissed observations addressable by id', () => {
    store.dismissObservation(dismissedId, 'too noisy');

    expect(store.getObservationById(dismissedId)).not.toBeNull();
    expect(store.getObservationsByIds([dismissedId]).map(o => o.id)).toContain(dismissedId);
    expect(sortedIds(store.getObservationsByIds([visibleId, dismissedId]))).toEqual(sortedIds([{ id: visibleId }, { id: dismissedId }]));
  });

  it('undismiss restores proactive surfacing', () => {
    store.dismissObservation(dismissedId);
    expect(store.isDismissed(dismissedId)).toBe(true);

    store.undismissObservation(dismissedId);
    expect(store.isDismissed(dismissedId)).toBe(false);

    expect(getObservationsByFilePath(store.db, TARGET_FILE).map(o => o.id)).toContain(dismissedId);
    expect(search.searchObservations(SEARCH_TOKEN, { project: PROJECT }).map(o => o.id)).toContain(dismissedId);
    expect(queryObservationsMulti(store, [PROJECT], CONFIG).map(o => o.id)).toContain(dismissedId);
  });

  it('dismiss is idempotent', () => {
    store.dismissObservation(dismissedId, 'first');
    store.dismissObservation(dismissedId, 'second');

    const row = store.db
      .prepare("SELECT COUNT(*) AS count FROM observation_feedback WHERE observation_id = ? AND signal_type = 'dismissed'")
      .get(dismissedId) as { count: number };
    expect(row.count).toBe(1);
  });

  it('read filter is a no-op with zero dismiss rows', () => {
    const both = sortedIds([{ id: visibleId }, { id: dismissedId }]);
    expect(sortedIds(getObservationsByFilePath(store.db, TARGET_FILE))).toEqual(both);
    expect(sortedIds(search.searchObservations(SEARCH_TOKEN, { project: PROJECT }))).toEqual(both);
    expect(sortedIds(search.searchObservations(undefined, { project: PROJECT }))).toEqual(both);
    expect(sortedIds(queryObservationsMulti(store, [PROJECT], CONFIG))).toEqual(both);

    const feedback = store.db.prepare('SELECT COUNT(*) AS count FROM observation_feedback').get() as { count: number };
    expect(feedback.count).toBe(0);
  });
});
