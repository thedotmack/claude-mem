import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import {
  DEDUP_CANDIDATE_STATUSES, DEDUP_CANDIDATE_VERDICTS, type DedupCandidateStatus,
} from '../../../sqlite/dedup-store.js';

const resolveCandidateSchema = z.object({ status: z.enum(DEDUP_CANDIDATE_VERDICTS) });

/**
 * #3038 near-duplicate dedup surfaces:
 *  - GET  /api/dedup/candidates?project=&limit=&status=  — read-only list of Tier-1
 *    review-only near-dup candidates (joined to both observation titles).
 *  - POST /api/dedup/candidates/:id/resolve  {status: distinct|dismissed}  — record
 *    a reviewer's verdict; a rescan never resets it (UNIQUE pair + INSERT OR IGNORE).
 *  - POST /api/dedup/scan  — opt-in idempotent backfill of the IDF model +
 *    full-corpus candidate sweep across all projects.
 * All are thin wrappers over tested SessionStore methods.
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
    app.post('/api/dedup/candidates/:id/resolve', validateBody(resolveCandidateSchema), this.handleResolveCandidate.bind(this));
    app.post('/api/dedup/scan', this.handleScan.bind(this));
  }

  private handleListCandidates = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const project = typeof req.query.project === 'string' && req.query.project.trim() ? req.query.project.trim() : undefined;
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 100;
    const status = BaseRouteHandler.firstString(req.query.status);
    if (status !== undefined && !(DEDUP_CANDIDATE_STATUSES as readonly string[]).includes(status)) {
      this.badRequest(res, `status must be one of ${DEDUP_CANDIDATE_STATUSES.join(', ')}`);
      return;
    }
    const candidates = this.dbManager.getSessionStore().listDedupCandidates(project, limit, status as DedupCandidateStatus | undefined);
    res.json({ candidates });
  });

  private handleResolveCandidate = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;
    const store = this.dbManager.getSessionStore();
    if (!store.isDedupEnabled()) {
      res.status(409).json({ error: 'dedup_disabled', message: 'Set CLAUDE_MEM_DEDUP_ENABLED=true before resolving dedup candidates.' });
      return;
    }
    const { status } = req.body as z.infer<typeof resolveCandidateSchema>;
    if (!store.resolveDedupCandidate(id, status)) {
      this.notFound(res, 'Dedup candidate not found');
      return;
    }
    res.json({ candidate: { id, status } });
  });

  private handleScan = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    // Scan MUTATES observation rows (title_norm_key) — gate on the feature flag so a
    // disabled install stays byte-identical to legacy behavior.
    if (!this.dbManager.getSessionStore().isDedupEnabled()) {
      res.status(409).json({ error: 'dedup_disabled', message: 'Set CLAUDE_MEM_DEDUP_ENABLED=true before running a dedup scan.' });
      return;
    }
    if (DedupRoutes.scanInProgress) {
      res.status(409).json({ error: 'scan_in_progress', message: 'A dedup scan is already running.' });
      return;
    }
    DedupRoutes.scanInProgress = true;
    try {
      const startedAt = Date.now();
      const scanned = this.dbManager.getSessionStore().runDedupScan();
      logger.info('DEDUP', 'Dedup scan finished', {
        projects: scanned.length,
        candidates: scanned.reduce((sum, project) => sum + project.candidates, 0),
        durationMs: Date.now() - startedAt,
      });
      res.json({ scanned });
    } finally {
      DedupRoutes.scanInProgress = false;
    }
  });
}
