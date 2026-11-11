import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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

  // v15.16.0 regression: manual sessions written before the content-session
  // lookup (for example memory_session_id = content_session_id =
  // 'manual-<project>-claude') were missed, and the INSERT of the same
  // memory_session_id failed with a UNIQUE constraint, so every save in that
  // project returned 500.
  it('reuses an existing manual session whose content session id has an older shape', () => {
    const project = 'legacy-project';
    const legacyId = 'manual-legacy-project-claude';
    store.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, 'claude', '2026-09-10T03:30:51.852Z', 1788924651852, 'active')
    `).run(legacyId, legacyId, project);

    const session = store.getOrCreateManualSession(project, 'claude');
    store.storeObservation(session, project, manualNote('saved after upgrade'));

    expect(session).toBe(legacyId);
    expect(store.getObservationsForSession(session, 'claude').map((row) => row.title)).toEqual(['saved after upgrade']);
    expect(store.getOrCreateManualSession(project, 'claude')).toBe(legacyId);
    const count = store.db.prepare('SELECT COUNT(*) AS n FROM sdk_sessions WHERE project = ?').get(project) as { n: number };
    expect(count.n).toBe(1);
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
