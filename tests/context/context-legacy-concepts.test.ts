import { expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { queryObservationsMulti, queryObservationsNewest } from '../../src/services/context/ObservationCompiler.js';
import type { ContextConfig } from '../../src/services/context/types.js';

const config: ContextConfig = {
  totalObservationCount: 20, fullObservationCount: 0, sessionCount: 1,
  showReadTokens: false, showWorkTokens: false,
  observationTypes: new Set(['discovery']), observationConcepts: new Set(['缓存']),
  fullObservationField: 'narrative', showLastSummary: true,
  showLastMessage: false, mainAgentOnly: false,
};

it('injects legacy string concepts alongside arrays, matching the keyword reader', () => {
  const store = new SessionStore(':memory:');
  try {
    const sid = store.createSDKSession('content', 'project', 'prompt');
    store.ensureMemorySessionIdRegistered(sid, 'memory');
    const matching: number[] = [];
    const ids: number[] = [];
    for (const [index, concepts] of ['缓存', '"缓存"', '["缓存"]', '[null,{"topic":"cache"},"缓存"]', null, '[]', 'other'].entries()) {
      const id = store.storeObservation('memory', 'project', {
        type: 'discovery', title: `row ${index}`, subtitle: null,
        narrative: 'cache', facts: [], concepts: [], files_read: [], files_modified: [],
      }, index + 1).id;
      store.db.run('UPDATE observations SET concepts = ? WHERE id = ?', [concepts, id]);
      ids.push(id);
      if (index < 4) matching.push(id);
    }
    const sorted = (rows: { id: number }[]) => rows.map(row => row.id).sort((a, b) => a - b);
    expect(sorted(store.getObservationsByIds(ids, { project: 'project', concepts: ['缓存'] }))).toEqual(matching);
    expect(sorted(queryObservationsMulti(store, ['project'], config))).toEqual(matching);
    expect(sorted(queryObservationsNewest(store, config, { limit: 20 }))).toEqual(matching);
    expect(queryObservationsMulti(store, ['other-project'], config)).toEqual([]);
    expect(queryObservationsMulti(store, ['project'], {
      ...config, observationConcepts: new Set(['{"topic":"cache"}']),
    })).toEqual([]);
  } finally {
    store.close();
  }
});
