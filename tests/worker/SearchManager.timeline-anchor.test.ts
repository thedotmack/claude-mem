import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';

// Capture real exports before mock.module mutates the live namespace, then
// re-register the snapshot in afterAll so the partial ModeManager stub (no
// class prototype, no loadMode) does not leak into later test files (bun's
// mock.module is process-global; mock.restore() does NOT undo it). A leaked
// stub breaks tests/server/server-boot.test.ts, server-runtime-smoke and the
// tests/sdk parser suites whenever the readdir-dependent file order runs them
// after this file.
import * as realModeManagerModule from '../../src/services/domain/ModeManager.js';

const realModeManagerSnapshot = { ...realModeManagerModule };

afterAll(() => {
  mock.module('../../src/services/domain/ModeManager.js', () => realModeManagerSnapshot);
});

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

  it('(g) query mode scopes timeline hydration to the requested platform', async () => {
    const project = 'timeline-platform-scope';
    const contentSessionId = 'shared-platform-timeline-raw-id';
    const baseEpoch = Date.UTC(2024, 1, 1, 0, 0, 0);

    const claudeSessionDbId = store.createSDKSession(contentSessionId, project, 'claude prompt', undefined, 'claude');
    store.ensureMemorySessionIdRegistered(claudeSessionDbId, 'claude-platform-memory');
    const cursorSessionDbId = store.createSDKSession(contentSessionId, project, 'cursor prompt', undefined, 'cursor');
    store.ensureMemorySessionIdRegistered(cursorSessionDbId, 'cursor-platform-memory');

    store.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(claudeSessionDbId, contentSessionId, 1, 'CLAUDE_LEAK_PROMPT', new Date(baseEpoch).toISOString(), baseEpoch);
    store.db.prepare(`
      INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(cursorSessionDbId, contentSessionId, 1, 'CURSOR_SCOPE_PROMPT', new Date(baseEpoch).toISOString(), baseEpoch);

    store.storeObservation(
      'claude-platform-memory',
      project,
      {
        type: 'discovery',
        title: 'CLAUDE_LEAK_OBS',
        subtitle: null,
        facts: [],
        narrative: 'claude-only context that must not appear in cursor timelines',
        concepts: [],
        files_read: ['src/platform.ts'],
        files_modified: [],
      },
      1,
      0,
      baseEpoch - 1_000
    );
    store.storeSummary(
      'claude-platform-memory',
      project,
      {
        request: 'CLAUDE_LEAK_SUMMARY',
        investigated: '',
        learned: '',
        completed: '',
        next_steps: '',
        notes: null,
      },
      1,
      0,
      baseEpoch
    );
    store.storeSummary(
      'cursor-platform-memory',
      project,
      {
        request: 'CURSOR_SCOPE_SUMMARY',
        investigated: '',
        learned: '',
        completed: '',
        next_steps: '',
        notes: null,
      },
      1,
      0,
      baseEpoch
    );
    const cursorAnchor = store.storeObservation(
      'cursor-platform-memory',
      project,
      {
        type: 'discovery',
        title: 'CURSOR_SCOPE_ANCHOR',
        subtitle: null,
        facts: [],
        narrative: 'cursoranchorneedle scoped timeline anchor',
        concepts: [],
        files_read: ['src/platform.ts'],
        files_modified: [],
      },
      1,
      0,
      baseEpoch
    );

    const response = await manager.timeline({
      query: 'cursoranchorneedle',
      project,
      platform_source: 'cursor',
      depth_before: 5,
      depth_after: 5,
    });

    expect(response.isError).not.toBe(true);
    const text: string = response.content[0].text;
    expect(text).toContain(`Observation #${cursorAnchor.id}`);
    expect(text).toContain('CURSOR_SCOPE_ANCHOR');
    expect(text).toContain('CURSOR_SCOPE_SUMMARY');
    expect(text).toContain('CURSOR_SCOPE_PROMPT');
    expect(text).not.toContain('CLAUDE_LEAK_OBS');
    expect(text).not.toContain('CLAUDE_LEAK_SUMMARY');
    expect(text).not.toContain('CLAUDE_LEAK_PROMPT');
  });
});

