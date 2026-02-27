/**
 * Memory Routes
 *
 * Handles manual memory/observation saving.
 * POST /api/memory/save - Save a manual memory observation
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { logger } from '../../../../utils/logger.js';
import type { DatabaseManager } from '../../DatabaseManager.js';

export class MemoryRoutes extends BaseRouteHandler {
  constructor(
    private dbManager: DatabaseManager,
    private defaultProject: string
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/memory/save', this.handleSaveMemory.bind(this));
    app.post('/api/memory/contradict', this.handleContradictMemory.bind(this));
    app.post('/api/memory/importance', this.handleSetImportance.bind(this));
    app.post('/api/memory/drift-check', this.handleDriftCheck.bind(this));
  }

  /**
   * POST /api/memory/save - Save a manual memory/observation
   * Body: { text: string, title?: string, project?: string }
   */
  private handleSaveMemory = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { text, title, project } = req.body;
    const targetProject = project || this.defaultProject;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      this.badRequest(res, 'text is required and must be non-empty');
      return;
    }

    const sessionStore = this.dbManager.getSessionStore();
    const chromaSync = this.dbManager.getChromaSync();

    // 1. Get or create manual session for project
    const memorySessionId = sessionStore.getOrCreateManualSession(targetProject);

    // 2. Build observation
    const observation = {
      type: 'discovery',  // Use existing valid type
      title: title || text.substring(0, 60).trim() + (text.length > 60 ? '...' : ''),
      subtitle: 'Manual memory',
      facts: [] as string[],
      narrative: text,
      concepts: [] as string[],
      files_read: [] as string[],
      files_modified: [] as string[]
    };

    // 3. Store to SQLite
    const result = sessionStore.storeObservation(
      memorySessionId,
      targetProject,
      observation,
      0,  // promptNumber
      0   // discoveryTokens
    );

    logger.info('HTTP', 'Manual observation saved', {
      id: result.id,
      project: targetProject,
      title: observation.title
    });

    // 4. Sync to ChromaDB (async, fire-and-forget)
    chromaSync.syncObservation(
      result.id,
      memorySessionId,
      targetProject,
      observation,
      0,
      result.createdAtEpoch,
      0
    ).catch(err => {
      logger.error('CHROMA', 'ChromaDB sync failed', { id: result.id }, err as Error);
    });

    // 5. Return success
    res.json({
      success: true,
      id: result.id,
      title: observation.title,
      project: targetProject,
      message: `Memory saved as observation #${result.id}`
    });
  });

  /**
   * POST /api/memory/contradict - Mark an existing memory stale and record a correction
   * Body: { stale_id: number, correction: string, title?: string }
   */
  private handleContradictMemory = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { stale_id, correction, title } = req.body;

    if (!stale_id || typeof stale_id !== 'number' || !Number.isInteger(stale_id) || stale_id <= 0) {
      this.badRequest(res, 'stale_id is required and must be a positive integer');
      return;
    }

    if (!correction || typeof correction !== 'string' || correction.trim().length === 0) {
      this.badRequest(res, 'correction is required and must be non-empty');
      return;
    }

    const sessionStore = this.dbManager.getSessionStore();
    const chromaSync = this.dbManager.getChromaSync();

    // 1. Verify stale observation exists
    const staleObs = sessionStore.getObservationById(stale_id);
    if (!staleObs) {
      res.status(404).json({ success: false, error: 'Observation not found' });
      return;
    }

    const targetProject = staleObs.project;

    // 2. Get or create manual session for the same project
    const memorySessionId = sessionStore.getOrCreateManualSession(targetProject);

    // 3. Build correction observation
    const observation = {
      type: 'discovery',
      title: title || correction.substring(0, 60).trim() + (correction.length > 60 ? '...' : ''),
      subtitle: 'Correction',
      facts: [] as string[],
      narrative: correction,
      concepts: [] as string[],
      files_read: [] as string[],
      files_modified: [] as string[]
    };

    // 4. Store correction to SQLite
    const result = sessionStore.storeObservation(
      memorySessionId,
      targetProject,
      observation,
      0,  // promptNumber
      0   // discoveryTokens
    );

    // 5. Mark original observation stale
    sessionStore.markObservationStale(stale_id, result.id);

    logger.info('HTTP', 'Memory contradicted', {
      stale_id,
      correction_id: result.id,
      project: targetProject
    });

    // 6. Sync correction to ChromaDB (async, fire-and-forget)
    chromaSync.syncObservation(
      result.id,
      memorySessionId,
      targetProject,
      observation,
      0,
      result.createdAtEpoch,
      0
    ).catch(err => {
      logger.error('CHROMA', 'ChromaDB sync failed for correction', { id: result.id }, err as Error);
    });

    // 7. Return success
    res.json({
      success: true,
      stale_id,
      correction_id: result.id,
      message: 'Memory marked stale and correction recorded'
    });
  });

  /**
   * POST /api/memory/importance - Set importance score for an observation
   * Body: { id: number, importance: number }
   */
  private handleSetImportance = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { id, importance } = req.body;

    if (!id || typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      this.badRequest(res, 'id is required and must be a positive integer');
      return;
    }

    if (importance === undefined || typeof importance !== 'number' || importance < 1 || importance > 10) {
      this.badRequest(res, 'importance is required and must be a number between 1 and 10');
      return;
    }

    const sessionStore = this.dbManager.getSessionStore();

    const obs = sessionStore.getObservationById(id);
    if (!obs) {
      res.status(404).json({ success: false, error: 'Observation not found' });
      return;
    }

    const clamped = Math.min(10, Math.max(1, Math.round(importance)));
    sessionStore.setObservationImportance(id, importance);

    logger.info('HTTP', 'Observation importance updated', { id, importance: clamped });

    res.json({
      success: true,
      id,
      importance: clamped,
      message: 'Importance updated'
    });
  });

  /**
   * POST /api/memory/drift-check - Detect semantic drift in concept clusters
   * Body: { project?: string }
   */
  private handleDriftCheck = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { project } = req.body;

    const sessionSearch = this.dbManager.getSessionSearch();
    const { driftedConcepts, summary } = sessionSearch.detectDrift(project || undefined);

    let text = summary + '\n';

    if (driftedConcepts.length > 0) {
      text += '\n| Signal | Project | Concept | Stale% | Total | Recent | Old | Unaccessed |\n';
      text += '|--------|---------|---------|--------|-------|--------|-----|------------|\n';
      for (const c of driftedConcepts) {
        text += `| ${c.signal} | ${c.project} | ${c.concept} | ${c.stalePct}% | ${c.totalCount} | ${c.recentCount} | ${c.oldCount} | ${c.unaccessedOld} |\n`;
      }
    }

    res.json({ content: [{ type: 'text', text }] });
  });
}
