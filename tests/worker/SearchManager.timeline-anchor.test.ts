/**
 * Regression coverage for SearchManager.timeline() anchor dispatch.
 *
 * Bug history: HTTP query params arrive as strings, so the
 * `typeof anchor === 'number'` dispatch missed the observation-ID branch
 * and silently fell through to ISO-timestamp parsing — returning a
 * wrong-epoch window with the correct anchor still echoed in the header.
 *
 * The fix coerces stringified numerics in `SearchManager.timeline()` via
 * `anchorAsNumber`. These tests guard that fix by exercising:
 *   (a) numeric anchor as JS number
 *   (b) numeric anchor as string (THE bug case)
 *   (c) session-ID string anchor "S<n>"
 *   (d) ISO-timestamp anchor
 *   (e) garbage anchor (must return isError: true)
 *
 * Pattern source: tests/session_store.test.ts uses real SessionStore
 * against ':memory:' SQLite. We follow the same approach (no SessionStore
 * mocks) and additionally instantiate real SessionSearch over the same DB
 * handle, plus real FormattingService and TimelineService. ChromaSync is
 * passed as null (the timeline anchor branch does not require Chroma).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// ModeManager is a global singleton that requires `loadMode()` to be
// called before use. The formatter path inside `SearchManager.timeline()`
// calls `ModeManager.getInstance().getTypeIcon(...)`, which throws if no
// mode is loaded. Existing worker tests (e.g. tests/worker/search/
// result-formatter.test.ts) follow the same pattern: stub ModeManager
// so the unrelated config singleton does not blow up the unit under
// test. We deliberately do NOT mock SessionStore — that's the data
// layer the bug travelled through, and faking it would defeat the
// regression coverage.
mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {},
        observation_types: [
          { id: 'discovery', icon: 'I' },
        ],
        observation_concepts: [],
      }),
      getObservationTypes: () => [{ id: 'discovery', icon: 'I' }],
      getTypeIcon: (_type: string) => 'I',
      getWorkEmoji: () => 'W',
    }),
  },
}));

import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { FormattingService } from '../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../src/services/worker/TimelineService.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';

const PROJECT = 'timeline-anchor-test';
const MEMORY_SESSION_ID = 'mem-session-timeline-anchor';
const CONTENT_SESSION_ID = 'content-timeline-anchor';

interface SeededObservation {
  id: number;
  epoch: number;
}

function seedObservations(store: SessionStore, count: number): SeededObservation[] {
  const sdkId = store.createSDKSession(CONTENT_SESSION_ID, PROJECT, 'initial prompt');
  store.updateMemorySessionId(sdkId, MEMORY_SESSION_ID);

  // Anchor the synthetic timeline well in the past so it cannot collide with
  // any "recent rows" the buggy code path would otherwise return.
  const baseEpoch = Date.UTC(2024, 0, 1, 0, 0, 0); // 2024-01-01T00:00:00Z
  const stepMs = 60_000; // 1 minute apart, deterministic ordering

  const seeded: SeededObservation[] = [];
  for (let i = 0; i < count; i++) {
    const epoch = baseEpoch + i * stepMs;
    const result = store.storeObservation(
      MEMORY_SESSION_ID,
      PROJECT,
      {
        type: 'discovery',
        title: `Synthetic observation #${i + 1}`,
        subtitle: null,
        facts: [],
        narrative: `Narrative for synthetic observation ${i + 1}`,
        concepts: [],
        files_read: [],
        files_modified: [],
      },
      i + 1,
      0,
      epoch
    );
    seeded.push({ id: result.id, epoch: result.createdAtEpoch });
  }
  return seeded;
}

/**
 * Pull the observation IDs out of the timeline's formatted markdown.
 * Each observation row renders as `| #<id> | <time> | ...` (see
 * SearchManager.timeline() formatter, ~line 744). We only want
 * observation IDs (rows starting with `| #` followed by a digit) — we
 * deliberately skip session rows (`| #S...`) and prompt headers.
 */
function extractObservationIds(formattedText: string): number[] {
  const ids: number[] = [];
  const rowRegex = /^\|\s*#(\d+)\s*\|/gm;
  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(formattedText)) !== null) {
    ids.push(Number(match[1]));
  }
  return ids;
}

