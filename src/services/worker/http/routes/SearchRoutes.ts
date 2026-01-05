/**
 * Search Routes
 *
 * Handles all search operations via SearchManager.
 * All endpoints call SearchManager methods directly.
 */

import express, { Request, Response } from 'express';
import { SearchManager } from '../../SearchManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { logger } from '../../../../utils/logger.js';

export class SearchRoutes extends BaseRouteHandler {
  constructor(
    private searchManager: SearchManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    // Unified endpoints (new consolidated API)
    app.get('/api/search', this.handleUnifiedSearch.bind(this));
    app.get('/api/timeline', this.handleUnifiedTimeline.bind(this));
    app.get('/api/decisions', this.handleDecisions.bind(this));
    app.get('/api/changes', this.handleChanges.bind(this));
    app.get('/api/how-it-works', this.handleHowItWorks.bind(this));

    // Backward compatibility endpoints
    app.get('/api/search/observations', this.handleSearchObservations.bind(this));
    app.get('/api/search/sessions', this.handleSearchSessions.bind(this));
    app.get('/api/search/prompts', this.handleSearchPrompts.bind(this));
    app.get('/api/search/by-concept', this.handleSearchByConcept.bind(this));
    app.get('/api/search/by-file', this.handleSearchByFile.bind(this));
    app.get('/api/search/by-type', this.handleSearchByType.bind(this));

    // Context endpoints
    app.get('/api/context/recent', this.handleGetRecentContext.bind(this));
    app.get('/api/context/timeline', this.handleGetContextTimeline.bind(this));
    app.get('/api/context/preview', this.handleContextPreview.bind(this));
    app.get('/api/context/inject', this.handleContextInject.bind(this));

    // Timeline and help endpoints
    app.get('/api/timeline/by-query', this.handleGetTimelineByQuery.bind(this));
    app.get('/api/search/help', this.handleSearchHelp.bind(this));
  }

