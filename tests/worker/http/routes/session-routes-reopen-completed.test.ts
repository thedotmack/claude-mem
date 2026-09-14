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

  it('a prompt on a completed row puts it back to active', async () => {
    const id = store.createSDKSession('resumed', 'proj', 'hello');
    store.saveUserPrompt('resumed', 1, 'hello', id);
    store.markSessionCompleted(id);
    expect(readRow(store, id).status).toBe('completed');

    const routes = buildRoutes();
    const { res, done } = fakeRes();
    (routes as any).handleSessionInitByClaudeId(fakeReq({
      contentSessionId: 'resumed', project: 'proj', prompt: 'hello',
    }), res);
    const payload = await done;

    expect(payload.reason).toBe('duplicate');
    const row = readRow(store, id);
    expect(row.status).toBe('active');
    expect(row.completed_at_epoch).toBeNull();
  });
});
