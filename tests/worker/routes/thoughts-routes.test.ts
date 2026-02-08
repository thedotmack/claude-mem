/**
 * ThoughtsRoutes API endpoint tests
 *
 * Tests POST /api/thoughts, GET /api/thoughts, GET /api/thoughts/search
 * with real HTTP server and in-memory SQLite database.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';

import express from 'express';

// Mock middleware — include express.json() so POST bodies are parsed
mock.module('../../../src/services/worker/http/middleware.js', () => ({
  createMiddleware: () => [express.json({ limit: '50mb' })],
  requireLocalhost: (_req: any, _res: any, next: any) => next(),
  summarizeRequestBody: () => 'test body',
}));

import { Server } from '../../../src/services/server/Server.js';
import type { ServerOptions } from '../../../src/services/server/Server.js';
import { ThoughtsRoutes } from '../../../src/services/worker/http/routes/ThoughtsRoutes.js';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import type { Database } from 'bun:sqlite';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('ThoughtsRoutes', () => {
  let server: Server;
  let testPort: number;
  let store: SessionStore;
  let rawDb: Database;

  beforeEach(async () => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    // Create in-memory DB with all migrations
    const claudeDb = new ClaudeMemDatabase(':memory:');
    rawDb = claudeDb.db;

    // Create SessionStore backed by the migrated DB
    store = Object.create(SessionStore.prototype);
    store.db = rawDb;

    const mockOptions: ServerOptions = {
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
    };

    testPort = 40000 + Math.floor(Math.random() * 10000);

    server = new Server(mockOptions);
    server.registerRoutes(new ThoughtsRoutes(store));
    await server.listen(testPort, '127.0.0.1');
  });

  afterEach(async () => {
    loggerSpies.forEach(spy => spy.mockRestore());
    if (server?.getHttpServer()) {
      try { await server.close(); } catch { /* ignore */ }
    }
    rawDb.close();
    mock.restore();
  });

  function baseUrl(path: string): string {
    return `http://127.0.0.1:${testPort}${path}`;
  }

  describe('POST /api/thoughts', () => {
    it('should store thoughts and return ids', async () => {
      const response = await fetch(baseUrl('/api/thoughts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memorySessionId: 'mem-1',
          contentSessionId: 'cs-1',
          project: 'test-project',
          thoughts: [
            { thinking_text: 'First thought', thinking_summary: 'Summary 1', message_index: 0 },
            { thinking_text: 'Second thought', thinking_summary: null, message_index: 1 },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.stored).toBe(2);
      expect(body.ids).toHaveLength(2);
      expect(body.ids[0]).toBeGreaterThan(0);
    });

    it('should return 400 when memorySessionId is missing', async () => {
      const response = await fetch(baseUrl('/api/thoughts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: 'test-project',
          thoughts: [{ thinking_text: 'text', thinking_summary: null, message_index: 0 }],
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('memorySessionId');
    });

    it('should return 400 when project is missing', async () => {
      const response = await fetch(baseUrl('/api/thoughts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memorySessionId: 'mem-1',
          thoughts: [{ thinking_text: 'text', thinking_summary: null, message_index: 0 }],
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('project');
    });

    it('should return 400 when thoughts array is empty', async () => {
      const response = await fetch(baseUrl('/api/thoughts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memorySessionId: 'mem-1',
          project: 'test-project',
          thoughts: [],
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('thoughts');
    });

    it('should return 400 when thoughts is missing', async () => {
      const response = await fetch(baseUrl('/api/thoughts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memorySessionId: 'mem-1',
          project: 'test-project',
        }),
      });

      expect(response.status).toBe(400);
    });

    it('should store thoughts with null contentSessionId', async () => {
      const response = await fetch(baseUrl('/api/thoughts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memorySessionId: 'mem-1',
          contentSessionId: null,
          project: 'test-project',
          thoughts: [{ thinking_text: 'text', thinking_summary: null, message_index: 0 }],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.stored).toBe(1);
    });
  });

  describe('GET /api/thoughts', () => {
    beforeEach(() => {
      // Seed test data
      const stmt = rawDb.prepare(`
        INSERT INTO thoughts (memory_session_id, content_session_id, project, thinking_text, thinking_summary, message_index, prompt_number, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run('mem-1', 'cs-1', 'project-a', 'alpha thought', 'summary-a', 0, 1, '2026-01-01T00:00:00Z', 1000);
      stmt.run('mem-1', 'cs-1', 'project-a', 'beta thought', 'summary-b', 1, 1, '2026-01-02T00:00:00Z', 2000);
      stmt.run('mem-1', 'cs-1', 'project-a', 'gamma thought', 'summary-c', 2, 2, '2026-01-03T00:00:00Z', 3000);
      stmt.run('mem-2', 'cs-2', 'project-b', 'delta thought', 'summary-d', 0, 1, '2026-01-04T00:00:00Z', 4000);
    });

    it('should return thoughts for a project', async () => {
      const response = await fetch(baseUrl('/api/thoughts?project=project-a'));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.thoughts).toHaveLength(3);
      expect(body.thoughts.every((t: any) => t.project === 'project-a')).toBe(true);
    });

    it('should return thoughts ordered by created_at_epoch DESC', async () => {
      const response = await fetch(baseUrl('/api/thoughts?project=project-a'));
      const body = await response.json();

      expect(body.thoughts[0].created_at_epoch).toBe(3000);
      expect(body.thoughts[1].created_at_epoch).toBe(2000);
      expect(body.thoughts[2].created_at_epoch).toBe(1000);
    });

    it('should respect limit parameter', async () => {
      const response = await fetch(baseUrl('/api/thoughts?project=project-a&limit=2'));
      const body = await response.json();

      expect(body.thoughts).toHaveLength(2);
    });

    it('should filter by startEpoch', async () => {
      const response = await fetch(baseUrl('/api/thoughts?project=project-a&startEpoch=2000'));
      const body = await response.json();

      expect(body.thoughts).toHaveLength(2);
      expect(body.thoughts.every((t: any) => t.created_at_epoch >= 2000)).toBe(true);
    });

    it('should filter by endEpoch', async () => {
      const response = await fetch(baseUrl('/api/thoughts?project=project-a&endEpoch=2000'));
      const body = await response.json();

      expect(body.thoughts).toHaveLength(2);
      expect(body.thoughts.every((t: any) => t.created_at_epoch <= 2000)).toBe(true);
    });

    it('should return 400 when project is missing', async () => {
      const response = await fetch(baseUrl('/api/thoughts'));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('project');
    });

    it('should return empty array for unknown project', async () => {
      const response = await fetch(baseUrl('/api/thoughts?project=nonexistent'));
      const body = await response.json();

      expect(body.thoughts).toHaveLength(0);
    });
  });

  describe('GET /api/thoughts/search', () => {
    beforeEach(() => {
      // Insert via storeThoughts to ensure FTS is populated
      store.storeThoughts(
        'mem-1', 'cs-1', 'project-a',
        [
          { thinking_text: 'analyzing database schema optimization', thinking_summary: 'db analysis', message_index: 0 },
          { thinking_text: 'implementing JWT authentication flow', thinking_summary: 'auth work', message_index: 1 },
        ],
        1
      );
      store.storeThoughts(
        'mem-2', 'cs-2', 'project-b',
        [{ thinking_text: 'reviewing database migration strategy', thinking_summary: 'migration', message_index: 0 }],
        1
      );
    });

    it('should find thoughts matching query', async () => {
      const response = await fetch(baseUrl('/api/thoughts/search?query=database'));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.thoughts.length).toBeGreaterThanOrEqual(1);
      expect(body.count).toBe(body.thoughts.length);
    });

    it('should filter by project', async () => {
      const response = await fetch(baseUrl('/api/thoughts/search?query=database&project=project-a'));
      const body = await response.json();

      expect(body.thoughts).toHaveLength(1);
      expect(body.thoughts[0].project).toBe('project-a');
    });

    it('should respect limit', async () => {
      const response = await fetch(baseUrl('/api/thoughts/search?query=database&limit=1'));
      const body = await response.json();

      expect(body.thoughts).toHaveLength(1);
    });

    it('should return 400 when query is missing', async () => {
      const response = await fetch(baseUrl('/api/thoughts/search'));
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.error).toContain('query');
    });

    it('should return empty for no matches', async () => {
      const response = await fetch(baseUrl('/api/thoughts/search?query=xyznonexistent'));
      const body = await response.json();

      expect(body.thoughts).toHaveLength(0);
      expect(body.count).toBe(0);
    });
  });
});
