import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import '../../src/services/sqlite/manual-session.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

function manualNote(title: string) {
  return {
    type: 'discovery',
    title,
    subtitle: 'Manual memory',
    facts: [] as string[],
    narrative: title,
    concepts: [] as string[],
    files_read: [] as string[],
    files_modified: [] as string[],
  };
}

describe('SessionStore manual session platform identity', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('keeps Cursor and Codex manual saves as separate sessions in the same project', () => {
    const project = 'shared-project';
    const cursorSession = store.getOrCreateManualSession(project, 'cursor');
    store.storeObservation(cursorSession, project, manualNote('cursor note'));

    const codexSession = store.getOrCreateManualSession(project, 'codex');
    store.storeObservation(codexSession, project, manualNote('codex note'));

    expect(cursorSession).toBe('manual-shared-project-cursor');
    expect(codexSession).toBe('manual-shared-project-codex');
    expect(codexSession).not.toBe(cursorSession);

    const rows = store.db.prepare(
      'SELECT memory_session_id, platform_source FROM sdk_sessions ORDER BY platform_source',
    ).all() as Array<{ memory_session_id: string; platform_source: string }>;
    expect(rows).toEqual([
      { memory_session_id: 'manual-shared-project-codex', platform_source: 'codex' },
      { memory_session_id: 'manual-shared-project-cursor', platform_source: 'cursor' },
    ]);

    expect(store.getObservationsForSession(cursorSession, 'cursor').map((row) => row.title)).toEqual(['cursor note']);
    expect(store.getObservationsForSession(cursorSession, 'codex')).toEqual([]);
    expect(store.getOrCreateManualSession(project, 'cursor')).toBe(cursorSession);
    expect(
      (store.db.prepare('SELECT platform_source FROM sdk_sessions WHERE memory_session_id = ?').get(cursorSession) as { platform_source: string }).platform_source,
    ).toBe('cursor');
  });
});
