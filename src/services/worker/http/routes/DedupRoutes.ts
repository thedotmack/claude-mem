import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import type { DatabaseManager } from '../../DatabaseManager.js';

/**
 * #3038 near-duplicate dedup surfaces:
 *  - GET  /api/dedup/candidates?project=&limit=  — read-only list of Tier-1
 *    review-only near-dup candidates (joined to both observation titles).
 *  - POST /api/dedup/scan  — opt-in idempotent backfill of the IDF model +
 *    full-corpus candidate sweep across all projects.
 * Both are thin wrappers over tested SessionStore methods.
 */
export class DedupRoutes extends BaseRouteHandler {
  constructor(private dbManager: DatabaseManager) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/dedup/candidates', this.handleListCandidates.bind(this));
    app.post('/api/dedup/scan', this.handleScan.bind(this));
  }

  private handleListCandidates = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const project = typeof req.query.project === 'string' && req.query.project.trim() ? req.query.project.trim() : undefined;
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 100;
    const candidates = this.dbManager.getSessionStore().listDedupCandidates(project, limit);
    res.json({ candidates });
  });

  private handleScan = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    const scanned = this.dbManager.getSessionStore().runDedupScan();
    res.json({ scanned });
  });
}
