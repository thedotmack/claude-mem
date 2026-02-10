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

  describe('POST /api/thoughts with SSE broadcasting', () => {
    let sseServer: Server;
    let ssePort: number;
    let mockBroadcastThoughtStored: ReturnType<typeof mock>;

    beforeEach(async () => {
      mockBroadcastThoughtStored = mock(() => {});
      const mockBroadcaster = {
        broadcastThoughtStored: mockBroadcastThoughtStored,
      } as any;

      const sseOptions: ServerOptions = {
        getInitializationComplete: () => true,
        getMcpReady: () => true,
        onShutdown: mock(() => Promise.resolve()),
        onRestart: mock(() => Promise.resolve()),
      };

      ssePort = 40000 + Math.floor(Math.random() * 10000);
      sseServer = new Server(sseOptions);
      sseServer.registerRoutes(new ThoughtsRoutes(store, undefined, mockBroadcaster));
      await sseServer.listen(ssePort, '127.0.0.1');
    });

    afterEach(async () => {
      if (sseServer?.getHttpServer()) {
        try { await sseServer.close(); } catch { /* ignore */ }
      }
    });

    function sseUrl(path: string): string {
      return `http://127.0.0.1:${ssePort}${path}`;
    }

    it('should call broadcastThoughtStored for each stored thought', async () => {
      const response = await fetch(sseUrl('/api/thoughts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memorySessionId: 'mem-sse-1',
          contentSessionId: 'cs-1',
          project: 'test-project',
          thoughts: [
            { thinking_text: 'First SSE thought', thinking_summary: 'summary-1', message_index: 0 },
            { thinking_text: 'Second SSE thought', thinking_summary: 'summary-2', message_index: 1 },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.stored).toBe(2);

      expect(mockBroadcastThoughtStored).toHaveBeenCalledTimes(2);

      const firstCall = mockBroadcastThoughtStored.mock.calls[0][0];
      expect(firstCall.id).toBeGreaterThan(0);
      expect(firstCall.project).toBe('test-project');
      expect(firstCall.thinking_text).toBe('First SSE thought');
      expect(firstCall.created_at_epoch).toBeGreaterThan(0);

      const secondCall = mockBroadcastThoughtStored.mock.calls[1][0];
      expect(secondCall.thinking_text).toBe('Second SSE thought');
    });

    it('should not broadcast when no thoughts are stored (validation error)', async () => {
      const response = await fetch(sseUrl('/api/thoughts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memorySessionId: 'mem-sse-2',
          project: 'test-project',
          thoughts: [],
        }),
      });

      expect(response.status).toBe(400);
      expect(mockBroadcastThoughtStored).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/thoughts with ChromaSync', () => {
    let chromaServer: Server;
    let chromaPort: number;
    let mockSyncThoughts: ReturnType<typeof mock>;

    beforeEach(async () => {
      mockSyncThoughts = mock(() => Promise.resolve());
      const mockChromaSync = {
        syncThoughts: mockSyncThoughts,
      } as any;

      const chromaOptions: ServerOptions = {
        getInitializationComplete: () => true,
        getMcpReady: () => true,
        onShutdown: mock(() => Promise.resolve()),
        onRestart: mock(() => Promise.resolve()),
      };

      chromaPort = 40000 + Math.floor(Math.random() * 10000);
      chromaServer = new Server(chromaOptions);
      chromaServer.registerRoutes(new ThoughtsRoutes(store, mockChromaSync));
      await chromaServer.listen(chromaPort, '127.0.0.1');
    });

    afterEach(async () => {
      if (chromaServer?.getHttpServer()) {
        try { await chromaServer.close(); } catch { /* ignore */ }
      }
    });

    function chromaUrl(path: string): string {
      return `http://127.0.0.1:${chromaPort}${path}`;
    }

    it('should call syncThoughts after storing', async () => {
      const response = await fetch(chromaUrl('/api/thoughts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memorySessionId: 'mem-chroma-1',
          contentSessionId: 'cs-1',
          project: 'test-project',
          thoughts: [
            { thinking_text: 'Chroma sync test thought', thinking_summary: 'sync test', message_index: 0 },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.stored).toBe(1);

      // Give async sync a moment to fire
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mockSyncThoughts).toHaveBeenCalledTimes(1);
      const calledThoughts = mockSyncThoughts.mock.calls[0][0];
      expect(calledThoughts).toHaveLength(1);
      expect(calledThoughts[0].thinking_text).toBe('Chroma sync test thought');
    });

    it('should still store thoughts when chromaSync.syncThoughts rejects', async () => {
      mockSyncThoughts.mockImplementation(() => Promise.reject(new Error('Chroma unavailable')));

      const response = await fetch(chromaUrl('/api/thoughts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memorySessionId: 'mem-chroma-2',
          contentSessionId: 'cs-1',
          project: 'test-project',
          thoughts: [
            { thinking_text: 'Should still be stored', thinking_summary: null, message_index: 0 },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.stored).toBe(1);
      expect(body.ids).toHaveLength(1);
    });

    it('should not call syncThoughts when no chromaSync is provided', async () => {
      // The main server (from parent beforeEach) has no chromaSync
      const response = await fetch(baseUrl('/api/thoughts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          memorySessionId: 'mem-no-chroma',
          contentSessionId: 'cs-1',
          project: 'test-project',
          thoughts: [
            { thinking_text: 'No chroma test', thinking_summary: null, message_index: 0 },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.stored).toBe(1);
      // mockSyncThoughts should not have been called since main server has no chromaSync
      expect(mockSyncThoughts).not.toHaveBeenCalled();
    });
  });
});
