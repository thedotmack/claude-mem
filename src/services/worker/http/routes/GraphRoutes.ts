/**
 * Graph Routes
 *
 * Handles all graph visualization API endpoints.
 * Provides data for concept networks, observation graphs, project connections, and usage stats.
 */

import express, { Request, Response } from 'express';
import { GraphService } from '../../GraphService.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

export class GraphRoutes extends BaseRouteHandler {
  constructor(private graphService: GraphService) {
    super();
  }

  setupRoutes(app: express.Application): void {
    // Graph data endpoints
    app.get('/api/graph/concepts', this.handleConceptGraph.bind(this));
    app.get('/api/graph/observations', this.handleObservationGraph.bind(this));
    app.get('/api/graph/projects', this.handleProjectGraph.bind(this));
    app.get('/api/graph/usage-stats', this.handleUsageStats.bind(this));
  }

  /**
   * Get concept network graph data
   * GET /api/graph/concepts?project=&limit=100
   */
  private handleConceptGraph = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const project = req.query.project as string | undefined;
    const limit = parseInt(req.query.limit as string) || 100;

    const data = this.graphService.buildConceptNetwork(project, limit);
    res.json({ success: true, data });
  });

  /**
   * Get observation relationship graph data
   * GET /api/graph/observations?project=&limit=200
   */
  private handleObservationGraph = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const project = req.query.project as string | undefined;
    const limit = parseInt(req.query.limit as string) || 200;

    const data = this.graphService.buildObservationGraph(project, limit);
    res.json({ success: true, data });
  });

  /**
   * Get project connection graph data
   * GET /api/graph/projects
   */
  private handleProjectGraph = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const data = this.graphService.buildProjectGraph();
    res.json({ success: true, data });
  });

  /**
   * Get observation usage statistics
   * GET /api/graph/usage-stats?project=&limit=50
   */
  private handleUsageStats = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const project = req.query.project as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;

    const data = this.graphService.getUsageStats(project, limit);
    res.json({ success: true, data });
  });
}
