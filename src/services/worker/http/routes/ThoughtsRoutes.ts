/**
 * Thoughts Routes
 *
 * Handles storage and retrieval of thinking blocks (thoughts).
 * POST stores thoughts from Stop hook; GET endpoints query stored thoughts.
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { logger } from '../../../../utils/logger.js';
import type { SessionStore } from '../../../sqlite/SessionStore.js';
import type { ChromaSync } from '../../../sync/ChromaSync.js';
import type { SessionEventBroadcaster } from '../../events/SessionEventBroadcaster.js';
import type { ThoughtInput } from '../../../sqlite/thoughts/types.js';

export class ThoughtsRoutes extends BaseRouteHandler {
  constructor(
    private sessionStore: SessionStore,
    private chromaSync?: ChromaSync,
    private sessionEventBroadcaster?: SessionEventBroadcaster
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/thoughts', this.handleStoreThoughts.bind(this));
    app.get('/api/thoughts', this.handleGetThoughts.bind(this));
    app.get('/api/thoughts/search', this.handleSearchThoughts.bind(this));
  }

  /**
   * Store thoughts (thinking blocks)
   * POST /api/thoughts
   * Body: { memorySessionId, contentSessionId, project, thoughts }
   */
  private handleStoreThoughts = this.wrapHandler((req: Request, res: Response): void => {
    const { memorySessionId, contentSessionId, project, thoughts } = req.body;

    if (!memorySessionId) {
      return this.badRequest(res, 'Missing memorySessionId');
    }
    if (!project) {
      return this.badRequest(res, 'Missing project');
    }
    if (!thoughts || !Array.isArray(thoughts) || thoughts.length === 0) {
      return this.badRequest(res, 'Missing or empty thoughts array');
    }

    const ids = this.sessionStore.storeThoughts(
      memorySessionId,
      contentSessionId || null,
      project,
      thoughts as ThoughtInput[],
      null
    );

    logger.info('HTTP', `Stored ${ids.length} thoughts`, {
      memorySessionId,
      project
    });

    // Sync to ChromaDB for semantic search (fire-and-forget, non-blocking)
    if (this.chromaSync && ids.length > 0) {
      try {
        const storedThoughts = this.sessionStore.getThoughtsByIds(ids);
        this.chromaSync.syncThoughts(storedThoughts).catch(err => {
          logger.warn('HTTP', 'Chroma thought sync failed (async)', { error: String(err) });
        });
      } catch (err) {
        logger.warn('HTTP', 'Chroma thought sync failed', { error: String(err) });
      }
    }

    // Broadcast SSE events for each stored thought
    if (this.sessionEventBroadcaster && ids.length > 0) {
      const storedThoughts = this.sessionStore.getThoughtsByIds(ids);
      for (const thought of storedThoughts) {
        this.sessionEventBroadcaster.broadcastThoughtStored(thought);
      }
    }

    res.json({ stored: ids.length, ids });
  });

  /**
   * Get thoughts for a project
   * GET /api/thoughts?project=...&limit=50&startEpoch=...&endEpoch=...
   */
  private handleGetThoughts = this.wrapHandler((req: Request, res: Response): void => {
    const project = req.query.project as string;

    if (!project) {
      return this.badRequest(res, 'Missing required parameter: project');
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const startEpoch = req.query.startEpoch ? parseInt(req.query.startEpoch as string, 10) : undefined;
    const endEpoch = req.query.endEpoch ? parseInt(req.query.endEpoch as string, 10) : undefined;

    const thoughts = this.sessionStore.getThoughts(project, { limit, startEpoch, endEpoch });

    res.json({ thoughts });
  });

  /**
   * Full-text search over thoughts
   * GET /api/thoughts/search?query=...&project=...&limit=50
   */
  private handleSearchThoughts = this.wrapHandler((req: Request, res: Response): void => {
    const query = req.query.query as string;

    if (!query) {
      return this.badRequest(res, 'Missing required parameter: query');
    }

    const project = req.query.project as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

    const thoughts = this.sessionStore.searchThoughts(query, project, limit);

    res.json({ thoughts, count: thoughts.length });
  });
}
