/**
 * SessionRoutes thoughts endpoint tests
 *
 * Tests POST /api/sessions/thoughts SSE broadcasting and Chroma sync.
 * Validates that the production hook path (which calls /api/sessions/thoughts)
 * triggers SSE events and Chroma vector sync after storing thoughts.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';

import express from 'express';

// Mock middleware
mock.module('../../../src/services/worker/http/middleware.js', () => ({
  createMiddleware: () => [express.json({ limit: '50mb' })],
  requireLocalhost: (_req: any, _res: any, next: any) => next(),
  summarizeRequestBody: () => 'test body',
}));

import { Server } from '../../../src/services/server/Server.js';
import type { ServerOptions } from '../../../src/services/server/Server.js';
import { SessionRoutes } from '../../../src/services/worker/http/routes/SessionRoutes.js';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import type { Database } from 'bun:sqlite';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('SessionRoutes /api/sessions/thoughts', () => {
  let server: Server;
  let testPort: number;
  let store: SessionStore;
  let rawDb: Database;
  let mockBroadcastThoughtStored: ReturnType<typeof mock>;
  let mockSyncThoughts: ReturnType<typeof mock>;

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

    // Seed a session so thoughts can resolve memorySessionId/project
    const now = new Date();
    rawDb.prepare(`
      INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('test-content-session', 'test-memory-session', 'test-project', now.toISOString(), now.getTime(), 'active');

    mockBroadcastThoughtStored = mock(() => {});
    mockSyncThoughts = mock(() => Promise.resolve());

    const mockEventBroadcaster = {
      broadcastThoughtStored: mockBroadcastThoughtStored,
      broadcastObservationStored: mock(() => {}),
      broadcastSessionComplete: mock(() => {}),
      broadcastProcessingStatus: mock(() => {}),
    } as any;

    const mockDbManager = {
      getSessionStore: () => store,
      getSessionSearch: () => ({}),
      getChromaSync: () => ({
        syncThoughts: mockSyncThoughts,
      }),
    } as any;

    const mockSessionManager = {
      getSession: () => null,
      createSession: () => 1,
    } as any;

    const mockSdkAgent = {} as any;
    const mockGeminiAgent = {} as any;
    const mockOpenRouterAgent = {} as any;
    const mockWorkerService = {} as any;

    const mockOptions: ServerOptions = {
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
    };

    testPort = 40000 + Math.floor(Math.random() * 10000);

    server = new Server(mockOptions);
    server.registerRoutes(new SessionRoutes(
      mockSessionManager,
      mockDbManager,
      mockSdkAgent,
      mockGeminiAgent,
      mockOpenRouterAgent,
      mockEventBroadcaster,
      mockWorkerService,
    ));
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

  it('should broadcast SSE events for each stored thought', async () => {
    const response = await fetch(baseUrl('/api/sessions/thoughts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: 'test-content-session',
        thoughts: [
          { thinking_text: 'First thought via SessionRoutes', thinking_summary: null, message_index: 0 },
          { thinking_text: 'Second thought via SessionRoutes', thinking_summary: null, message_index: 1 },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ids).toHaveLength(2);

    // Verify SSE broadcast was called for each thought
    expect(mockBroadcastThoughtStored).toHaveBeenCalledTimes(2);

    const firstCall = mockBroadcastThoughtStored.mock.calls[0][0];
    expect(firstCall.id).toBeGreaterThan(0);
    expect(firstCall.project).toBe('test-project');
    expect(firstCall.thinking_text).toBe('First thought via SessionRoutes');
    expect(firstCall.created_at_epoch).toBeGreaterThan(0);

    const secondCall = mockBroadcastThoughtStored.mock.calls[1][0];
    expect(secondCall.thinking_text).toBe('Second thought via SessionRoutes');
  });

  it('should trigger Chroma sync after storing thoughts', async () => {
    const response = await fetch(baseUrl('/api/sessions/thoughts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: 'test-content-session',
        thoughts: [
          { thinking_text: 'Chroma sync test via SessionRoutes', thinking_summary: null, message_index: 0 },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ids).toHaveLength(1);

    // Give async Chroma sync time to fire
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(mockSyncThoughts).toHaveBeenCalledTimes(1);
    const syncedThoughts = mockSyncThoughts.mock.calls[0][0];
    expect(syncedThoughts).toHaveLength(1);
    expect(syncedThoughts[0].thinking_text).toBe('Chroma sync test via SessionRoutes');
  });

  it('should not broadcast when contentSessionId is missing', async () => {
    const response = await fetch(baseUrl('/api/sessions/thoughts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thoughts: [
          { thinking_text: 'Should not broadcast', thinking_summary: null, message_index: 0 },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(mockBroadcastThoughtStored).not.toHaveBeenCalled();
    expect(mockSyncThoughts).not.toHaveBeenCalled();
  });

  it('should not broadcast when thoughts array is empty', async () => {
    const response = await fetch(baseUrl('/api/sessions/thoughts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: 'test-content-session',
        thoughts: [],
      }),
    });

    expect(response.status).toBe(400);
    expect(mockBroadcastThoughtStored).not.toHaveBeenCalled();
    expect(mockSyncThoughts).not.toHaveBeenCalled();
  });

  it('should still store thoughts when Chroma sync fails', async () => {
    mockSyncThoughts.mockImplementation(() => Promise.reject(new Error('Chroma unavailable')));

    const response = await fetch(baseUrl('/api/sessions/thoughts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: 'test-content-session',
        thoughts: [
          { thinking_text: 'Should still store despite Chroma failure', thinking_summary: null, message_index: 0 },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ids).toHaveLength(1);

    // SSE broadcast should still fire even if Chroma fails
    expect(mockBroadcastThoughtStored).toHaveBeenCalledTimes(1);
  });
});
