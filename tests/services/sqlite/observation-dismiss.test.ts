// Reversible observation dismiss — activates the reserved observation_feedback
// table (signal_type='dismissed'). A dismissed observation is hidden from every
// PROACTIVE surfacing path (file-context banner, SQLite search, session-start
// injection) but stays fully retrievable by id (get_observations). Undismiss
// restores it. The read filter is unconditional but a no-op with no dismiss rows.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { getObservationsByFilePath } from '../../../src/services/sqlite/observations/get.js';
import { queryObservations } from '../../../src/services/context/ObservationCompiler.js';
import type { ContextConfig } from '../../../src/services/context/types.js';

const PROJECT = 'dismiss-proj';
const TARGET_FILE = '/proj/src/target.ts';
const SEARCH_TOKEN = 'zqxwtoken';

// queryObservations only returns rows whose type is in observationTypes AND that
// carry a concept in observationConcepts — mirror the compiler test's config.
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

function ids(rows: Array<{ id: number }>): number[] {
  return rows.map(r => r.id).sort((a, b) => a - b);
}

describe('reversible observation dismiss', () => {
  let store: SessionStore;
  let search: SessionSearch;
  let visibleId: number;
  let dismissedId: number;

  function seed(mem: string, title: string, epoch: number): number {
    const sdkId = store.createSDKSession(`content-${mem}`, PROJECT, 'prompt');
    store.updateMemorySessionId(sdkId, mem);
    return store.storeObservation(
      mem,
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
    // Construct search before seeding so its FTS INSERT triggers index new rows
    // (mirrors search-platform-source-scoping.test.ts).
    search = new SessionSearch(store.db);
    visibleId = seed('mem-visible', 'Visible', 1_700_000_000_000);
    dismissedId = seed('mem-dismissed', 'Dismissed', 1_700_000_001_000);
  });

  afterEach(() => {
    store.close();
  });

  it('hides a dismissed observation from getObservationsByFilePath (file-context banner)', () => {
    expect(ids(getObservationsByFilePath(store.db, TARGET_FILE))).toEqual(ids([{ id: visibleId }, { id: dismissedId }]));

    store.dismissObservation(dismissedId);

    const after = getObservationsByFilePath(store.db, TARGET_FILE).map(o => o.id);
    expect(after).toContain(visibleId);
    expect(after).not.toContain(dismissedId);
  });

  it('hides a dismissed observation from searchObservations (FTS and filter-only paths)', () => {
    store.dismissObservation(dismissedId);

    const fts = search.searchObservations(SEARCH_TOKEN, { project: PROJECT }).map(o => o.id);
    expect(fts).toContain(visibleId);
    expect(fts).not.toContain(dismissedId);

    const filterOnly = search.searchObservations(undefined, { project: PROJECT }).map(o => o.id);
    expect(filterOnly).toContain(visibleId);
    expect(filterOnly).not.toContain(dismissedId);
  });

  it('hides a dismissed observation from the session-start context query', () => {
    store.dismissObservation(dismissedId);

    const surfaced = queryObservations(store, PROJECT, CONFIG).map(o => o.id);
    expect(surfaced).toContain(visibleId);
    expect(surfaced).not.toContain(dismissedId);
  });

  it('STILL returns a dismissed observation by id (dismiss = hide, not delete)', () => {
    store.dismissObservation(dismissedId, 'too noisy');

    expect(store.getObservationById(dismissedId)).not.toBeNull();
    expect(store.getObservationsByIds([dismissedId]).map(o => o.id)).toContain(dismissedId);
    // Fetching both ids returns both, dismissed or not.
    expect(ids(store.getObservationsByIds([visibleId, dismissedId]))).toEqual(ids([{ id: visibleId }, { id: dismissedId }]));
  });

  it('undismiss restores surfacing on every path', () => {
    store.dismissObservation(dismissedId);
    expect(store.isDismissed(dismissedId)).toBe(true);

    store.undismissObservation(dismissedId);
    expect(store.isDismissed(dismissedId)).toBe(false);

    expect(getObservationsByFilePath(store.db, TARGET_FILE).map(o => o.id)).toContain(dismissedId);
    expect(search.searchObservations(SEARCH_TOKEN, { project: PROJECT }).map(o => o.id)).toContain(dismissedId);
    expect(queryObservations(store, PROJECT, CONFIG).map(o => o.id)).toContain(dismissedId);
  });

  it('dismiss is idempotent — repeat dismiss writes exactly one feedback row', () => {
    store.dismissObservation(dismissedId, 'first');
    store.dismissObservation(dismissedId, 'second');

    const row = store.db
      .prepare("SELECT COUNT(*) AS c FROM observation_feedback WHERE observation_id = ? AND signal_type = 'dismissed'")
      .get(dismissedId) as { c: number };
    expect(row.c).toBe(1);
    expect(store.isDismissed(dismissedId)).toBe(true);
  });

  it('undismiss is a no-op when the observation was never dismissed', () => {
    expect(store.isDismissed(visibleId)).toBe(false);
    store.undismissObservation(visibleId); // must not throw
    expect(store.isDismissed(visibleId)).toBe(false);
  });

  it('read filter is a no-op with zero dismiss rows (byte-identical surfacing)', () => {
    const both = ids([{ id: visibleId }, { id: dismissedId }]);
    expect(ids(getObservationsByFilePath(store.db, TARGET_FILE))).toEqual(both);
    expect(ids(search.searchObservations(SEARCH_TOKEN, { project: PROJECT }))).toEqual(both);
    expect(ids(search.searchObservations(undefined, { project: PROJECT }))).toEqual(both);
    expect(ids(queryObservations(store, PROJECT, CONFIG))).toEqual(both);

    const feedback = store.db.prepare('SELECT COUNT(*) AS c FROM observation_feedback').get() as { c: number };
    expect(feedback.c).toBe(0);
  });
});
