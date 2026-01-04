/**
 * Folder Index Routes
 *
 * Handles folder discovery, timeline compilation, and CLAUDE.md generation.
 * Provides endpoints for folder-based memory organization.
 */

import express, { Request, Response } from 'express';
import { isAbsolute } from 'path';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import {
  extractFoldersFromObservations,
  compileTimeline,
  regenerateFolderIndex
} from '../../../folder-index/index.js';
import type { FolderIndexConfig } from '../../../folder-index/types.js';
import type { ObservationRow } from '../../sqlite/types.js';
import type { Observation } from '../../context/types.js';
import { logger } from '../../../../utils/logger.js';

export class FolderIndexRoutes extends BaseRouteHandler {
  constructor(
    private dbManager: DatabaseManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/folders/discover', this.handleDiscoverFolders.bind(this));
    app.get('/api/folders/:folderPath/timeline', this.handleGetFolderTimeline.bind(this));
    app.post('/api/folders/:folderPath/generate-claude-md', this.handleGenerateClaudeMd.bind(this));
  }

  /**
   * Discover folders with observation activity
   * GET /api/folders/discover?project={project}
   *
   * Returns list of folders that have file activity in observations,
   * sorted by observation count descending.
   */
  private handleDiscoverFolders = this.wrapHandler((req: Request, res: Response): void => {
    const project = req.query.project as string | undefined;

    if (!project) {
      this.badRequest(res, 'Project parameter is required');
      return;
    }

    const store = this.dbManager.getSessionStore();

    // Get all observations for the project
    const db = store.db;
    const observations = db.prepare(`
      SELECT * FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
    `).all(project);

    // Use default folder index config
    // TODO: Load from settings when folder index config is implemented
    const config: FolderIndexConfig = {
      enabled: true,
      maxDepth: 10,
      excludeFolders: ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'],
      minActivityThreshold: 1
    };

    // Extract folders with activity counts
    // ObservationRow is structurally compatible with Observation (has all required fields)
    const folderActivityMap = extractFoldersFromObservations(observations as ObservationRow[] as Observation[], config);

    // Convert to array and sort by observation count descending
    const folders = Array.from(folderActivityMap.entries())
      .map(([path, observationCount]) => ({ path, observationCount }))
      .sort((a, b) => b.observationCount - a.observationCount);

    logger.info('FOLDER_INDEX', 'Discovered folders', {
      project,
      totalFolders: folders.length,
      totalObservations: observations.length
    });

    res.json({ folders });
  });

  /**
   * Get compiled timeline for a folder
   * GET /api/folders/:folderPath/timeline?project={project}
   *
   * Returns chronologically organized observations that reference
   * files within the specified folder.
   */
  private handleGetFolderTimeline = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const encodedFolderPath = req.params.folderPath;
    const project = req.query.project as string | undefined;

    if (!encodedFolderPath) {
      this.badRequest(res, 'Folder path parameter is required');
      return;
    }

    if (!project) {
      this.badRequest(res, 'Project parameter is required');
      return;
    }

    // Decode URL-encoded folder path
    const folderPath = decodeURIComponent(encodedFolderPath);

    // Validate that folder path is absolute
    if (!isAbsolute(folderPath)) {
      this.badRequest(res, 'Folder path must be absolute (e.g., /Users/name/project/src)');
      return;
    }

    logger.info('FOLDER_INDEX', 'Compiling folder timeline', {
      project,
      folderPath
    });

    // Compile timeline using FolderTimelineCompiler
    const timeline = await compileTimeline(project, folderPath);

    res.json(timeline);
  });

  /**
   * Manually trigger CLAUDE.md generation for a folder
   * POST /api/folders/:folderPath/generate-claude-md?project={project}
   *
   * Generates (or regenerates) a CLAUDE.md file in the specified folder
   * based on observation activity.
   */
  private handleGenerateClaudeMd = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const encodedFolderPath = req.params.folderPath;
    const project = req.query.project as string | undefined;

    if (!encodedFolderPath) {
      this.badRequest(res, 'Folder path parameter is required');
      return;
    }

    if (!project) {
      this.badRequest(res, 'Project parameter is required');
      return;
    }

    // Decode URL-encoded folder path
    const folderPath = decodeURIComponent(encodedFolderPath);

    // Validate that folder path is absolute
    if (!isAbsolute(folderPath)) {
      this.badRequest(res, 'Folder path must be absolute (e.g., /Users/name/project/src)');
      return;
    }

    logger.info('FOLDER_INDEX', 'Generating CLAUDE.md', {
      project,
      folderPath
    });

    // Generate the index
    await regenerateFolderIndex(project, folderPath);

    // Get timeline to return stats
    const timeline = await compileTimeline(project, folderPath);

    res.json({
      success: true,
      path: `${folderPath}/CLAUDE.md`,
      observationCount: timeline.observationCount
    });
  });
}
