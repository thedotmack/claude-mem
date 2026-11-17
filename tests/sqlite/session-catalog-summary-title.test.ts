import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { OBSERVER_SESSIONS_PROJECT } from '../../src/shared/paths.js';

// The Sessions list titles each row by what the session was about: the trimmed request of the
// session's newest summary that has words (summary_title), or null when there is none.
describe('session catalog summary_title', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  /** A session started at `startedAt`; registered with a memory session id unless `memoryId` is null. */
  function session(contentId: string, project: string, startedAt: number, memoryId: string | null = `mem-${contentId}`, platform = 'claude'): void {
    const id = store.createSDKSession(contentId, project, 'first prompt', undefined, platform);
    if (memoryId) store.ensureMemorySessionIdRegistered(id, memoryId);
    store.db.prepare('UPDATE sdk_sessions SET started_at_epoch = ? WHERE id = ?').run(startedAt, id);
  }

  function summary(memoryId: string, project: string, request: string | null, createdAt: number): number {
    return Number(store.db.prepare(`
      INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(memoryId, project, request, new Date(createdAt).toISOString(), createdAt).lastInsertRowid);
  }

  const row = (contentId: string) => {
    const found = store.getSessionCatalog().sessions.find(entry => entry.content_session_id === contentId);
    if (!found) throw new Error(`${contentId} is not in the catalog`);
    return found;
  };

  it('titles a session by its newest summary, trimmed, even when an older one was saved later', () => {
    session('a', 'proj', 1);
    summary('mem-a', 'proj', 'Older ask', 1000);
    summary('mem-a', 'proj', '  Newest ask\n', 2000);
    // Saved last (higher id) but older: an import or a synced copy. Time decides, not id.
    summary('mem-a', 'proj', 'Late copy of an old ask', 500);

    expect(row('a').summary_title).toBe('Newest ask');
  });

  it('breaks a tie on time with the newer id', () => {
    session('tie', 'proj', 1);
    summary('mem-tie', 'proj', 'First at 3000', 3000);
    summary('mem-tie', 'proj', 'Second at 3000', 3000);

    expect(row('tie').summary_title).toBe('Second at 3000');
  });

  it('skips newer summaries whose request has no words and keeps counting them', () => {
    session('blank', 'proj', 1);
    summary('mem-blank', 'proj', 'Older ask with words', 1000);
    summary('mem-blank', 'proj', '', 4000);
    summary('mem-blank', 'proj', null, 5000);
    // Every character JavaScript's trim() removes, so the UI and the query agree on "no words".
    summary('mem-blank', 'proj', ' \t\n\r\u000b\u000c       　﻿', 6000);

    const entry = row('blank');
    expect(entry.summary_title).toBe('Older ask with words');
    expect(entry.item_count).toBe(4);
  });

  it('is null for a session with no summary, only blank summaries, or no memory session yet', () => {
    session('none', 'proj', 1);
    session('only-blank', 'proj', 2);
    summary('mem-only-blank', 'proj', '   ', 1000);
    summary('mem-only-blank', 'proj', null, 2000);
    session('unregistered', 'proj', 3, null);
    session('titled', 'proj', 4);
    summary('mem-titled', 'proj', 'Has a title', 1000);

    expect(row('none').summary_title).toBeNull();
    expect(row('only-blank').summary_title).toBeNull();
    expect(row('unregistered').summary_title).toBeNull();
    expect(row('titled').summary_title).toBe('Has a title');
    // The field is always present (null, never missing), so the viewer can tell this worker from an older one.
    expect(store.getSessionCatalog().sessions.every(entry => 'summary_title' in entry)).toBe(true);
  });

  it('never takes another session’s summary, even one saved at the same moment', () => {
    session('quiet', 'proj', 1);
    session('busy', 'proj', 2);
    session('elsewhere', 'other-proj', 3);
    // Same time on every row: the lookup by time must still stay inside each session.
    summary('mem-quiet', 'proj', '', 5000);
    summary('mem-busy', 'proj', 'Busy session ask', 5000);
    summary('mem-elsewhere', 'other-proj', 'Other project ask', 5000);
    session('own', 'proj', 4);
    summary('mem-own', 'proj', 'Own ask', 5000);
    summary('mem-busy', 'proj', 'Busy session later ask', 5000);

    expect(row('quiet').summary_title).toBeNull();
    expect(row('busy').summary_title).toBe('Busy session later ask');
    expect(row('own').summary_title).toBe('Own ask');
    expect(row('elsewhere').summary_title).toBe('Other project ask');
  });

  it('keeps observer sessions out of the catalog', () => {
    session('observer', OBSERVER_SESSIONS_PROJECT, 10);
    summary('mem-observer', OBSERVER_SESSIONS_PROJECT, 'Observer ask', 1000);
    session('visible', 'proj', 1);

    expect(store.getSessionCatalog().sessions.map(entry => entry.content_session_id)).toEqual(['visible']);
  });

  it('pages, orders and filters exactly as before, with each title on its own row', () => {
    for (const [id, startedAt, platform] of [['s5', 5000, 'claude'], ['s4', 4000, 'codex'], ['s3', 3000, 'claude'], ['s2', 2000, 'codex'], ['s1', 1000, 'claude']] as const) {
      session(id, 'Repo', startedAt, `mem-${id}`, platform);
      summary(`mem-${id}`, 'Repo', `Ask of ${id}`, startedAt + 1);
    }
    session('other', 'Other', 9000);

    const first = store.getSessionCatalog({ project: 'repo', limit: 2 });
    expect(first.sessions.map(entry => [entry.content_session_id, entry.summary_title])).toEqual([['s5', 'Ask of s5'], ['s4', 'Ask of s4']]);
    expect(first.hasMore).toBe(true);
    const second = store.getSessionCatalog({ project: 'repo', limit: 2, offset: 2 });
    expect(second.sessions.map(entry => [entry.content_session_id, entry.summary_title])).toEqual([['s3', 'Ask of s3'], ['s2', 'Ask of s2']]);
    expect(second.hasMore).toBe(true);
    const last = store.getSessionCatalog({ project: 'repo', limit: 2, offset: 4 });
    expect(last.sessions.map(entry => entry.content_session_id)).toEqual(['s1']);
    expect(last.hasMore).toBe(false);
    expect(store.getSessionCatalog({ project: 'REPO', platformSource: 'codex' }).sessions
      .map(entry => [entry.content_session_id, entry.summary_title])).toEqual([['s4', 'Ask of s4'], ['s2', 'Ask of s2']]);
    expect(store.getSessionCatalog({ limit: 1 }).sessions).toEqual([expect.objectContaining({ content_session_id: 'other', summary_title: null, item_count: 0 })]);
  });
});
