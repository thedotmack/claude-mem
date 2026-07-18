import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

function obs(overrides: Partial<Parameters<SessionStore['storeObservation']>[2]> = {}) {
  return {
    type: 'discovery',
    title: 'Test Observation',
    subtitle: 'Test Subtitle',
    facts: ['fact1', 'fact2'],
    narrative: 'Test narrative content',
    concepts: ['concept1', 'concept2'],
    files_read: ['/path/to/file1.ts'],
    files_modified: ['/path/to/file2.ts'],
    ...overrides,
  };
}

function summary(overrides: Partial<Parameters<SessionStore['storeSummary']>[2]> = {}) {
  return {
    request: 'User requested feature X',
    investigated: 'Explored the codebase',
    learned: 'Discovered pattern Y',
    completed: 'Implemented feature X',
    next_steps: 'Add tests and documentation',
    notes: 'Consider edge case Z' as string | null,
    ...overrides,
  };
}

describe('SessionStore bottle reads', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  // observations/session_summaries reference sdk_sessions(memory_session_id) via enforced FK;
  // register the session and set memory_session_id first.
  function session(memorySessionId: string): { memorySessionId: string; contentSessionId: string } {
    const contentSessionId = `content-${memorySessionId}`;
    const id = store.createSDKSession(contentSessionId, 'project', 'prompt');
    store.updateMemorySessionId(id, memorySessionId);
    return { memorySessionId, contentSessionId };
  }

  describe('getObservationsForBottle', () => {
    it('returns id, narrative, and created_at_epoch ordered by created_at_epoch ASC', () => {
      const { memorySessionId } = session('mem-bottle-obs');
      const later = store.storeObservation(memorySessionId, 'project', obs({ title: 'Later', narrative: 'later narrative' }), 2, 0, 2000000000000);
      const earlier = store.storeObservation(memorySessionId, 'project', obs({ title: 'Earlier', narrative: 'earlier narrative' }), 1, 0, 1000000000000);

      const rows = store.getObservationsForBottle(memorySessionId);

      expect(rows.length).toBe(2);
      expect(rows[0]).toEqual({
        id: earlier.id,
        title: 'Earlier',
        subtitle: 'Test Subtitle',
        narrative: 'earlier narrative',
        type: 'discovery',
        prompt_number: 1,
        created_at_epoch: 1000000000000,
      });
      expect(rows[1]).toEqual({
        id: later.id,
        title: 'Later',
        subtitle: 'Test Subtitle',
        narrative: 'later narrative',
        type: 'discovery',
        prompt_number: 2,
        created_at_epoch: 2000000000000,
      });
    });

    it('breaks created_at_epoch ties by id ASC', () => {
      const { memorySessionId } = session('mem-bottle-ties');
      const epoch = 1500000000000;
      const first = store.storeObservation(memorySessionId, 'project', obs({ title: 'First at epoch' }), 1, 0, epoch);
      const second = store.storeObservation(memorySessionId, 'project', obs({ title: 'Second at epoch' }), 1, 0, epoch);

      const rows = store.getObservationsForBottle(memorySessionId);

      expect(rows.map(r => r.id)).toEqual([first.id, second.id]);
      expect(rows.map(r => r.title)).toEqual(['First at epoch', 'Second at epoch']);
    });

    it('is session-isolated and returns [] when none exist', () => {
      const a = session('mem-bottle-a');
      session('mem-bottle-b');
      store.storeObservation(a.memorySessionId, 'project', obs());

      expect(store.getObservationsForBottle('mem-bottle-b')).toEqual([]);
      expect(store.getObservationsForBottle('mem-bottle-missing')).toEqual([]);
    });
  });

  describe('getUserPromptsForSession', () => {
    it('returns all prompts in prompt_number order', () => {
      const { contentSessionId } = session('mem-bottle-prompts');
      store.saveUserPrompt(contentSessionId, 3, 'Third prompt');
      store.saveUserPrompt(contentSessionId, 1, 'First prompt');
      store.saveUserPrompt(contentSessionId, 2, 'Second prompt');

      const rows = store.getUserPromptsForSession(contentSessionId);

      expect(rows.map(r => r.prompt_number)).toEqual([1, 2, 3]);
      expect(rows.map(r => r.prompt_text)).toEqual(['First prompt', 'Second prompt', 'Third prompt']);
      for (const row of rows) {
        expect(row.created_at_epoch).toBeGreaterThan(0);
      }
    });

    it('is session-isolated and returns [] when none exist', () => {
      const a = session('mem-bottle-prompts-a');
      const b = session('mem-bottle-prompts-b');
      store.saveUserPrompt(a.contentSessionId, 1, 'A1');

      expect(store.getUserPromptsForSession(b.contentSessionId)).toEqual([]);
      expect(store.getUserPromptsForSession('nonexistent-session')).toEqual([]);
    });
  });

  describe('getSummariesForSession', () => {
    it('returns all summaries ordered by created_at_epoch ASC', () => {
      const { memorySessionId } = session('mem-bottle-sums');
      store.storeSummary(memorySessionId, 'project', summary({ request: 'Second request' }), 2, 0, 2000000000000);
      store.storeSummary(memorySessionId, 'project', summary({ request: 'First request' }), 1, 0, 1000000000000);

      const rows = store.getSummariesForSession(memorySessionId);

      expect(rows.length).toBe(2);
      expect(rows.map(r => r.request)).toEqual(['First request', 'Second request']);
      expect(rows.map(r => r.prompt_number)).toEqual([1, 2]);
      expect(rows.map(r => r.created_at_epoch)).toEqual([1000000000000, 2000000000000]);
      expect(rows[0].next_steps).toBe('Add tests and documentation');
    });

    it('is session-isolated and returns [] when none exist', () => {
      const a = session('mem-bottle-sums-a');
      const b = session('mem-bottle-sums-b');
      store.storeSummary(a.memorySessionId, 'project', summary({ request: 'A only' }));
      store.storeSummary(b.memorySessionId, 'project', summary({ request: 'B only' }));

      const rows = store.getSummariesForSession(a.memorySessionId);
      expect(rows.map(r => r.request)).toEqual(['A only']);
      expect(store.getSummariesForSession('nonexistent-session')).toEqual([]);
    });
  });
});