// storeObservations() stamps a turn's observations and its summary with one epoch, so an
// epoch anchor (S<n> or an ISO timestamp) routinely ties several rows. Every row tied at the
// anchor epoch is the anchor group; depth counts the rows strictly before and after it.
describe('SearchManager.timeline() epoch anchors with tied rows', () => {
  const TIE_PROJECT = 'timeline-tie-e2e';
  const TIE_MEMORY_SESSION_ID = 'mem-session-timeline-tie';
  const stepMs = 60_000;
  const tieEpoch = Date.UTC(2024, 2, 1, 12, 0, 0);

  let db: Database;
  let store: SessionStore;
  let manager: SearchManager;
  let summaryId: number;
  const idsByTitle = new Map<string, number>();

  function storeTitledObservation(title: string, epoch: number): void {
    const result = store.storeObservation(TIE_MEMORY_SESSION_ID, TIE_PROJECT, {
      type: 'discovery',
      title,
      subtitle: null,
      facts: [],
      narrative: `narrative for ${title}`,
      concepts: [],
      files_read: [],
      files_modified: [],
    }, 1, 0, epoch);
    idsByTitle.set(title, result.id);
  }

  // Rendered items in order: observations as their title, the summary as "summary".
  function renderedItems(text: string): string[] {
    const titleById = new Map(Array.from(idsByTitle.entries()).map(([title, id]) => [id, title]));
    const items: string[] = [];
    for (const line of text.split('\n')) {
      const observationRow = /^\|\s*#(\d+)\s*\|/.exec(line);
      if (observationRow) {
        items.push(titleById.get(Number(observationRow[1])) ?? `#${observationRow[1]}`);
      } else if (line.includes(`#S${summaryId}**`)) {
        items.push('summary');
      }
    }
    return items;
  }

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SessionStore(db);
    manager = new SearchManager(new SessionSearch(db), store, null, new FormattingService(), new TimelineService());

    const sdkId = store.createSDKSession('content-timeline-tie', TIE_PROJECT, 'initial prompt');
    store.updateMemorySessionId(sdkId, TIE_MEMORY_SESSION_ID);

    // before-1..before-4 sit 4..1 minutes before the tie; after-1..after-4 sit 1..4 minutes after.
    for (let i = 1; i <= 4; i++) storeTitledObservation(`before-${i}`, tieEpoch - (5 - i) * stepMs);
    storeTitledObservation('tie-a', tieEpoch);
    storeTitledObservation('tie-b', tieEpoch);
    storeTitledObservation('tie-c', tieEpoch);
    summaryId = store.storeSummary(TIE_MEMORY_SESSION_ID, TIE_PROJECT, {
      request: 'Turn summary sharing the batch epoch',
      investigated: '',
      learned: '',
      completed: '',
      next_steps: '',
      notes: null,
    }, 1, 0, tieEpoch).id;
    for (let i = 1; i <= 4; i++) storeTitledObservation(`after-${i}`, tieEpoch + i * stepMs);
  });

  afterEach(() => {
    db.close();
    idsByTitle.clear();
  });

  const tiedWindow = ['before-3', 'before-4', 'tie-a', 'tie-b', 'tie-c', 'summary', 'after-1', 'after-2'];

  it('S<n> anchor keeps the whole tied turn plus depth rows on both sides', async () => {
    const response = await manager.timeline({ anchor: `S${summaryId}`, depth_before: 2, depth_after: 2 });
    expect(response.isError).not.toBe(true);
    expect(renderedItems(response.content[0].text)).toEqual(tiedWindow);
  });

  it('ISO anchor on the tied epoch keeps the rows after the tie', async () => {
    const response = await manager.timeline({
      anchor: new Date(tieEpoch).toISOString(),
      depth_before: 2,
      depth_after: 2,
    });
    expect(response.isError).not.toBe(true);
    expect(renderedItems(response.content[0].text)).toEqual(tiedWindow);
  });

  it('ISO anchor between rows returns exactly depth_before + depth_after rows', async () => {
    const betweenBefore2AndBefore3 = tieEpoch - 2.5 * stepMs;
    const response = await manager.timeline({
      anchor: new Date(betweenBefore2AndBefore3).toISOString(),
      depth_before: 2,
      depth_after: 2,
    });
    expect(response.isError).not.toBe(true);
    expect(renderedItems(response.content[0].text)).toEqual(['before-1', 'before-2', 'before-3', 'before-4']);
  });
});
