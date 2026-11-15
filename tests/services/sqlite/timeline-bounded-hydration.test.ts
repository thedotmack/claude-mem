import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SearchManager } from '../../../src/services/worker/SearchManager.js';
import { FormattingService } from '../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../src/services/worker/TimelineService.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';

const PROJECT = 'bounded-timeline';
const EPOCH = Date.UTC(2026, 0, 1);

describe('timeline row hydration', () => {
  let store: SessionStore;
  let manager: SearchManager;
  let sessionId: number;

  beforeEach(() => {
    ModeManager.getInstance().loadMode('code');
    store = new SessionStore(':memory:');
    sessionId = store.createSDKSession('bounded-content', PROJECT, 'request');
    store.ensureMemorySessionIdRegistered(sessionId, 'bounded-memory');
    manager = new SearchManager(new SessionSearch(store.db), store, null,
      new FormattingService(), new TimelineService());
  });
  afterEach(() => store.close());

  function observation(offset: number, title = `ObservationAt${offset}`) {
    return store.storeObservation('bounded-memory', PROJECT, {
      type: 'discovery', title, subtitle: null, narrative: 'context '.repeat(128),
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, EPOCH + offset).id;
  }

  function summary(offset: number, title = `SummaryAt${offset}`) {
    return store.storeSummary('bounded-memory', PROJECT, {
      request: title, investigated: '', learned: '', completed: '', next_steps: '', notes: null,
    }, 1, 0, EPOCH + offset).id;
  }

  it('does not hydrate dense history between sparse summary boundaries', async () => {
    const ids = store.db.transaction(() => Array.from({ length: 1000 }, (_, i) => observation(i + 1)))();
    summary(0);
    summary(1001);

    const rows = store.getTimelineAroundObservation(ids[499], EPOCH + 500, 1, 1, PROJECT);
    expect(rows.observations.map(row => row.id)).toEqual(ids.slice(498, 501));
    expect(rows.sessions).toHaveLength(2);

    const result = await manager.timeline({ anchor: ids[499], project: PROJECT, depth_before: 1, depth_after: 1 });
    const text = result.content[0].text;
    expect(text).toContain('**Items:** 3');
    expect(text).toContain('ObservationAt499');
    expect(text).toContain('ObservationAt500');
    expect(text).toContain('ObservationAt501');
    expect(text).not.toContain('SummaryAt');
    expect(text).not.toContain('ObservationAt498');
    expect(text).not.toContain('ObservationAt502');
  });

  it('selects stable ID neighbors at non-anchor timestamp ties', () => {
    const before = Array.from({ length: 5 }, (_, i) => observation(100, `Before${i}`));
    const anchor = observation(200, 'Anchor');
    const after = Array.from({ length: 5 }, (_, i) => observation(300, `After${i}`));
    summary(0);
    summary(400);

    const rows = store.getTimelineAroundObservation(anchor, EPOCH + 200, 2, 2, PROJECT);
    expect(rows.observations.map(row => row.id)).toEqual([...before.slice(-2), anchor, ...after.slice(0, 2)]);
  });

  it('retains the complete anchor epoch group with zero depth', async () => {
    observation(100, 'Earlier');
    const tied = Array.from({ length: 4 }, (_, i) => observation(200, `TiedObservation${i}`));
    const anchor = summary(200, 'TiedSummary');
    store.saveUserPrompt('bounded-content', 1, 'TiedPrompt', sessionId, undefined, undefined, EPOCH + 200);
    observation(300, 'Later');

    const rows = store.getTimelineAroundTimestamp(EPOCH + 200, 0, 0, PROJECT);
    expect(rows.observations.map(row => row.id)).toEqual(tied);
    expect(rows.sessions.map(row => row.id)).toEqual([anchor]);
    expect(rows.prompts).toHaveLength(1);
    const result = await manager.timeline({ anchor: `S${anchor}`, project: PROJECT, depth_before: 0, depth_after: 0 });
    expect(result.content[0].text).toContain('**Items:** 6');
    expect(result.content[0].text).toContain('TiedPrompt');
    expect(result.content[0].text).not.toContain('Earlier');
    expect(result.content[0].text).not.toContain('Later');
  });
});
