import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import type { Request, Response } from 'express';

/**
 * Issue #4080, the wiring half: the store can reopen a completed row, but only
 * the session-init route may do it. This drives the real handler and stops at
 * its duplicate-prompt early return, which is reached AFTER session resolution
 * and before anything that would need a live generator.
 */
type Row = { status: string; completed_at_epoch: number | null };

function readRow(store: SessionStore, id: number): Row {
  return store.db.prepare(
    'SELECT status, completed_at_epoch FROM sdk_sessions WHERE id = ?'
  ).get(id) as Row;
}

function fakeReq(body: Record<string, unknown>): Request {
  return { body, query: {}, path: '/session-init', get: () => undefined } as unknown as Request;
}

function fakeRes(): { res: Response; done: Promise<Record<string, unknown>> } {
  let resolve!: (value: Record<string, unknown>) => void;
  const done = new Promise<Record<string, unknown>>((r) => { resolve = r; });
  const res = {
    json: (payload: Record<string, unknown>) => { resolve(payload); return res; },
    status: () => res,
  } as unknown as Response;
  return { res, done };
}

describe('session-init reopens a continued session (#4080)', () => {
  let store: SessionStore;

  beforeEach(() => { store = new SessionStore(':memory:'); });
  afterEach(() => { store.close(); });

  function buildRoutes(): SessionRoutes {
    const dbManager = {
      getSessionStore: () => store,
      getCloudSync: () => undefined,
      getChromaSync: () => undefined,
    };
    const sessionManager = { getSession: () => undefined };
    return new SessionRoutes(
      sessionManager as any,
      dbManager as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  }

  it('a new prompt on a completed row puts it back to active', async () => {
    // platform_source 'cursor' so the handler stops after saving the prompt
    // instead of starting a generator — the reopen has already happened by
    // then, and a live SDK agent is not what this cell is about.
    const id = store.createSDKSession('resumed', 'proj', 'first', undefined, 'cursor');
    store.saveUserPrompt('resumed', 1, 'first', id);
    store.markSessionCompleted(id);
    expect(readRow(store, id).status).toBe('completed');

    const routes = buildRoutes();
    const { res, done } = fakeRes();
    (routes as any).handleSessionInitByClaudeId(fakeReq({
      contentSessionId: 'resumed', project: 'proj', prompt: 'second', platform_source: 'cursor',
    }), res);
    await done;

    const row = readRow(store, id);
    expect(row.status).toBe('active');
    expect(row.completed_at_epoch).toBeNull();
  });

  it('a DUPLICATE prompt leaves the completed row alone', async () => {
    // Greptile's finding on this PR: the reopen used to run before the
    // duplicate gate, so a retry of an already-saved prompt cleared the
    // completion and then returned early — saving no prompt and starting no
    // work that would ever finalize the session again. The row stayed
    // 'active' for good, which is #2373's bug in the other direction.
    const id = store.createSDKSession('resumed', 'proj', 'hello', undefined, 'cursor');
    store.saveUserPrompt('resumed', 1, 'hello', id);
    store.markSessionCompleted(id);
    const firstEnd = readRow(store, id).completed_at_epoch;

    const routes = buildRoutes();
    const { res, done } = fakeRes();
    (routes as any).handleSessionInitByClaudeId(fakeReq({
      contentSessionId: 'resumed', project: 'proj', prompt: 'hello', platform_source: 'cursor',
    }), res);
    const payload = await done;

    expect(payload.reason).toBe('duplicate');
    const row = readRow(store, id);
    expect(row.status).toBe('completed');
    expect(row.completed_at_epoch).toBe(firstEnd);
  });
});
