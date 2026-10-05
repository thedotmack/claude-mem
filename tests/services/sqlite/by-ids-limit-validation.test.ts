import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

// Unified /api/search hands these lookups the raw query-string `limit`, so it can
// be any string. A positive integer, as a number or a numeric string, limits the
// rows and is bound as a parameter. Anything else means no limit, as an absent
// limit does, and never becomes part of the SQL text.
type LookupName = 'getObservationsByIds' | 'getSessionSummariesByIds' | 'getUserPromptsByIds';
type OrderBy = 'date_desc' | 'relevance';

const lookupNames: LookupName[] = ['getObservationsByIds', 'getSessionSummariesByIds', 'getUserPromptsByIds'];
const orderings: OrderBy[] = ['date_desc', 'relevance'];

let store: SessionStore;
let seededIds: Record<LookupName, number[]>;

function lookupIds(lookupName: LookupName, limit: unknown, orderBy: OrderBy): number[] {
  // Typed as a number, but the HTTP path passes whatever the query string held.
  const options = { limit: limit as number, orderBy };
  const ids = seededIds[lookupName];
  const rows = lookupName === 'getObservationsByIds' ? store.getObservationsByIds(ids, options)
    : lookupName === 'getSessionSummariesByIds' ? store.getSessionSummariesByIds(ids, options)
    : store.getUserPromptsByIds(ids, options);
  return rows.map(row => row.id);
}

describe('SessionStore.*ByIds: limit is validated and bound', () => {
  beforeEach(() => {
    store = new SessionStore(':memory:');
    const sdkId = store.createSDKSession('content-limit', 'p', 'prompt');
    store.updateMemorySessionId(sdkId, 'session-limit');
    seededIds = { getObservationsByIds: [], getSessionSummariesByIds: [], getUserPromptsByIds: [] };

    const baseTs = 1_700_000_000_000;
    for (let i = 0; i < 3; i++) {
      seededIds.getObservationsByIds.push(store.storeObservations('session-limit', 'p', [{
        type: 'test', title: `obs-${i}`, subtitle: null, facts: [], narrative: null,
        concepts: [], files_read: [], files_modified: [],
      }], null, i, 0, baseTs + i * 1000).observationIds[0]);
      // one summary per session: summaries reference a registered memory session
      store.updateMemorySessionId(store.createSDKSession(`content-summary-${i}`, 'p', 'prompt'), `summary-session-${i}`);
      seededIds.getSessionSummariesByIds.push(store.importSessionSummary({
        memory_session_id: `summary-session-${i}`, project: 'p', request: `summary ${i}`,
        investigated: null, learned: null, completed: null, next_steps: null,
        files_read: null, files_edited: null, notes: null, prompt_number: i, discovery_tokens: 0,
        created_at: new Date(baseTs + i * 1000).toISOString(), created_at_epoch: baseTs + i * 1000,
      }).id);
      seededIds.getUserPromptsByIds.push(store.saveUserPrompt('content-limit', i, `prompt ${i}`, sdkId));
    }
  });

  afterEach(() => {
    store.close();
  });

  for (const lookupName of lookupNames) {
    describe(lookupName, () => {
      it('treats a non-numeric limit string as no limit and keeps it out of the SQL', () => {
        const prepareSpy = spyOn(store.db, 'prepare');
        const nonNumericLimit = '2 rows';
        for (const orderBy of orderings) {
          expect(lookupIds(lookupName, nonNumericLimit, orderBy)).toHaveLength(3);
        }
        expect(prepareSpy.mock.calls.some(([sql]) => String(sql).includes(nonNumericLimit))).toBe(false);
      });

      it('limits to a numeric query-string limit, bound as a parameter', () => {
        const prepareSpy = spyOn(store.db, 'prepare');
        expect(lookupIds(lookupName, '2', 'date_desc')).toHaveLength(2);
        expect(lookupIds(lookupName, '2', 'relevance')).toEqual(seededIds[lookupName].slice(0, 2));
        const lookupSql = prepareSpy.mock.calls.map(([sql]) => String(sql)).join('\n');
        expect(lookupSql).toContain('LIMIT ?');
        expect(lookupSql).not.toMatch(/LIMIT\s+2\b/);
      });

      it('still limits with a plain number', () => {
        expect(lookupIds(lookupName, 2, 'date_desc')).toHaveLength(2);
        expect(lookupIds(lookupName, 2, 'relevance')).toEqual(seededIds[lookupName].slice(0, 2));
      });

      it('treats empty, zero, negative, fractional and oversized limits as no limit', () => {
        // '1e20' is an integer, but too large for SQLite to accept as a bound LIMIT.
        for (const limit of [undefined, '', 0, '0', -1, 1.5, '1e20']) {
          for (const orderBy of orderings) {
            expect(lookupIds(lookupName, limit, orderBy)).toHaveLength(3);
          }
        }
      });
    });
  }
});
