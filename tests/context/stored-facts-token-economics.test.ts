import { describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { queryObservationsNewest } from '../../src/services/context/ObservationCompiler.js';
import { calculateTokenEconomics } from '../../src/services/context/TokenCalculator.js';
import { observationTokenEconomics } from '../../src/services/prompt-import/token-usage.js';
import type { ContextConfig } from '../../src/services/context/types.js';

const config: ContextConfig = {
  totalObservationCount: 10, fullObservationCount: 0, sessionCount: 0,
  showReadTokens: true, showWorkTokens: true,
  observationTypes: new Set(['discovery']), observationConcepts: new Set(['how-it-works']),
  fullObservationField: 'facts', showLastSummary: false, showLastMessage: false, mainAgentOnly: false,
};

function setup(facts: string[]) {
  const store = new SessionStore(':memory:');
  const session = store.createSDKSession('token-content', 'token-project', 'Save settings');
  store.updateMemorySessionId(session, 'token-memory');
  const { id } = store.storeObservation('token-memory', 'token-project', {
    type: 'discovery', title: 'Path', subtitle: null, narrative: 'Keep it.', facts,
    concepts: ['how-it-works'], files_read: [], files_modified: [],
  }, 1, 100);
  return { store, id };
}

describe('token economics from persisted observations', () => {
  it('counts stored quotes and backslashes once in both setup and context', () => {
    const facts = ['Use "cache".', 'C:\\temp'];
    const { store } = setup(facts);
    try {
      const rows = queryObservationsNewest(store, config, { projects: ['token-project'], limit: 10 });
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].facts!)).toEqual(facts);
      // Four title + eight narrative + 29 stored JSON characters = 41 chars.
      // The shared four-characters-per-token estimate rounds that up to 11.
      expect(rows[0].facts!.length).toBe(29);
      const expected = { totalObservations: 1, totalReadTokens: 11, totalDiscoveryTokens: 100, savings: 89, savingsPercent: 89 };
      expect(calculateTokenEconomics(rows)).toEqual(expected);
      expect(observationTokenEconomics(store.streamObservationTokenFields(), 1)).toEqual(expected);
    } finally { store.close(); }
  });

  it('does not invent an empty facts array for legacy NULL facts', () => {
    const { store, id } = setup([]);
    try {
      store.db.prepare('UPDATE observations SET facts = NULL WHERE id = ?').run(id);
      const expected = { totalObservations: 1, totalReadTokens: 3, totalDiscoveryTokens: 100, savings: 97, savingsPercent: 97 };
      expect(observationTokenEconomics(store.streamObservationTokenFields())).toEqual(expected);
      const rows = queryObservationsNewest(store, config, { projects: ['token-project'], limit: 10 });
      expect(calculateTokenEconomics(rows)).toEqual(expected);
    } finally { store.close(); }
  });
});
