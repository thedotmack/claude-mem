import { describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { queryObservationsNewest, querySummariesMulti } from '../../src/services/context/ObservationCompiler.js';
import type { ContextConfig } from '../../src/services/context/types.js';

const config: ContextConfig = {
  totalObservationCount: 2, fullObservationCount: 0, sessionCount: 0,
  showReadTokens: false, showWorkTokens: false, showSavingsAmount: false,
  showSavingsPercent: false, observationTypes: new Set(['discovery']),
  observationConcepts: new Set(['how-it-works']), fullObservationField: 'narrative',
  showLastSummary: true, showLastMessage: false, mainAgentOnly: false,
};
const epoch = 1_700_000_000_000;

function setup() {
  const store = new SessionStore(':memory:');
  const id = store.createSDKSession('content', 'app', 'prompt');
  store.updateMemorySessionId(id, 'memory');
  return store;
}

function observation(store: SessionStore, title: string, project = 'app', createdAt = epoch): number {
  return store.storeObservation('memory', project, {
    type: 'discovery', title, subtitle: null, facts: [], narrative: title,
    concepts: ['how-it-works'], files_read: [], files_modified: [],
  }, 1, 0, createdAt).id;
}

function summary(store: SessionStore, request: string, project = 'app'): number {
  return store.storeSummary('memory', project, {
    request, investigated: 'investigated', learned: 'learned', completed: 'completed',
    next_steps: 'next steps', notes: null,
  }, 1, 0, epoch).id;
}

describe('context selection at equal timestamps', () => {
  it('keeps the latest rows from a turn before applying the project window', () => {
    const store = setup();
    try {
      observation(store, 'First finding');
      const second = observation(store, 'Second finding');
      const third = observation(store, 'Final finding');
      const newest = observation(store, 'Newer turn', 'app', epoch + 1);
      expect(queryObservationsNewest(store, config, { projects: ['app'], limit: 3 }).map(row => row.id))
        .toEqual([newest, third, second]);
    } finally { store.close(); }
  });

  it('uses the same ordering for house-wide and adopted-project observations', () => {
    const store = setup();
    try {
      observation(store, 'First adopted', 'old-app');
      const last = observation(store, 'Final adopted', 'old-app');
      store.db.exec("UPDATE observations SET merged_into_project = 'app'");
      expect(queryObservationsNewest(store, config, { limit: 1 }).map(row => row.id)).toEqual([last]);
      expect(queryObservationsNewest(store, config, { projects: ['app', 'old-app'], limit: 1 }).map(row => row.id))
        .toEqual([last]);
    } finally { store.close(); }
  });

  it('selects the same observation across project-key batches in either input order', () => {
    const store = setup();
    try {
      observation(store, 'Earlier row', 'early');
      const last = observation(store, 'Later row', 'late');
      observation(store, 'Out of scope', 'unrelated', epoch + 100);
      const projects = ['early', ...Array.from({ length: 249 }, (_, index) => `empty-${index}`), 'late'];
      for (const scope of [projects, [...projects].reverse()]) {
        expect(queryObservationsNewest(store, config, { projects: scope, limit: 1 }).map(row => row.id)).toEqual([last]);
      }
    } finally { store.close(); }
  });

  it('selects the latest summary before per-key and cross-batch caps', () => {
    const store = setup();
    try {
      summary(store, 'Earlier summary', 'early');
      const middle = summary(store, 'Later summary in the same key', 'early');
      expect(querySummariesMulti(store, ['early'], config).map(row => row.id)).toEqual([middle]);
      const last = summary(store, 'Latest summary', 'late');
      const projects = ['early', ...Array.from({ length: 249 }, (_, index) => `empty-${index}`), 'late'];
      for (const scope of [projects, [...projects].reverse()]) {
        expect(querySummariesMulti(store, scope, config).map(row => row.id)).toEqual([last]);
      }
    } finally { store.close(); }
  });
});