  /**
   * Unified search (observations + sessions + prompts)
   * GET /api/search?query=...&type=observations&limit=20
   */
  private handleUnifiedSearch = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.search(req.query);
    res.json(result);
  });

  /**
   * Unified timeline (anchor or query-based)
   * GET /api/timeline?anchor=123 OR GET /api/timeline?query=...
   */
  private handleUnifiedTimeline = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.timeline(req.query);
    res.json(result);
  });

  /**
   * Semantic shortcut for finding decision observations
   * GET /api/decisions?limit=20
   */
  private handleDecisions = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.decisions(req.query);
    res.json(result);
  });

  /**
   * Semantic shortcut for finding change-related observations
   * GET /api/changes?limit=20
   */
  private handleChanges = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.changes(req.query);
    res.json(result);
  });

  /**
   * Semantic shortcut for finding "how it works" explanations
   * GET /api/how-it-works?limit=20
   */
  private handleHowItWorks = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.howItWorks(req.query);
    res.json(result);
  });

  /**
   * Search observations (use /api/search?type=observations instead)
   * GET /api/search/observations?query=...&limit=20&project=...
   */
  private handleSearchObservations = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.searchObservations(req.query);
    res.json(result);
  });

  /**
   * Search session summaries
   * GET /api/search/sessions?query=...&limit=20
   */
  private handleSearchSessions = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.searchSessions(req.query);
    res.json(result);
  });

  /**
   * Search user prompts
   * GET /api/search/prompts?query=...&limit=20
   */
  private handleSearchPrompts = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.searchUserPrompts(req.query);
    res.json(result);
  });

  /**
   * Search observations by concept
   * GET /api/search/by-concept?concept=discovery&limit=5
   */
  private handleSearchByConcept = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.findByConcept(req.query);
    res.json(result);
  });

  /**
   * Search by file path
   * GET /api/search/by-file?filePath=...&limit=10
   */
  private handleSearchByFile = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.findByFile(req.query);
    res.json(result);
  });

  /**
   * Search observations by type
   * GET /api/search/by-type?type=bugfix&limit=10
   */
  private handleSearchByType = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.findByType(req.query);
    res.json(result);
  });

  /**
   * Get recent context (summaries and observations for a project)
   * GET /api/context/recent?project=...&limit=3
   */
  private handleGetRecentContext = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.getRecentContext(req.query);
    res.json(result);
  });

  /**
   * Get context timeline around an anchor point
   * GET /api/context/timeline?anchor=123&depth_before=10&depth_after=10&project=...
   */
  private handleGetContextTimeline = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.getContextTimeline(req.query);
    res.json(result);
  });

  /**
   * Generate context preview for settings modal
   * GET /api/context/preview?project=...
   */
  private handleContextPreview = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const projectName = req.query.project as string;

    if (!projectName) {
      this.badRequest(res, 'Project parameter is required');
      return;
    }

    // Import context generator (runs in worker, has access to database)
    const { generateContext } = await import('../../../context-generator.js');

    // Use project name as CWD (generateContext uses path.basename to get project)
    const cwd = `/preview/${projectName}`;

    // Generate context with colors for terminal display
    const contextText = await generateContext(
      {
        session_id: 'preview-' + Date.now(),
        cwd: cwd
      },
      true  // useColors=true for ANSI terminal output
    );

    // Return as plain text
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(contextText);
  });

  /**
   * Context injection endpoint for hooks
   * GET /api/context/inject?projects=...&colors=true
   * GET /api/context/inject?project=...&colors=true (legacy, single project)
   *
   * Returns pre-formatted context string ready for display.
   * Use colors=true for ANSI-colored terminal output.
   *
   * For worktrees, pass comma-separated projects (e.g., "main,worktree-branch")
   * to get a unified timeline from both parent and worktree.
   */
  private handleContextInject = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    // Support both legacy `project` and new `projects` parameter
    const projectsParam = (req.query.projects as string) || (req.query.project as string);
    const useColors = req.query.colors === 'true';

    if (!projectsParam) {
      this.badRequest(res, 'Project(s) parameter is required');
      return;
    }

    // Parse comma-separated projects list
    const projects = projectsParam.split(',').map(p => p.trim()).filter(Boolean);

    if (projects.length === 0) {
      this.badRequest(res, 'At least one project is required');
      return;
    }

    // Import context generator (runs in worker, has access to database)
    const { generateContext } = await import('../../../context-generator.js');

    // Use first project name as CWD (for display purposes)
    const primaryProject = projects[projects.length - 1]; // Last is the current/primary project
    const cwd = `/context/${primaryProject}`;

    // Generate context with all projects
    const contextText = await generateContext(
      {
        session_id: 'context-inject-' + Date.now(),
        cwd: cwd,
        projects: projects
      },
      useColors
    );

    // Return as plain text
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(contextText);
  });

  /**
   * Get timeline by query (search first, then get timeline around best match)
   * GET /api/timeline/by-query?query=...&mode=auto&depth_before=10&depth_after=10
   */
  private handleGetTimelineByQuery = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.getTimelineByQuery(req.query);
    res.json(result);
  });

  /**
   * Get search help documentation
   * GET /api/search/help
   */
  private handleSearchHelp = this.wrapHandler((req: Request, res: Response): void => {
    res.json({
      title: 'Claude-Mem Search API',
      description: 'HTTP API for searching persistent memory',
      endpoints: [
        {
          path: '/api/search/observations',
          method: 'GET',
          description: 'Search observations using full-text search',
          parameters: {
            query: 'Search query (required)',
            limit: 'Number of results (default: 20)',
            project: 'Filter by project name (optional)'
          }
        },
        {
          path: '/api/search/sessions',
          method: 'GET',
          description: 'Search session summaries using full-text search',
          parameters: {
            query: 'Search query (required)',
            limit: 'Number of results (default: 20)'
          }
        },
        {
          path: '/api/search/prompts',
          method: 'GET',
          description: 'Search user prompts using full-text search',
          parameters: {
            query: 'Search query (required)',
            limit: 'Number of results (default: 20)',
            project: 'Filter by project name (optional)'
          }
        },
        {
          path: '/api/search/by-concept',
          method: 'GET',
          description: 'Find observations by concept tag',
          parameters: {
            concept: 'Concept tag (required): discovery, decision, bugfix, feature, refactor',
            limit: 'Number of results (default: 10)',
            project: 'Filter by project name (optional)'
          }
        },
        {
          path: '/api/search/by-file',
          method: 'GET',
          description: 'Find observations and sessions by file path',
          parameters: {
            filePath: 'File path or partial path (required)',
            limit: 'Number of results per type (default: 10)',
            project: 'Filter by project name (optional)'
          }
        },
        {
          path: '/api/search/by-type',
          method: 'GET',
          description: 'Find observations by type',
          parameters: {
            type: 'Observation type (required): discovery, decision, bugfix, feature, refactor',
            limit: 'Number of results (default: 10)',
            project: 'Filter by project name (optional)'
          }
        },
        {
          path: '/api/context/recent',
          method: 'GET',
          description: 'Get recent session context including summaries and observations',
          parameters: {
            project: 'Project name (default: current directory)',
            limit: 'Number of recent sessions (default: 3)'
          }
        },
        {
          path: '/api/context/timeline',
          method: 'GET',
          description: 'Get unified timeline around a specific point in time',
          parameters: {
            anchor: 'Anchor point: observation ID, session ID (e.g., "S123"), or ISO timestamp (required)',
            depth_before: 'Number of records before anchor (default: 10)',
            depth_after: 'Number of records after anchor (default: 10)',
            project: 'Filter by project name (optional)'
          }
        },
        {
          path: '/api/timeline/by-query',
          method: 'GET',
          description: 'Search for best match, then get timeline around it',
          parameters: {
            query: 'Search query (required)',
            mode: 'Search mode: "auto", "observations", or "sessions" (default: "auto")',
            depth_before: 'Number of records before match (default: 10)',
            depth_after: 'Number of records after match (default: 10)',
            project: 'Filter by project name (optional)'
          }
        },
        {
          path: '/api/search/help',
          method: 'GET',
          description: 'Get this help documentation'
        }
      ],
      examples: [
        'curl "http://localhost:37777/api/search/observations?query=authentication&limit=5"',
        'curl "http://localhost:37777/api/search/by-type?type=bugfix&limit=10"',
        'curl "http://localhost:37777/api/context/recent?project=claude-mem&limit=3"',
        'curl "http://localhost:37777/api/context/timeline?anchor=123&depth_before=5&depth_after=5"'
      ]
    });
  });
}
