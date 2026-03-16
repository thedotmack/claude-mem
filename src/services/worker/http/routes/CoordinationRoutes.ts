/**
 * Coordination Routes
 *
 * HTTP endpoints for multi-agent coordination:
 * - POST /api/coordination/claim       — Claim files for an agent
 * - POST /api/coordination/release     — Release file claims
 * - POST /api/coordination/check-conflicts — Check for conflicts on files
 * - POST /api/coordination/discovery   — Record a discovery
 * - POST /api/coordination/discoveries — Query discoveries
 * - POST /api/coordination/resolve-conflict — Resolve a conflict
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { logger } from '../../../../utils/logger.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import {
  claimFiles,
  releaseFiles,
  recordDiscovery,
  resolveConflict,
  checkConflicts,
  getDiscoveries,
} from '../../../sqlite/Coordination.js';

export class CoordinationRoutes extends BaseRouteHandler {
  constructor(private dbManager: DatabaseManager) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/coordination/claim', this.handleClaim.bind(this));
    app.post('/api/coordination/release', this.handleRelease.bind(this));
    app.post('/api/coordination/check-conflicts', this.handleCheckConflicts.bind(this));
    app.post('/api/coordination/discovery', this.handleRecordDiscovery.bind(this));
    app.post('/api/coordination/discoveries', this.handleGetDiscoveries.bind(this));
    app.post('/api/coordination/resolve-conflict', this.handleResolveConflict.bind(this));
  }

  /**
   * POST /api/coordination/claim
   * Body: { agent_id, agent_name, files, scope, intent?, session_id?, ttl_minutes }
   */
  private handleClaim = this.wrapHandler((req: Request, res: Response): void => {
    if (!this.validateRequired(req, res, ['agent_id', 'agent_name', 'files', 'scope', 'ttl_minutes'])) return;

    const { agent_id, agent_name, files, scope, intent, session_id, ttl_minutes } = req.body;

    if (!Array.isArray(files) || files.length === 0) {
      this.badRequest(res, 'files must be a non-empty array');
      return;
    }

    if (scope !== 'read' && scope !== 'write') {
      this.badRequest(res, 'scope must be "read" or "write"');
      return;
    }

    if (typeof ttl_minutes !== 'number' || ttl_minutes < 0) {
      this.badRequest(res, 'ttl_minutes must be a non-negative number');
      return;
    }

    const db = this.dbManager.getSessionStore().db;
    const result = claimFiles(db, { agent_id, agent_name, files, scope, intent, session_id, ttl_minutes });

    logger.info('COORDINATION', `Agent ${agent_name} claimed ${files.length} file(s)`, {
      agent_id,
      scope,
      conflicts: result.conflicts.length,
    });

    res.json(result);
  });

  /**
   * POST /api/coordination/release
   * Body: { agent_id, files }
   */
  private handleRelease = this.wrapHandler((req: Request, res: Response): void => {
    if (!this.validateRequired(req, res, ['agent_id', 'files'])) return;

    const { agent_id, files } = req.body;

    if (!Array.isArray(files) || files.length === 0) {
      this.badRequest(res, 'files must be a non-empty array');
      return;
    }

    const db = this.dbManager.getSessionStore().db;
    const result = releaseFiles(db, agent_id, files);

    res.json(result);
  });

  /**
   * POST /api/coordination/check-conflicts
   * Body: { files, exclude_agent_id? }
   */
  private handleCheckConflicts = this.wrapHandler((req: Request, res: Response): void => {
    if (!this.validateRequired(req, res, ['files'])) return;

    const { files, exclude_agent_id } = req.body;

    if (!Array.isArray(files) || files.length === 0) {
      this.badRequest(res, 'files must be a non-empty array');
      return;
    }

    const db = this.dbManager.getSessionStore().db;
    const result = checkConflicts(db, files, exclude_agent_id);

    res.json(result);
  });

  /**
   * POST /api/coordination/discovery
   * Body: { agent_id, agent_name, discovery_type, content, affected_files?, severity?, session_id? }
   */
  private handleRecordDiscovery = this.wrapHandler((req: Request, res: Response): void => {
    if (!this.validateRequired(req, res, ['agent_id', 'agent_name', 'discovery_type', 'content'])) return;

    const { agent_id, agent_name, discovery_type, content, affected_files, severity, session_id } = req.body;

    const validTypes = ['finding', 'warning', 'dependency', 'conflict', 'recommendation'];
    if (!validTypes.includes(discovery_type)) {
      this.badRequest(res, `discovery_type must be one of: ${validTypes.join(', ')}`);
      return;
    }

    const db = this.dbManager.getSessionStore().db;
    const discoveryId = recordDiscovery(db, {
      agent_id,
      agent_name,
      discovery_type,
      content,
      affected_files,
      severity,
      session_id,
    });

    res.json({ discovery_id: discoveryId });
  });

  /**
   * POST /api/coordination/discoveries
   * Body: { session_id?, agent_id?, affected_file?, since_epoch?, limit? }
   */
  private handleGetDiscoveries = this.wrapHandler((req: Request, res: Response): void => {
    const { session_id, agent_id, affected_file, since_epoch, limit } = req.body;

    const db = this.dbManager.getSessionStore().db;
    const discoveries = getDiscoveries(db, {
      session_id,
      agent_id,
      affected_file,
      since_epoch,
      limit,
    });

    res.json({ discoveries });
  });

  /**
   * POST /api/coordination/resolve-conflict
   * Body: { conflict_id, resolution }
   */
  private handleResolveConflict = this.wrapHandler((req: Request, res: Response): void => {
    if (!this.validateRequired(req, res, ['conflict_id', 'resolution'])) return;

    const { conflict_id, resolution } = req.body;

    const validResolutions = ['agent_a_priority', 'agent_b_priority', 'merged', 'dismissed'];
    if (!validResolutions.includes(resolution)) {
      this.badRequest(res, `resolution must be one of: ${validResolutions.join(', ')}`);
      return;
    }

    const db = this.dbManager.getSessionStore().db;
    const success = resolveConflict(db, conflict_id, resolution);

    if (!success) {
      this.notFound(res, 'Conflict not found or already resolved');
      return;
    }

    res.json({ success: true });
  });
}
