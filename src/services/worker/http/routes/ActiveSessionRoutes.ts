/**
 * ActiveSessionRoutes
 *
 * Handles active session management endpoints:
 * - GET  /api/sessions/active        — list active sessions with stale detection
 * - POST /api/sessions/:id/close     — close a single active session by DB id
 * - POST /api/sessions/close-stale   — close all sessions older than 1 hour
 */

import type { Request, Response } from 'express';
import type express from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import { logger } from '../../../../utils/logger.js';

/** Sessions older than this threshold are considered stale. */
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export class ActiveSessionRoutes extends BaseRouteHandler {
  constructor(private readonly dbManager: DatabaseManager) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/sessions/active', this.handleGetActiveSessions);
    // Static path must be registered before parameterized to avoid Express matching
    // "close-stale" as the :id parameter in /api/sessions/:id/close
    app.post('/api/sessions/close-stale', this.handleCloseStale);
    app.post('/api/sessions/:id/close', this.handleCloseSession);
  }

  /**
   * GET /api/sessions/active
   * Returns all active sessions enriched with is_stale and duration_ms fields.
   */
  private handleGetActiveSessions = this.wrapHandler((_req: Request, res: Response): void => {
    const store = this.dbManager.getSessionStore();
    const rows = store.getActiveSessions();
    const now = Date.now();

    const sessions = rows.map(row => ({
      ...row,
      is_stale: now - row.started_at_epoch > STALE_THRESHOLD_MS,
      duration_ms: now - row.started_at_epoch,
    }));

    const staleCount = sessions.filter(s => s.is_stale).length;

    res.json({ sessions, staleCount, totalCount: sessions.length });
  });

  /**
   * POST /api/sessions/:id/close
   * Closes a single active session identified by its database row ID.
   * Returns 404 if the session does not exist or is already completed.
   */
  private handleCloseSession = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const closed = store.closeActiveSessionById(id);

    if (!closed) {
      this.notFound(res, 'Session not found or not active');
      return;
    }

    res.json({ success: true });
  });

  /**
   * POST /api/sessions/close-stale
   * Closes all active sessions that started more than 1 hour ago.
   * Returns the number of sessions closed.
   */
  private handleCloseStale = this.wrapHandler((_req: Request, res: Response): void => {
    const store = this.dbManager.getSessionStore();
    const threshold = Date.now() - STALE_THRESHOLD_MS;
    const closedCount = store.closeStaleSessionsOlderThan(threshold);

    if (closedCount > 0) {
      logger.info('SESSION', 'Closed stale sessions', { closedCount });
    }

    res.json({ closedCount });
  });
}
