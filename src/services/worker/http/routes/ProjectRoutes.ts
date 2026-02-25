/**
 * ProjectRoutes
 *
 * Handles project management endpoints:
 * - GET    /api/projects/:name/counts  — row count preview for a project
 * - POST   /api/projects/:name/rename  — rename a project across all tables
 * - POST   /api/projects/:name/merge   — merge source project into target
 * - DELETE /api/projects/:name         — delete all rows for a project
 *
 * Note: These endpoints are localhost-only (worker on port 37777).
 * TODO: Chroma vector embeddings are not updated by these operations;
 * a manual re-sync may be needed after rename/merge/delete.
 */

import type { Request, Response } from 'express';
import type express from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import {
  getProjectRowCounts,
  renameProject,
  mergeProject,
  deleteProject,
} from '../../../sqlite/ProjectOperations.js';
import { logger } from '../../../../utils/logger.js';

/** Maximum allowed project name length */
const MAX_PROJECT_NAME_LENGTH = 500;

export class ProjectRoutes extends BaseRouteHandler {
  constructor(private readonly dbManager: DatabaseManager) {
    super();
  }

  /** Map domain errors from ProjectOperations to appropriate HTTP status codes. */
  private sendDomainError(res: Response, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('different from') || message.includes('into itself')) {
      this.badRequest(res, message);
      return;
    }
    if (message.includes('already exists')) {
      res.status(409).json({ error: message });
      return;
    }
    if (message.includes('not found')) {
      this.notFound(res, message);
      return;
    }
    throw error;
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/projects/:name/counts', this.handleGetCounts);
    app.post('/api/projects/:name/rename', this.handleRename);
    app.post('/api/projects/:name/merge', this.handleMerge);
    app.delete('/api/projects/:name', this.handleDelete);
  }

  /**
   * Decode and validate a project name from URL params.
   * Returns the decoded name or sends a 400 and returns null.
   */
  private parseProjectName(req: Request, res: Response): string | null {
    const raw = req.params['name'];
    if (!raw) {
      this.badRequest(res, 'Invalid project name');
      return null;
    }

    let name: string;
    try {
      name = decodeURIComponent(raw);
    } catch {
      this.badRequest(res, 'Invalid project name (malformed URL encoding)');
      return null;
    }

    if (name.length === 0 || name.length > MAX_PROJECT_NAME_LENGTH) {
      this.badRequest(res, 'Invalid project name');
      return null;
    }

    return name;
  }

  /**
   * GET /api/projects/:name/counts
   * Returns the row counts for a project across all 4 tables.
   * Returns zeros if the project does not exist.
   */
  private handleGetCounts = this.wrapHandler((req: Request, res: Response): void => {
    const projectName = this.parseProjectName(req, res);
    if (projectName === null) return;

    const db = this.dbManager.getSessionStore().db;
    const counts = getProjectRowCounts(db, projectName);

    res.json({ counts });
  });

  /**
   * POST /api/projects/:name/rename
   * Renames a project across all 4 tables.
   * Body: { newName: string }
   * Returns 409 if newName already exists, 404 if source not found.
   */
  private handleRename = this.wrapHandler((req: Request, res: Response): void => {
    const projectName = this.parseProjectName(req, res);
    if (projectName === null) return;

    if (!this.validateRequired(req, res, ['newName'])) return;

    const { newName } = req.body as { newName: string };

    if (typeof newName !== 'string' || newName.length === 0 || newName.length > MAX_PROJECT_NAME_LENGTH) {
      this.badRequest(res, 'Invalid newName');
      return;
    }

    const db = this.dbManager.getSessionStore().db;

    try {
      const counts = renameProject(db, projectName, newName);
      res.json({ success: true, counts });
    } catch (error) {
      this.sendDomainError(res, error);
    }
  });

  /**
   * POST /api/projects/:name/merge
   * Merges a source project into a target project across all 4 tables.
   * Body: { targetProject: string }
   * Returns 404 if either project not found.
   */
  private handleMerge = this.wrapHandler((req: Request, res: Response): void => {
    const projectName = this.parseProjectName(req, res);
    if (projectName === null) return;

    if (!this.validateRequired(req, res, ['targetProject'])) return;

    const { targetProject } = req.body as { targetProject: string };

    if (typeof targetProject !== 'string' || targetProject.length === 0 || targetProject.length > MAX_PROJECT_NAME_LENGTH) {
      this.badRequest(res, 'Invalid targetProject');
      return;
    }

    const db = this.dbManager.getSessionStore().db;

    try {
      const counts = mergeProject(db, projectName, targetProject);
      res.json({ success: true, counts });
    } catch (error) {
      this.sendDomainError(res, error);
    }
  });

  /**
   * DELETE /api/projects/:name
   * Deletes all rows for a project across all 4 tables.
   * Returns 404 if the project does not exist.
   */
  private handleDelete = this.wrapHandler((req: Request, res: Response): void => {
    const projectName = this.parseProjectName(req, res);
    if (projectName === null) return;

    const db = this.dbManager.getSessionStore().db;

    try {
      const counts = deleteProject(db, projectName);
      logger.info('DB', 'Project deleted via API', { project: projectName, counts });
      res.json({ success: true, counts });
    } catch (error) {
      this.sendDomainError(res, error);
    }
  });
}
