import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import type { DatabaseManager } from '../../DatabaseManager.js';

/**
 * #3038 near-duplicate dedup surfaces:
 *  - GET  /api/dedup/candidates?project=&limit=  — read-only list of Tier-1
 *    review-only near-dup candidates (joined to both observation titles).
 *  - POST /api/dedup/scan  — opt-in idempotent backfill of the IDF model +
 *    full-corpus candidate sweep across all projects.
 * Both are thin wrappers over tested SessionStore methods.
 *
 * Trust model: like every other worker route, these are guarded only by the
 * worker's 127.0.0.1 binding + localhost CORS — any local process can reach
 * them. GET candidates exposes observation titles project-wide; no per-route
 * auth, consistent with DataRoutes/SearchRoutes/MemoryRoutes.
 */
export class DedupRoutes extends BaseRouteHandler {
  // Single-flight guard: the scan is an expensive full-corpus, event-loop-blocking
  // operation; reject overlapping runs instead of compounding CPU/memory pressure.
  private static scanInProgress = false;

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
    // Scan MUTATES observation rows (title_norm_key) — gate on the feature flag so a
    // disabled install stays byte-identical to legacy behavior.
    if (!SettingsDefaultsManager.getBool('CLAUDE_MEM_DEDUP_ENABLED')) {
      res.status(409).json({ error: 'dedup_disabled', message: 'Set CLAUDE_MEM_DEDUP_ENABLED=true before running a dedup scan.' });
      return;
    }
    if (DedupRoutes.scanInProgress) {
      res.status(409).json({ error: 'scan_in_progress', message: 'A dedup scan is already running.' });
      return;
    }
    DedupRoutes.scanInProgress = true;
    try {
      const scanned = this.dbManager.getSessionStore().runDedupScan();
      res.json({ scanned });
    } finally {
      DedupRoutes.scanInProgress = false;
    }
  });
}
