import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const PROJECT = 'timeline-tie-boundary-test';
const MEMORY_SESSION_ID = 'mem-session-tie-boundary';
const CONTENT_SESSION_ID = 'content-tie-boundary';

describe('getTimelineAroundTimestamp / getTimelineAroundObservation (epoch anchor)', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    const sdkId = store.createSDKSession(CONTENT_SESSION_ID, PROJECT, 'initial prompt');
    store.updateMemorySessionId(sdkId, MEMORY_SESSION_ID);
  });

  afterEach(() => {
    store.close();
  });

  const baseEpoch = Date.UTC(2024, 0, 1, 0, 0, 0);
  const stepMs = 60_000;

  function seed(title: string, promptNumber: number, epoch: number): number {
    return store.storeObservation(MEMORY_SESSION_ID, PROJECT, {
      type: 'discovery', title, subtitle: null, facts: [], narrative: null,
      concepts: [], files_read: [], files_modified: [],
    }, promptNumber, 0, epoch).id;
  }

  function seedSpaced(count: number): number[] {
    return Array.from({ length: count }, (_, i) =>
      seed(`Spaced observation #${i + 1}`, i + 1, baseEpoch + i * stepMs));
  }

  it('returns exactly depthBefore/depthAfter real neighbors when a single row ties the anchor epoch', () => {
    // 3 real observations, then a 4th sharing the anchor epoch (like a
    // session summary written in the same batch as its last observation),
    // then 3 more real observations after.
    const before = seedSpaced(3);
    const tieEpoch = baseEpoch + 3 * stepMs;
    const tied = seed('Tied-at-anchor observation', 4, tieEpoch);
    const afterIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      afterIds.push(seed(`After observation #${i + 1}`, 5 + i, tieEpoch + (i + 1) * stepMs));
    }

    const timeline = store.getTimelineAroundTimestamp(tieEpoch, 3, 3, PROJECT);
    const returnedIds = timeline.observations.map((o: any) => o.id).sort((a: number, b: number) => a - b);

    // All 3 real "before" rows, the tied anchor row itself, and all 3 real
    // "after" rows: 7 total, not 6 (the pre-fix bug consumed one before-side
    // slot on the tied row and returned only 2 real predecessors).
    expect(returnedIds).toEqual([...before, tied, ...afterIds].sort((a, b) => a - b));
    expect(returnedIds.filter(id => before.includes(id)).length).toBe(3);
    expect(returnedIds.filter(id => afterIds.includes(id)).length).toBe(3);
  });

  it('returns exactly depthBefore/depthAfter real neighbors when several rows tie the anchor epoch', () => {
    const before = seedSpaced(2);
    const tieEpoch = baseEpoch + 2 * stepMs;

    // Three observations sharing one timestamp, e.g. a turn that produced
    // multiple observations plus its session summary in one storeObservations() call.
    const tiedResult = store.storeObservations(
      MEMORY_SESSION_ID,
      PROJECT,
      [
        { type: 'discovery', title: 'Tied A', subtitle: null, facts: [], narrative: null, concepts: [], files_read: [], files_modified: [] },
        { type: 'discovery', title: 'Tied B', subtitle: null, facts: [], narrative: null, concepts: [], files_read: [], files_modified: [] },
        { type: 'discovery', title: 'Tied C', subtitle: null, facts: [], narrative: null, concepts: [], files_read: [], files_modified: [] },
      ],
      null,
      3,
      0,
      tieEpoch
    );

    const afterIds: number[] = [];
    for (let i = 0; i < 2; i++) {
      afterIds.push(seed(`After #${i + 1}`, 4 + i, tieEpoch + (i + 1) * stepMs));
    }

    const timeline = store.getTimelineAroundTimestamp(tieEpoch, 2, 2, PROJECT);
    const returnedIds = timeline.observations.map((o: any) => o.id);

    // Both real "before" rows must be present even though 3 rows tie the
    // anchor epoch (the pre-fix +1 compensation only accounted for one tie).
    expect(before.every(id => returnedIds.includes(id))).toBe(true);
    expect(tiedResult.observationIds.every(id => returnedIds.includes(id))).toBe(true);
    expect(afterIds.every(id => returnedIds.includes(id))).toBe(true);
  });

  it('surfaces rows tied at the anchor even when there is nothing strictly before or after', () => {
    const tieEpoch = baseEpoch;
    const tiedResult = store.storeObservations(
      MEMORY_SESSION_ID,
      PROJECT,
      [
        { type: 'discovery', title: 'Only A', subtitle: null, facts: [], narrative: null, concepts: [], files_read: [], files_modified: [] },
        { type: 'discovery', title: 'Only B', subtitle: null, facts: [], narrative: null, concepts: [], files_read: [], files_modified: [] },
      ],
      null,
      1,
      0,
      tieEpoch
    );

    const timeline = store.getTimelineAroundTimestamp(tieEpoch, 3, 3, PROJECT);
    const returnedIds = timeline.observations.map((o: any) => o.id);

    expect(returnedIds.sort()).toEqual([...tiedResult.observationIds].sort());
  });

  it('does not over-count the after side by one when the anchor matches no real row', () => {
    // Anchor exactly between two spaced observations: no tie at all.
    const ids = seedSpaced(6);
    const anchorEpoch = baseEpoch + 2 * stepMs + stepMs / 2;

    const timeline = store.getTimelineAroundTimestamp(anchorEpoch, 2, 2, PROJECT);
    const returnedIds = timeline.observations.map((o: any) => o.id).sort((a: number, b: number) => a - b);

    // Exactly 2 before (ids[1], ids[2]) and 2 after (ids[3], ids[4]).
    expect(returnedIds).toEqual([ids[1], ids[2], ids[3], ids[4]]);
  });
});
