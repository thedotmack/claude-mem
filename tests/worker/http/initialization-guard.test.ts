/**
 * Tests for the initialization guard middleware that protects
 * /sessions/* and /api/* routes from accessing the database
 * before initializeBackground() completes (#1323).
 *
 * Uses a minimal Express app that mirrors the guard pattern in worker-service.ts.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import express from 'express';
import type { Server as HttpServer } from 'http';
import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

/**
 * Creates a minimal Express app with the same initialization guard pattern
 * used in worker-service.ts registerRoutes().
 */
function createGuardedApp(opts: {
  initializationCompleteFlag: { value: boolean };
  initializationComplete: Promise<void>;
}) {
  const app = express();

  // Guard /sessions/* — mirrors worker-service.ts
  app.use('/sessions', async (req, res, next) => {
    if (opts.initializationCompleteFlag.value) {
      next();
      return;
    }

    const timeoutMs = 200; // Short timeout for tests
    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Database initialization timeout')), timeoutMs)
    );

    try {
      await Promise.race([opts.initializationComplete, timeoutPromise]);
      next();
    } catch {
      res.status(503).json({
        error: 'Service initializing',
        message: 'Database is still initializing, please retry'
      });
    }
  });

  // Guard /api/* — mirrors worker-service.ts
  app.use('/api', async (req, res, next) => {
    if (opts.initializationCompleteFlag.value) {
      next();
      return;
    }

    const timeoutMs = 200;
    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Database initialization timeout')), timeoutMs)
    );

    try {
      await Promise.race([opts.initializationComplete, timeoutPromise]);
      next();
    } catch {
      res.status(503).json({
        error: 'Service initializing',
        message: 'Database is still initializing, please retry'
      });
    }
  });

  // Simulated session routes (legacy)
  app.post('/sessions/:sessionDbId/init', (req, res) => {
    res.json({ status: 'initialized', sessionDbId: req.params.sessionDbId });
  });

  app.post('/sessions/:sessionDbId/observations', (req, res) => {
    res.json({ status: 'queued' });
  });

  // Simulated API session route (new)
  app.post('/api/sessions/init', (req, res) => {
    res.json({ status: 'initialized' });
  });

  return app;
}

describe('Initialization guard middleware (#1323)', () => {
  let server: HttpServer | null = null;
  let port: number;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
    port = 40000 + Math.floor(Math.random() * 10000);
  });

  afterEach(async () => {
    loggerSpies.forEach(spy => spy.mockRestore());
    if (server) {
      // Force-close all keep-alive connections so server.close() doesn't hang
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  function listenOnPort(app: express.Application): Promise<void> {
    return new Promise((resolve) => {
      server = app.listen(port, '127.0.0.1', () => resolve());
    });
  }

  it('should return 503 for /sessions/:id/init when not initialized', async () => {
    const app = createGuardedApp({
      initializationCompleteFlag: { value: false },
      initializationComplete: new Promise(() => {}), // Never resolves
    });
    await listenOnPort(app);

    const response = await fetch(`http://127.0.0.1:${port}/sessions/1/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe('Service initializing');
  });

  it('should return 503 for /api/sessions/init when not initialized', async () => {
    const app = createGuardedApp({
      initializationCompleteFlag: { value: false },
      initializationComplete: new Promise(() => {}),
    });
    await listenOnPort(app);

    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe('Service initializing');
  });

  it('should allow /sessions/:id/init through when initialized', async () => {
    const app = createGuardedApp({
      initializationCompleteFlag: { value: true },
      initializationComplete: Promise.resolve(),
    });
    await listenOnPort(app);

    const response = await fetch(`http://127.0.0.1:${port}/sessions/42/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('initialized');
    expect(body.sessionDbId).toBe('42');
  });

  it('should wait for initialization and then allow request through', async () => {
    let resolveInit!: () => void;
    const initPromise = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    const flag = { value: false };
    const app = createGuardedApp({
      initializationCompleteFlag: flag,
      initializationComplete: initPromise,
    });
    await listenOnPort(app);

    // Start a request that will block on the guard
    const requestPromise = fetch(`http://127.0.0.1:${port}/sessions/1/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    // Simulate initialization completing after a short delay
    setTimeout(() => {
      flag.value = true;
      resolveInit();
    }, 100);

    const response = await requestPromise;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('initialized');
  });

  it('should guard /sessions/:id/observations when not initialized', async () => {
    const app = createGuardedApp({
      initializationCompleteFlag: { value: false },
      initializationComplete: new Promise(() => {}),
    });
    await listenOnPort(app);

    const response = await fetch(`http://127.0.0.1:${port}/sessions/1/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(503);
  });
});
