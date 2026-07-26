import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { CloudSync } from '../../../../src/services/sync/CloudSync.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

describe('DataRoutes synchronized delete APIs', () => {
  let db: Database;
  let tempDir: string;
  let store: SessionStore;
  let sync: CloudSync;
  let handlers: Map<string, (req: Request, res: Response) => void>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cmem-delete-routes-'));
    db = new Database(':memory:');
    store = new SessionStore(db);
    sync = new CloudSync(db, {
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'test-token',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'test-user',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'device-delete-routes',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'test',
    }, {
      settingsPath: join(tempDir, 'settings.json'),
      fetchImpl: mock(async () => new Response('{}', { status: 500 })) as typeof fetch,
    });

    db.prepare(`
      INSERT INTO sdk_sessions
        (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES ('content-delete', 'memory-delete', 'project-delete',
              '2026-07-20T00:00:00.000Z', 1752969600000, 'completed')
    `).run();
    db.prepare(`
      INSERT INTO observations
        (memory_session_id, project, type, title, created_at, created_at_epoch)
      VALUES ('memory-delete', 'project-delete', 'discovery', 'delete me',
              '2026-07-20T00:00:00.000Z', 1752969600000)
    `).run();
    db.prepare(`
      INSERT INTO session_summaries
        (memory_session_id, project, request, created_at, created_at_epoch)
      VALUES ('memory-delete', 'project-delete', 'delete summary',
              '2026-07-20T00:00:00.000Z', 1752969600000)
    `).run();
    db.prepare(`
      INSERT INTO user_prompts
        (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (1, 'content-delete', 1, 'delete prompt',
              '2026-07-20T00:00:00.000Z', 1752969600000)
    `).run();

    const routes = new DataRoutes(
      {} as any,
      { getSessionStore: () => store, getCloudSync: () => sync } as any,
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
  });

  afterEach(() => {
    sync.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('atomically tombstones observation, summary, and prompt deletions through registered production routes', () => {
    const cases = [
      ['/api/observation/:id', 'observation', 'observations'],
      ['/api/summary/:id', 'summary', 'session_summaries'],
      ['/api/prompt/:id', 'prompt', 'user_prompts'],
    ] as const;

    for (const [path, kind, table] of cases) {
      let status = 200;
      let responseBody: any;
      const response = {
        status(code: number) { status = code; return this; },
        json(value: unknown) { responseBody = value; return this; },
      } as unknown as Response;
      handlers.get(path)!({ params: { id: '1' }, path } as unknown as Request, response);

      expect(status).toBe(200);
      expect(responseBody).toMatchObject({ success: true, id: '1', kind, entity_rev: '2' });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }

    const outbox = db.prepare(`
      SELECT kind, entity_rev, deleted, body FROM sync_content_outbox ORDER BY id
    `).all() as Array<{ kind: string; entity_rev: string; deleted: number; body: string }>;
    expect(outbox.map(row => [row.kind, row.entity_rev, row.deleted])).toEqual([
      ['observation', '2', 1],
      ['summary', '2', 1],
      ['prompt', '2', 1],
    ]);
    for (const row of outbox) {
      expect(JSON.parse(row.body)).toMatchObject({ kind: row.kind, deleted: true, payload: null });
    }
  });
});
