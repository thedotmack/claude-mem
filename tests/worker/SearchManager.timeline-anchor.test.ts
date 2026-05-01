import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

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

  const baseEpoch = Date.UTC(2024, 0, 1, 0, 0, 0); 
  const stepMs = 60_000; 

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

function extractObservationIds(formattedText: string): number[] {
  const ids: number[] = [];
  const rowRegex = /^\|\s*#(\d+)\s*\|/gm;
  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(formattedText)) !== null) {
    ids.push(Number(match[1]));
  }
  return ids;
}

function expectAnchorRendered(text: string, anchorId: number): void {
  expect(text).toContain(`# Timeline around anchor: ${anchorId}`);
  const anchorRow = text
    .split('\n')
    .find((line) => line.startsWith(`| #${anchorId} `));
  expect(anchorRow).toBeDefined();
  expect(anchorRow).toContain('<- **ANCHOR**');
}

describe('SearchManager.timeline() anchor dispatch', () => {
  let db: Database;
  let store: SessionStore;
  let search: SessionSearch;
  let manager: SearchManager;
  let seeded: SeededObservation[];

  beforeEach(() => {
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
    const middle = seeded[24]; 
    const expectedIds = seeded.slice(21, 28).map((o) => o.id);

    const response = await manager.timeline({
      anchor: middle.id, // pass as JS number
      depth_before: 3,
      depth_after: 3,
    });

    expect(response.isError).not.toBe(true);
    const text: string = response.content[0].text;
    const returnedIds = extractObservationIds(text);
    expect(returnedIds).toEqual(expectedIds);
    expectAnchorRendered(text, middle.id);
  });

  it('(b) numeric anchor passed as STRING returns the 7-id window around the anchor (THE bug case)', async () => {
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
    expect(returnedIds).toEqual(expectedIds);
    expectAnchorRendered(text, middle.id);
  });

  it('(b2) numeric anchor with surrounding whitespace is coerced and returns the same window', async () => {
    const middle = seeded[24];
    const expectedIds = seeded.slice(21, 28).map((o) => o.id);

    const response = await manager.timeline({
      anchor: `  ${middle.id}  `,
      depth_before: 3,
      depth_after: 3,
    });

    expect(response.isError).not.toBe(true);
    const text: string = response.content[0].text;
    const returnedIds = extractObservationIds(text);
    expect(returnedIds).toEqual(expectedIds);
    expectAnchorRendered(text, middle.id);
  });

  it('(c) session-ID anchor "S<n>" routes to the timestamp branch and returns a non-error response', async () => {
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
    const text: string = response.content[0].text;
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  it('(d) ISO-timestamp anchor routes to the timestamp branch and returns a non-error response', async () => {
    const middle = seeded[24];
    const isoAnchor = new Date(middle.epoch).toISOString();

    const response = await manager.timeline({
      anchor: isoAnchor,
      depth_before: 3,
      depth_after: 3,
    });

    expect(response.isError).not.toBe(true);
    const text: string = response.content[0].text;
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
    expect(text).toBe('Invalid timestamp: 123abc');
  });

  it('(f) numeric anchor not found returns Observation #... not found with isError', async () => {
    const response = await manager.timeline({
      anchor: '99999999',
      depth_before: 3,
      depth_after: 3,
    });

    expect(response.isError).toBe(true);
    const text: string = response.content[0].text;
    expect(text).toContain('Observation #99999999 not found');
  });
});
