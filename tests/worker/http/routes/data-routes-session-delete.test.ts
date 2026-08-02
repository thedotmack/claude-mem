import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { CloudSync } from '../../../../src/services/sync/CloudSync.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

function seedSession(db: Database, contentSessionId: string, memorySessionId: string, project: string) {
  db.prepare(`
    INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, '2026-07-20T00:00:00.000Z', 1752969600000, 'completed')
  `).run(contentSessionId, memorySessionId, project);
  const sessionDbId = (db.prepare(`SELECT id FROM sdk_sessions WHERE content_session_id = ?`).get(contentSessionId) as { id: number }).id;
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
  return sessionDbId;
}

function callDelete(handlers: Map<string, (req: Request, res: Response) => void>, contentSessionId: string) {
  let status = 200;
  let body: any;
  const response = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  } as unknown as Response;
  handlers.get('/api/sessions/:contentSessionId')!(
    { params: { contentSessionId }, query: {}, get: () => undefined } as unknown as Request,
    response,
  );
  return { status, body };
}

describe('DELETE /api/sessions/:contentSessionId', () => {
  let db: Database;
  let tempDir: string;
  let store: SessionStore;
  let sync: CloudSync;
  let handlers: Map<string, (req: Request, res: Response) => void>;

  function setup(cloudSync: CloudSync | null) {
    const routes = new DataRoutes(
      {} as any,
      { getSessionStore: () => store, getCloudSync: () => cloudSync } as any,
      {} as any,
      {} as any,
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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cmem-session-delete-'));
    db = new Database(':memory:');
    store = new SessionStore(db);
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

  it('deletes all content for the session plus the session row, tombstoning each child row', () => {
    seedSession(db, 'content-del', 'memory-del', 'proj-del');
    setup(sync);

    const { status, body } = callDelete(handlers, 'content-del');

    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      contentSessionId: 'content-del',
      deletedCounts: { observations: 1, summaries: 1, prompts: 1 },
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM observations`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM session_summaries`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM user_prompts`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sdk_sessions`).get()).toEqual({ n: 0 });

    const outbox = db.prepare(`SELECT kind FROM sync_content_outbox ORDER BY id`).all() as Array<{ kind: string }>;
    expect(outbox.map(row => row.kind).sort()).toEqual(['observation', 'prompt', 'summary']);
  });

  it('404s for an unknown session and deletes nothing', () => {
    setup(sync);
    const { status } = callDelete(handlers, 'does-not-exist');
    expect(status).toBe(404);
  });

  it('refuses and deletes nothing when a child row is already sync-acknowledged and cloud sync is unavailable', () => {
    const sessionDbId = seedSession(db, 'content-guard', 'memory-guard', 'proj-guard');
    const obsId = (db.prepare(`SELECT id FROM observations WHERE memory_session_id = 'memory-guard'`).get() as { id: number }).id;
    db.prepare(`
      INSERT INTO sync_entity_heads (entity_id, kind, origin_device_id, origin_local_id, entity_rev, operation_sha256, deleted, updated_at_epoch)
      VALUES ('entity-1', 'observation', 'some-other-device', ?, '1', 'sha', 0, 1752969600000)
    `).run(String(obsId));

    setup(null); // cloud sync unavailable

    const { status } = callDelete(handlers, 'content-guard');

    expect(status).toBe(503);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM observations`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM session_summaries`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sdk_sessions`).get()).toEqual({ n: 1 });
    void sessionDbId;
  });
});
