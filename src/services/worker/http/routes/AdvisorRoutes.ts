
import express, { Request, Response } from 'express';
import { PaginationHelper } from '../../PaginationHelper.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { logger } from '../../../../utils/logger.js';

/**
 * Read-only surface for `advisor_calls` — durable, verbatim records of every
 * Claude Code `advisor` tool call captured across sessions, written directly
 * in ingestObservation() (see services/worker/http/shared.ts). See which
 * sessions consulted advisor, what context was forwarded (lightweight
 * pointer, not a full transcript copy), and what advice came back.
 */
export class AdvisorRoutes extends BaseRouteHandler {
  constructor(
    private paginationHelper: PaginationHelper,
    private dbManager: DatabaseManager,
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/advisor-calls', this.handleGetAdvisorCalls.bind(this));
    app.get('/api/advisor-call/:id', this.handleGetAdvisorCallById.bind(this));
  }

  private handleGetAdvisorCalls = this.wrapHandler((req: Request, res: Response): void => {
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const project = req.query.project as string | undefined;
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);

    const result = this.paginationHelper.getAdvisorCalls(offset, limit, project, platformSource);
    res.json(result);
  });

  private handleGetAdvisorCallById = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const advisorCall = store.getAdvisorCallById(id);

    if (!advisorCall) {
      logger.debug('WORKER', 'Advisor call not found', { id });
      this.notFound(res, `Advisor call #${id} not found`);
      return;
    }

    res.json(advisorCall);
  });
}
