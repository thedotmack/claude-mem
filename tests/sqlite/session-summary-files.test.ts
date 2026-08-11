import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore, rollupObservationFileLists } from '../../src/services/sqlite/SessionStore.js';
import { attachObservationFilesToSummary } from '../../src/services/worker/agents/ResponseProcessor.js';

describe('session_summaries files_read / files_edited (#3517)', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('rollupObservationFileLists dedupes read and modified paths', () => {
    expect(
      rollupObservationFileLists([
        { files_read: ['a.ts', 'b.ts'], files_modified: ['b.ts'] },
        { files_read: ['a.ts', 'c.ts'], files_modified: ['d.ts'] },
      ])
    ).toEqual({
      files_read: ['a.ts', 'b.ts', 'c.ts'],
      files_edited: ['b.ts', 'd.ts'],
    });
  });

  it('attachObservationFilesToSummary keeps claimed file evidence for summary-only responses', () => {
    const summary = attachObservationFilesToSummary(
      {
        request: 'r',
        investigated: 'i',
        learned: 'l',
        completed: 'c',
        next_steps: 'n',
        notes: null,
        files_read: [],
        files_edited: [],
      },
      [
        {
          files_read: ['src/verified.ts'],
          files_modified: ['src/verified-edit.ts'],
        },
      ]
    );

    expect(summary?.files_read).toEqual(['src/verified.ts']);
    expect(summary?.files_edited).toEqual(['src/verified-edit.ts']);
  });

  it('storeObservations writes rolled-up files_read and files_edited', () => {
    const sessionDbId = store.createSDKSession('content-3517', 'proj-3517', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-3517');

    const result = store.storeObservations(
      'mem-3517',
      'proj-3517',
      [
        {
          type: 'discovery',
          title: 'Read auth',
          subtitle: null,
          facts: [],
          narrative: 'read auth',
          concepts: [],
          files_read: ['src/auth.ts'],
          files_modified: [],
        },
        {
          type: 'change',
          title: 'Edit auth',
          subtitle: null,
          facts: [],
          narrative: 'edit auth',
          concepts: [],
          files_read: ['src/auth.ts'],
          files_modified: ['src/auth.ts', 'src/login.ts'],
        },
      ],
      {
        request: 'fix login',
        investigated: 'auth flow',
        learned: 'token refresh',
        completed: 'patched',
        next_steps: 'ship',
        notes: null,
      },
      1,
      10
    );

    expect(result.summaryId).not.toBeNull();
    const row = store.db
      .prepare('SELECT files_read, files_edited FROM session_summaries WHERE id = ?')
      .get(result.summaryId!) as { files_read: string; files_edited: string };

    expect(JSON.parse(row.files_read)).toEqual(['src/auth.ts']);
    expect(JSON.parse(row.files_edited)).toEqual(['src/auth.ts', 'src/login.ts']);
  });

  it('storeSummary writes empty JSON arrays instead of NULL', () => {
    const sessionDbId = store.createSDKSession('content-3517b', 'proj-3517b', 'prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, 'mem-3517b');

    const { id } = store.storeSummary('mem-3517b', 'proj-3517b', {
      request: 'r',
      investigated: 'i',
      learned: 'l',
      completed: 'c',
      next_steps: 'n',
      notes: null,
    });

    const row = store.db
      .prepare('SELECT files_read, files_edited FROM session_summaries WHERE id = ?')
      .get(id) as { files_read: string; files_edited: string };

    expect(row.files_read).toBe('[]');
    expect(row.files_edited).toBe('[]');
  });
});
