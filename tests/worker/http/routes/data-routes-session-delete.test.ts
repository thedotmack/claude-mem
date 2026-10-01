import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { CloudSync } from '../../../../src/services/sync/CloudSync.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

function seedSession(db: Database, contentSessionId: string, memorySessionId: string, project: string, platformSource = 'claude') {
  db.prepare(`
    INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, ?, '2026-07-20T00:00:00.000Z', 1752969600000, 'completed')
  `).run(contentSessionId, memorySessionId, project, platformSource);
  const sessionDbId = (db.prepare(
    `SELECT id FROM sdk_sessions WHERE content_session_id = ? AND platform_source = ?`
  ).get(contentSessionId, platformSource) as { id: number }).id;
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
    VALUES (?, ?, 'discovery', 'obs', '2026-07-20T00:00:00.000Z', 1752969600000)
  `).run(memorySessionId, project);
  db.prepare(`
    INSERT INTO session_summaries (memory_session_id, project, request, created_at, created_at_epoch)
    VALUES (?, ?, 'req', '2026-07-20T00:00:00.000Z', 1752969600000)
  `).run(memorySessionId, project);
  db.prepare(`
    INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, ?, 1, 'prompt', '2026-07-20T00:00:00.000Z', 1752969600000)
  `).run(sessionDbId, contentSessionId);
  db.prepare(`
    INSERT INTO tool_uses (tool_use_id, content_session_id, session_db_id, project, platform_source, tool_name, tool_input, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, 'Bash', '{"command":"cat .env"}', '2026-07-20T00:00:00.000Z', 1752969600000)
  `).run(`tool-${contentSessionId}-${platformSource}`, contentSessionId, sessionDbId, project, platformSource);
  return sessionDbId;
}

const count = (db: Database, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('DELETE /api/sessions/:platformSource/:contentSessionId', () => {
  let db: Database;
  let tempDir: string;
  let store: SessionStore;
  let sync: CloudSync;
  let handlers: Map<string, (req: Request, res: Response) => void>;
  let broadcasts: Array<Record<string, unknown>>;
  let activeSessionIds: Set<number>;

  function setup(cloudSync: CloudSync | null) {
    broadcasts = [];
    const routes = new DataRoutes(
      {} as any,
      { getSessionStore: () => store, getCloudSync: () => cloudSync } as any,
      { getSession: (sessionDbId: number) => (activeSessionIds.has(sessionDbId) ? {} : undefined) } as any,
      { broadcast: (event: Record<string, unknown>) => { broadcasts.push(event); } } as any,
      {} as any,
      Date.now(),
    );
    handlers = new Map();
    routes.setupRoutes({
      get: mock(() => {}),
      post: mock(() => {}),
      delete: mock((path: string, handler: (req: Request, res: Response) => void) => {
        handlers.set(path, handler);
      }),
    } as any);
  }

  function callDelete(platformSource: string, contentSessionId: string) {
    let status = 200;
    let body: any;
    const response = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as unknown as Response;
    handlers.get('/api/sessions/:platformSource/:contentSessionId')!(
      { params: { platformSource, contentSessionId }, query: {}, path: '/api/sessions', get: () => undefined } as unknown as Request,
      response,
    );
    return { status, body };
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cmem-session-delete-'));
    db = new Database(':memory:');
    store = new SessionStore(db);
    activeSessionIds = new Set();
    sync = new CloudSync(db, {
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'test-token',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'test-user',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'device-session-delete',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'test',
    }, {
      settingsPath: join(tempDir, 'settings.json'),
      fetchImpl: mock(async () => new Response('{}', { status: 500 })) as typeof fetch,
    });
  });

  afterEach(() => {
    sync.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('deletes the session, tombstones every child row, drops its tool I/O and tells open tabs', () => {
    seedSession(db, 'content-del', 'memory-del', 'proj-del');
    setup(sync);

    const { status, body } = callDelete('claude', 'content-del');

    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      platformSource: 'claude',
      contentSessionId: 'content-del',
      deletedCounts: { observations: 1, summaries: 1, prompts: 1, toolUses: 1 },
    });
    for (const table of ['observations', 'session_summaries', 'user_prompts', 'tool_uses', 'sdk_sessions']) {
      expect(count(db, table)).toBe(0);
    }
    const outbox = db.prepare(`SELECT kind, deleted FROM sync_content_outbox ORDER BY id`).all() as Array<{ kind: string; deleted: number }>;
    expect(outbox.map(row => row.kind).sort()).toEqual(['observation', 'prompt', 'summary']);
    expect(outbox.every(row => row.deleted === 1)).toBe(true);
    expect(broadcasts).toEqual([{ type: 'session_deleted', platformSource: 'claude', contentSessionId: 'content-del' }]);
  });

  it('identifies a session by platform and content id: the same id under another platform is untouched', () => {
    seedSession(db, 'shared-id', 'memory-claude', 'proj', 'claude');
    seedSession(db, 'shared-id', 'memory-codex', 'proj', 'codex');
    setup(null);

    const { status, body } = callDelete('codex', 'shared-id');

    expect(status).toBe(200);
    expect(body.deletedCounts).toEqual({ observations: 1, summaries: 1, prompts: 1, toolUses: 1 });
    const left = db.prepare(`SELECT platform_source FROM sdk_sessions`).all() as Array<{ platform_source: string }>;
    expect(left).toEqual([{ platform_source: 'claude' }]);
    expect(count(db, 'observations')).toBe(1);
    expect(count(db, 'tool_uses')).toBe(1);
  });

  it('refuses with 409 while the session holds rows synced from another device, deleting nothing', () => {
    seedSession(db, 'content-mixed', 'memory-mixed', 'proj-mixed');
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch, origin_device_id, origin_local_id)
      VALUES ('memory-mixed', 'proj-mixed', 'discovery', 'from laptop', '2026-07-20T00:00:00.000Z', 1752969600000, 'other-device', '77')
    `).run();
    setup(sync);

    const { status, body } = callDelete('claude', 'content-mixed');

    expect(status).toBe(409);
    expect(body.remoteItemCount).toBe(1);
    // The FK cascade would have dropped the replicated row without a tombstone.
    expect(count(db, 'observations')).toBe(2);
    expect(count(db, 'sdk_sessions')).toBe(1);
    expect(count(db, 'sync_content_outbox')).toBe(0);
    expect(broadcasts).toEqual([]);
  });

  it('refuses with 409 while the session is still active in the worker', () => {
    const sessionDbId = seedSession(db, 'content-live', 'memory-live', 'proj-live');
    activeSessionIds.add(sessionDbId);
    setup(null);

    const { status } = callDelete('claude', 'content-live');

    expect(status).toBe(409);
    expect(count(db, 'sdk_sessions')).toBe(1);
    expect(count(db, 'observations')).toBe(1);
  });

  it('rolls back every tombstone and delete when one child fails part-way', () => {
    seedSession(db, 'content-fail', 'memory-fail', 'proj-fail');
    const realQueueDelete = sync.queueDelete.bind(sync);
    let calls = 0;
    sync.queueDelete = ((kind, originLocalId) => {
      calls++;
      if (calls === 2) throw new Error('disk full');
      return realQueueDelete(kind, originLocalId);
    }) as typeof sync.queueDelete;
    setup(sync);

    const { status } = callDelete('claude', 'content-fail');

    expect(status).toBe(500);
    for (const table of ['observations', 'session_summaries', 'user_prompts', 'tool_uses', 'sdk_sessions']) {
      expect(count(db, table)).toBe(1);
    }
    expect(count(db, 'sync_content_outbox')).toBe(0);
    expect(broadcasts).toEqual([]);
  });

  it('404s for an unknown session and deletes nothing', () => {
    seedSession(db, 'content-keep', 'memory-keep', 'proj-keep');
    setup(sync);
    expect(callDelete('claude', 'does-not-exist').status).toBe(404);
    expect(callDelete('codex', 'content-keep').status).toBe(404);
    expect(count(db, 'sdk_sessions')).toBe(1);
  });

  it('refuses and deletes nothing when a child row is already sync-acknowledged and cloud sync is unavailable', () => {
    seedSession(db, 'content-guard', 'memory-guard', 'proj-guard');
    const obsId = (db.prepare(`SELECT id FROM observations WHERE memory_session_id = 'memory-guard'`).get() as { id: number }).id;
    db.prepare(`
      INSERT INTO sync_entity_heads (entity_id, kind, origin_device_id, origin_local_id, entity_rev, operation_sha256, deleted, updated_at_epoch)
      VALUES ('entity-1', 'observation', 'some-other-device', ?, '1', 'sha', 0, 1752969600000)
    `).run(String(obsId));

    setup(null); // cloud sync unavailable

    const { status } = callDelete('claude', 'content-guard');

    expect(status).toBe(503);
    expect(count(db, 'observations')).toBe(1);
    expect(count(db, 'session_summaries')).toBe(1);
    expect(count(db, 'sdk_sessions')).toBe(1);
  });
});
