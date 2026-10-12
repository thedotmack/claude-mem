// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { queryObservationsMulti, queryObservationsNewest } from '../../src/services/context/ObservationCompiler.js';
import type { ContextConfig } from '../../src/services/context/types.js';

const DAY = 86_400_000;
const NOW = Date.now();
const PROJECT = 'reinforce-project';

function config(reinforcementAlpha?: number): ContextConfig {
  return {
    totalObservationCount: 4,
    fullObservationCount: 0,
    sessionCount: 10,
    showReadTokens: true,
    showWorkTokens: true,
    showSavingsAmount: true,
    showSavingsPercent: true,
    observationTypes: new Set(['discovery']),
    observationConcepts: new Set(['reinforce-scope']),
    fullObservationField: 'narrative',
    showLastSummary: true,
    showLastMessage: false,
    mainAgentOnly: true,
    reinforcementAlpha,
  };
}

function observation(title: string) {
  return {
    type: 'discovery',
    title,
    subtitle: null,
    facts: [],
    narrative: `${title} narrative`,
    concepts: ['reinforce-scope'],
    files_read: [],
    files_modified: [],
  };
}

/**
 * Ten observations, one per day (0..9 days old) plus a 40-day-old "durable
 * fact" that the write path saw re-confirmed on five later days (an exact
 * duplicate of the same session collapses onto the stored row and reinforces
 * it).
 */
function seededStore(): SessionStore {
  const store = new SessionStore(':memory:');
  const sessionDbId = store.createSDKSession('content-reinforce', PROJECT, 'prompt');
  store.ensureMemorySessionIdRegistered(sessionDbId, 'memory-reinforce');
  for (let age = 9; age >= 0; age--) {
    store.storeObservation('memory-reinforce', PROJECT, observation(`day-${age}`), 1, 0, NOW - age * DAY);
  }
  for (const age of [40, 30, 20, 10, 5, 2]) {
    store.storeObservation('memory-reinforce', PROJECT, observation('durable fact'), 1, 0, NOW - age * DAY);
  }
  return store;
}

describe('SessionStart observation selection with ACT-R reinforcement', () => {
  let store: SessionStore | undefined;
  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it('with CLAUDE_MEM_REINFORCE_ALPHA off returns exactly the N-most-recent query, row for row', () => {
    store = seededStore();
    const legacy = queryObservationsNewest(store, config(0), {
      limit: 4,
      projects: [PROJECT],
      excludeSubagents: true,
    });
    for (const alpha of [undefined, 0]) {
      const selected = queryObservationsMulti(store, [PROJECT], config(alpha));
      expect(selected).toEqual(legacy);
      expect(selected.every(row => !('reinforcement_dates' in row))).toBe(true);
    }
    expect(legacy.map(row => row.title)).toEqual(['day-0', 'day-1', 'day-2', 'day-3']);
  });

  it('with ALPHA > 0 lets the re-confirmed older observation climb in, keeping the newest rows', () => {
    store = seededStore();
    const selected = queryObservationsMulti(store, [PROJECT], config(0.5));
    const titles = selected.map(row => row.title);
    expect(titles).toContain('durable fact');
    expect(titles[0]).toBe('day-0'); // the recency head always stays first
    expect(selected.length).toBe(4);
    for (let i = 1; i < selected.length; i++) {
      expect(selected[i - 1].created_at_epoch).toBeGreaterThanOrEqual(selected[i].created_at_epoch);
    }
  });
});
