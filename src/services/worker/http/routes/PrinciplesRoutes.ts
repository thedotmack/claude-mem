/**
 * Principles Routes
 *
 * HTTP API endpoints for the Principles system:
 * - POST /api/corrections — store a user correction
 * - GET  /api/corrections — list corrections by pattern
 * - GET  /api/principles — list principles (optionally by status)
 * - POST /api/principles/manage — promote/archive/delete/add principles
 */

import express, { Request, Response } from 'express';
import { logger } from '../../../../utils/logger.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import {
  storeCorrection,
  getCorrectionsByPattern,
} from '../../../sqlite/corrections/store.js';
import {
  storePrinciple,
  getPrinciples,
  getActivePrinciples,
  updatePrincipleStatus,
  deletePrinciple,
} from '../../../sqlite/principles/store.js';
import { checkFrequencyPromotion, storeTriggerPrinciple, markForForcedExtraction, reviewRecentCorrections } from '../../../principles/principleExtractor.js';

export class PrinciplesRoutes extends BaseRouteHandler {
  constructor(private dbManager: DatabaseManager) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/corrections', this.handleStoreCorrection.bind(this));
    app.get('/api/corrections', this.handleGetCorrections.bind(this));
    app.get('/api/principles', this.handleGetPrinciples.bind(this));
    app.post('/api/principles/manage', this.handleManagePrinciple.bind(this));
    app.post('/api/principles/reflect', this.handleReflect.bind(this));
    app.post('/api/principles/review', this.handleReview.bind(this));
  }

  /**
   * POST /api/corrections
   * Store a detected user correction
   */
  private handleStoreCorrection(req: Request, res: Response): void {
    try {
      if (!SettingsDefaultsManager.getBool('CLAUDE_MEM_PRINCIPLES_ENABLED')) {
        res.status(200).json({ skipped: true, reason: 'principles_disabled' });
        return;
      }

      const { sessionId, userMessage, detectedPattern, category } = req.body;
      if (!sessionId || !userMessage) {
        this.badRequest(res, 'Missing sessionId or userMessage');
        return;
      }

      const db = this.dbManager.getSessionStore().db;
      const correctionId = storeCorrection(db, sessionId, userMessage, detectedPattern || null, category || 'general');

      // Check frequency-based promotion
      const threshold = SettingsDefaultsManager.getInt('CLAUDE_MEM_PRINCIPLES_PROMOTION_THRESHOLD');
      const promotedPrincipleId = checkFrequencyPromotion(db, detectedPattern || null, userMessage, threshold);

      res.json({
        correctionId,
        promotedPrincipleId: promotedPrincipleId || null,
      });
    } catch (error) {
      this.handleError(res, error as Error, 'Store correction failed');
    }
  }

  /**
   * GET /api/corrections?pattern=X
   */
  private handleGetCorrections(req: Request, res: Response): void {
    try {
      const pattern = req.query.pattern as string;
      if (!pattern) {
        this.badRequest(res, 'Missing pattern query parameter');
        return;
      }

      const db = this.dbManager.getSessionStore().db;
      const result = getCorrectionsByPattern(db, pattern);
      res.json(result);
    } catch (error) {
      this.handleError(res, error as Error, 'Get corrections failed');
    }
  }

  /**
   * GET /api/principles?status=X&limit=Y
   */
  private handleGetPrinciples(req: Request, res: Response): void {
    try {
      const status = req.query.status as string | undefined;
      const limit = parseInt(req.query.limit as string, 10) || 50;

      const db = this.dbManager.getSessionStore().db;
      const principles = getPrinciples(db, status, limit);
      res.json({ principles });
    } catch (error) {
      this.handleError(res, error as Error, 'Get principles failed');
    }
  }

  /**
   * POST /api/principles/manage
   * { action: 'promote'|'archive'|'delete', principleId: number }
   * { action: 'add', rule: string, category?: string }
   */
  private handleManagePrinciple(req: Request, res: Response): void {
    try {
      const { action, principleId, rule, category } = req.body;
      if (!action) {
        this.badRequest(res, 'Missing action');
        return;
      }

      const db = this.dbManager.getSessionStore().db;

      switch (action) {
        case 'promote':
          if (!principleId) { this.badRequest(res, 'Missing principleId'); return; }
          updatePrincipleStatus(db, principleId, 'promoted');
          res.json({ success: true, action: 'promote', principleId });
          break;

        case 'archive':
          if (!principleId) { this.badRequest(res, 'Missing principleId'); return; }
          updatePrincipleStatus(db, principleId, 'archived');
          res.json({ success: true, action: 'archive', principleId });
          break;

        case 'delete':
          if (!principleId) { this.badRequest(res, 'Missing principleId'); return; }
          deletePrinciple(db, principleId);
          res.json({ success: true, action: 'delete', principleId });
          break;

        case 'add':
          if (!rule) { this.badRequest(res, 'Missing rule'); return; }
          const id = storePrinciple(db, rule, 'manual', 0.8, category || 'general');
          updatePrincipleStatus(db, id, 'confirmed');
          res.json({ success: true, action: 'add', principleId: id });
          break;

        case 'trigger':
          // Explicit trigger phrase — store as confirmed with high confidence
          if (!rule) { this.badRequest(res, 'Missing rule'); return; }
          const triggerId = storeTriggerPrinciple(db, rule, category || 'general');
          res.json({ success: true, action: 'trigger', principleId: triggerId });
          break;

        default:
          this.badRequest(res, `Unknown action: ${action}`);
      }
    } catch (error) {
      this.handleError(res, error as Error, 'Manage principle failed');
    }
  }

  /**
   * POST /api/principles/reflect
   * Mark a session for forced principle extraction on next agent response.
   * { sessionDbId: number }
   */
  private handleReflect(req: Request, res: Response): void {
    try {
      const { sessionDbId } = req.body;
      if (!sessionDbId) {
        this.badRequest(res, 'Missing sessionDbId');
        return;
      }

      markForForcedExtraction(sessionDbId);
      res.json({ success: true, sessionDbId, action: 'reflect' });
    } catch (error) {
      this.handleError(res, error as Error, 'Reflect trigger failed');
    }
  }

  /**
   * POST /api/principles/review
   * Batch-process recent corrections into principles.
   * { limit?: number }
   */
  private handleReview(req: Request, res: Response): void {
    try {
      const limit = parseInt(req.body.limit, 10) || 50;
      const db = this.dbManager.getSessionStore().db;
      const result = reviewRecentCorrections(db, limit);
      res.json({ success: true, action: 'review', ...result });
    } catch (error) {
      this.handleError(res, error as Error, 'Review corrections failed');
    }
  }
}
