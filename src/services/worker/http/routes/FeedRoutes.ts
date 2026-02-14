/**
 * FeedRoutes
 *
 * HTTP endpoints for managing the crab-mem Telegram feed daemon.
 *   GET  /api/feed/status - Feed status
 *   POST /api/feed/start  - Start feed daemon
 *   POST /api/feed/stop   - Stop feed daemon
 *   POST /api/feed/test   - Send test message
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import type { FeedDaemon } from '../../../feed/FeedDaemon.js';
import type { SSEBroadcaster } from '../../SSEBroadcaster.js';

export class FeedRoutes extends BaseRouteHandler {
  constructor(
    private feedDaemon: FeedDaemon,
    private sseBroadcaster: SSEBroadcaster
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/feed/status', this.handleStatus.bind(this));
    app.post('/api/feed/start', this.handleStart.bind(this));
    app.post('/api/feed/stop', this.handleStop.bind(this));
    app.post('/api/feed/test', this.handleTest.bind(this));
  }

  private handleStatus = this.wrapHandler((_req: Request, res: Response): void => {
    res.json(this.feedDaemon.getStatus());
  });

  private handleStart = this.wrapHandler((_req: Request, res: Response): void => {
    // Idempotent: start if not running, restart only if already running
    const started = this.feedDaemon.running
      ? this.feedDaemon.restart(this.sseBroadcaster)
      : this.feedDaemon.start(this.sseBroadcaster);
    res.json({ success: started, message: started ? 'Feed started' : 'Feed not configured or disabled' });
  });

  private handleStop = this.wrapHandler((_req: Request, res: Response): void => {
    this.feedDaemon.stop();
    res.json({ success: true, message: 'Feed stopped' });
  });

  private handleTest = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    try {
      await this.feedDaemon.sendTestMessage();
      res.json({ success: true, message: 'Test message sent' });
    } catch (err) {
      res.status(400).json({ success: false, message: (err as Error).message });
    }
  });
}
