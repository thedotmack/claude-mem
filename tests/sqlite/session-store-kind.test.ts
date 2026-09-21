import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { PaginationHelper } from '../../src/services/worker/PaginationHelper.js';
import {
  SESSION_KIND_USER,
  SESSION_KIND_INTERNAL,
  SESSION_KIND_KEEPALIVE,
} from '../../src/shared/session-kind.js';
import { OBSERVER_SESSIONS_PROJECT } from '../../src/shared/paths.js';

const OBSERVATION = {
  type: 'discovery',
  title: 'Obs',
  subtitle: null,
  facts: [],
  narrative: 'body',
  concepts: [],
  files_read: [],
  files_modified: [],
};

const SUMMARY = {
  request: 'req',
  investigated: 'inv',
  learned: 'learned',
  completed: 'done',
  next_steps: 'next',
  notes: null,
};

function seedSession(
  store: SessionStore,
  opts: { contentId: string; memoryId: string; project: string; kind?: string },
): number {
  const id = store.createSDKSession(opts.contentId, opts.project, 'prompt', undefined, undefined, opts.kind);
  store.updateMemorySessionId(id, opts.memoryId);
  store.storeObservation(opts.memoryId, opts.project, OBSERVATION, 1);
  store.storeSummary(opts.memoryId, opts.project, SUMMARY, 1);
  store.saveUserPrompt(opts.contentId, 1, 'a real prompt', id);
  return id;
}

describe('SessionStore session kind (#4159)', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('defaults a plain session to the user kind', () => {
    const id = store.createSDKSession('content-user', 'real-project', 'prompt');
    expect(store.getSessionById(id)?.kind).toBe(SESSION_KIND_USER);
  });

  it('derives the internal kind for the observer-sessions project', () => {
    const id = store.createSDKSession('content-observer', OBSERVER_SESSIONS_PROJECT, 'prompt');
    expect(store.getSessionById(id)?.kind).toBe(SESSION_KIND_INTERNAL);
  });

  it('honors an explicit keepalive kind under a real project name', () => {
    const id = store.createSDKSession('content-ping', 'real-project', 'prompt', undefined, undefined, SESSION_KIND_KEEPALIVE);
    expect(store.getSessionById(id)?.kind).toBe(SESSION_KIND_KEEPALIVE);
  });

  it('falls back to user for an unknown kind', () => {
    const id = store.createSDKSession('content-weird', 'real-project', 'prompt', undefined, undefined, 'bogus');
    expect(store.getSessionById(id)?.kind).toBe(SESSION_KIND_USER);
  });

  it('backfills pre-existing observer-sessions rows to internal on migration', () => {
    const id = store.createSDKSession('content-legacy', OBSERVER_SESSIONS_PROJECT, 'prompt');

    // Simulate a DB that predates the kind column, then re-run the migration.
    store.db.run('DROP INDEX IF EXISTS idx_sdk_sessions_kind');
    store.db.run('ALTER TABLE sdk_sessions DROP COLUMN kind');
    store.db.run('DELETE FROM schema_versions WHERE version = 53');
    (store as any).ensureSDKSessionsKindColumn();

    expect(store.getSessionById(id)?.kind).toBe(SESSION_KIND_INTERNAL);
  });

  describe('picker listing keeps only user sessions', () => {
    const SHARED_PROJECT = 'shared-project';
    let helper: PaginationHelper;

    beforeEach(() => {
      seedSession(store, { contentId: 'c-user', memoryId: 'm-user', project: SHARED_PROJECT, kind: SESSION_KIND_USER });
      seedSession(store, { contentId: 'c-internal', memoryId: 'm-internal', project: SHARED_PROJECT, kind: SESSION_KIND_INTERNAL });
      seedSession(store, { contentId: 'c-keepalive', memoryId: 'm-keepalive', project: SHARED_PROJECT, kind: SESSION_KIND_KEEPALIVE });
      helper = new PaginationHelper({ getSessionStore: () => store } as any);
    });

    it('hides internal and keepalive observations even with a project filter', () => {
      const sessions = helper.getObservations(0, 50, SHARED_PROJECT).items.map(o => o.memory_session_id);
      expect(sessions).toEqual(['m-user']);
    });

    it('hides internal and keepalive summaries even with a project filter', () => {
      const sessions = helper.getSummaries(0, 50, SHARED_PROJECT).items.map(s => s.session_id);
      expect(sessions).toEqual(['c-user']);
    });

    it('hides internal and keepalive prompts even with a project filter', () => {
      const prompts = helper.getPrompts(0, 50, SHARED_PROJECT).items.map(p => p.content_session_id);
      expect(prompts).toEqual(['c-user']);
    });
  });
});