describe('SearchManager.timeline() anchor dispatch', () => {
  let db: Database;
  let store: SessionStore;
  let search: SessionSearch;
  let manager: SearchManager;
  let seeded: SeededObservation[];

  beforeEach(() => {
    // Real SQLite, shared connection between store + search (same wiring
    // DatabaseManager uses in production at src/services/worker/DatabaseManager.ts:34-35).
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    store = new SessionStore(db);
    search = new SessionSearch(db);

    seeded = seedObservations(store, 50);
    manager = new SearchManager(
      search,
      store,
      null, // ChromaSync intentionally null: anchor dispatch must not require it.
      new FormattingService(),
      new TimelineService()
    );
  });

  afterEach(() => {
    db.close();
  });

  it('(a) numeric anchor passed as JS number returns the 7-id window around the anchor', async () => {
    // depth_before=3 + anchor + depth_after=3 = 7 IDs
    const middle = seeded[24]; // 25th observation (index 24)
    const expectedIds = seeded.slice(21, 28).map((o) => o.id);

    const response = await manager.timeline({
      anchor: middle.id, // pass as JS number
      depth_before: 3,
      depth_after: 3,
    });

    expect(response.isError).not.toBe(true);
    const text: string = response.content[0].text;
    const returnedIds = extractObservationIds(text);
    expect(returnedIds.sort((a, b) => a - b)).toEqual(expectedIds.sort((a, b) => a - b));
    expect(returnedIds).toContain(middle.id);
  });

  it('(b) numeric anchor passed as STRING returns the 7-id window around the anchor (THE bug case)', async () => {
    // This is the exact regression that motivated Phase 2's anchorAsNumber
    // coercion. Without that fix, the response collapsed to the most
    // recent rows because `new Date("<digits>")` produced a wrong-epoch
    // window, while the header still echoed the requested anchor.
    const middle = seeded[24];
    const expectedIds = seeded.slice(21, 28).map((o) => o.id);

    const response = await manager.timeline({
      anchor: String(middle.id), // pass as STRING — what HTTP layer always sends
      depth_before: 3,
      depth_after: 3,
    });

    expect(response.isError).not.toBe(true);
    const text: string = response.content[0].text;
    const returnedIds = extractObservationIds(text);
    expect(returnedIds.sort((a, b) => a - b)).toEqual(expectedIds.sort((a, b) => a - b));
    expect(returnedIds).toContain(middle.id);
  });

  it('(c) session-ID anchor "S<n>" routes to the timestamp branch and returns a non-error response', async () => {
    // Look up the SDK session row id directly. The timeline session
    // anchor branch (SearchManager.timeline ~line 576) parses the integer
    // after the "S" and calls getSessionSummariesByIds, so we need a row
    // in session_summaries for this id. Build one off the existing
    // memory session.
    // Anchor the synthetic summary on the same epoch as the middle
    // observation so the timestamp branch lands inside the seeded range.
    const middle = seeded[24];
    const summaryResult = store.storeSummary(
      MEMORY_SESSION_ID,
      PROJECT,
      {
        request: 'Synthetic session for timeline anchor test',
        investigated: '',
        learned: '',
        completed: '',
        next_steps: '',
        notes: null,
      },
      undefined,
      0,
      middle.epoch
    );
    const sessionDbId = summaryResult.id;

    const response = await manager.timeline({
      anchor: `S${sessionDbId}`,
      depth_before: 3,
      depth_after: 3,
    });

    expect(response.isError).not.toBe(true);
    // We do not assert the exact ID set here — getTimelineAroundTimestamp
    // returns whatever lives near the session's epoch. The invariant the
    // bug was about (numeric coercion not stealing string anchors) is
    // captured by the fact that this call does NOT 404 and does NOT hit
    // the invalid-anchor branch.
    const text: string = response.content[0].text;
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  it('(d) ISO-timestamp anchor routes to the timestamp branch and returns a non-error response', async () => {
    // Pick an ISO timestamp in the middle of our seeded range.
    const middle = seeded[24];
    const isoAnchor = new Date(middle.epoch).toISOString();

    const response = await manager.timeline({
      anchor: isoAnchor,
      depth_before: 3,
      depth_after: 3,
    });

    expect(response.isError).not.toBe(true);
    const text: string = response.content[0].text;
    // ISO branch uses a timestamp window — the seeded observation closest
    // to the requested epoch must appear somewhere in the result.
    const returnedIds = extractObservationIds(text);
    expect(returnedIds).toContain(middle.id);
  });

  it('(e) garbage anchor "123abc" returns isError: true (does NOT swallow as numeric)', async () => {
    const response = await manager.timeline({
      anchor: '123abc',
      depth_before: 3,
      depth_after: 3,
    });

    expect(response.isError).toBe(true);
    const text: string = response.content[0].text;
    // Either the "Invalid timestamp" or "Invalid anchor" error path is
    // acceptable — both are surfaced as isError. We only require that
    // the anchor was NOT silently coerced to a number (the parseInt
    // anti-pattern guard from PLAN.md Phase 2).
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});
