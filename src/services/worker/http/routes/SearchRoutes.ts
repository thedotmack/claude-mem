/**
 * Search Routes
 *
 * Handles all search operations by proxying to the MCP search server.
 * All endpoints call MCP tools via the client connection.
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getPackageRoot } from '../../../../shared/paths.js';
import { logger } from '../../../../utils/logger.js';

export class SearchRoutes {
  constructor(
    private mcpClient: Client
  ) {}

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
   * GET /api/search?query=...&type=observations&format=index&limit=20
   */
  private async handleUnifiedSearch(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'search',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Unified search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Unified timeline (anchor or query-based)
   * GET /api/timeline?anchor=123 OR GET /api/timeline?query=...
   */
  private async handleUnifiedTimeline(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'timeline',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Unified timeline failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Semantic shortcut for finding decision observations
   * GET /api/decisions?format=index&limit=20
   */
  private async handleDecisions(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'decisions',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Decisions search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Semantic shortcut for finding change-related observations
   * GET /api/changes?format=index&limit=20
   */
  private async handleChanges(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'changes',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Changes search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Semantic shortcut for finding "how it works" explanations
   * GET /api/how-it-works?format=index&limit=20
   */
  private async handleHowItWorks(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'how_it_works',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'How it works search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Search observations (use /api/search?type=observations instead)
   * GET /api/search/observations?query=...&format=index&limit=20&project=...
   */
  private async handleSearchObservations(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'search_observations',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Search session summaries
   * GET /api/search/sessions?query=...&format=index&limit=20
   */
  private async handleSearchSessions(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'search_sessions',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Search user prompts
   * GET /api/search/prompts?query=...&format=index&limit=20
   */
  private async handleSearchPrompts(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'search_user_prompts',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Search observations by concept
   * GET /api/search/by-concept?concept=discovery&format=index&limit=5
   */
  private async handleSearchByConcept(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'find_by_concept',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Search by file path
   * GET /api/search/by-file?filePath=...&format=index&limit=10
   */
  private async handleSearchByFile(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'find_by_file',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Search observations by type
   * GET /api/search/by-type?type=bugfix&format=index&limit=10
   */
  private async handleSearchByType(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'find_by_type',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get recent context (summaries and observations for a project)
   * GET /api/context/recent?project=...&limit=3
   */
  private async handleGetRecentContext(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'get_recent_context',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get context timeline around an anchor point
   * GET /api/context/timeline?anchor=123&depth_before=10&depth_after=10&project=...
   */
  private async handleGetContextTimeline(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'get_context_timeline',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Generate context preview for settings modal
   * GET /api/context/preview?project=...
   */
  private async handleContextPreview(req: Request, res: Response): Promise<void> {
    try {
      // Dynamic import to use BUILT context-hook function
      const packageRoot = getPackageRoot();
      const contextHookPath = path.join(packageRoot, 'plugin', 'scripts', 'context-hook.js');
      const { contextHook } = await import(contextHookPath);

      // Get project from query parameter
      const projectName = req.query.project as string;

      if (!projectName) {
        return res.status(400).json({ error: 'Project parameter is required' });
      }

      // Use project name as CWD (contextHook uses path.basename to get project)
      const cwd = `/preview/${projectName}`;

      // Generate preview context (with colors for terminal display)
      const contextText = await contextHook(
        {
          session_id: 'preview-' + Date.now(),
          cwd: cwd
        },
        true  // useColors=true for ANSI terminal output
      );

      // Return as plain text
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(contextText);
    } catch (error) {
      logger.failure('WORKER', 'Context preview generation failed', {}, error as Error);
      res.status(500).json({
        error: 'Failed to generate context preview',
        message: (error as Error).message
      });
    }
  }

  /**
   * Context injection endpoint for hooks
   * GET /api/context/inject?project=...&colors=true
   *
   * Returns pre-formatted context string ready for display.
   * Use colors=true for ANSI-colored terminal output.
   */
  private async handleContextInject(req: Request, res: Response): Promise<void> {
    try {
      const projectName = req.query.project as string;
      const useColors = req.query.colors === 'true';

      if (!projectName) {
        res.status(400).json({ error: 'Project parameter is required' });
        return;
      }

      // Import context generator (runs in worker, has access to database)
      // Note: After bundling, context-generator.cjs is in the same directory as worker-service.cjs
      const { generateContext } = await import('./context-generator.cjs');

      // Use project name as CWD (generateContext uses path.basename to get project)
      const cwd = `/context/${projectName}`;

      // Generate context
      const contextText = await generateContext(
        {
          session_id: 'context-inject-' + Date.now(),
          cwd: cwd
        },
        useColors
      );

      // Return as plain text
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(contextText);
    } catch (error) {
      logger.failure('WORKER', 'Context injection failed', {}, error as Error);
      res.status(500).json({
        error: 'Failed to generate context',
        message: (error as Error).message
      });
    }
  }

  /**
   * Get timeline by query (search first, then get timeline around best match)
   * GET /api/timeline/by-query?query=...&mode=auto&depth_before=10&depth_after=10
   */
  private async handleGetTimelineByQuery(req: Request, res: Response): Promise<void> {
    try {
      const result = await this.mcpClient.callTool({
        name: 'get_timeline_by_query',
        arguments: req.query
      });
      res.json(result.content);
    } catch (error) {
      logger.failure('WORKER', 'Search failed', {}, error as Error);
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /**
   * Get search help documentation
   * GET /api/search/help
   */
  private handleSearchHelp(req: Request, res: Response): void {
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
            format: 'Response format: "index" or "full" (default: "full")',
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
            format: 'Response format: "index" or "full" (default: "full")',
            limit: 'Number of results (default: 20)'
          }
        },
        {
          path: '/api/search/prompts',
          method: 'GET',
          description: 'Search user prompts using full-text search',
          parameters: {
            query: 'Search query (required)',
            format: 'Response format: "index" or "full" (default: "full")',
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
            format: 'Response format: "index" or "full" (default: "full")',
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
            format: 'Response format: "index" or "full" (default: "full")',
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
            format: 'Response format: "index" or "full" (default: "full")',
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
        'curl "http://localhost:37777/api/search/observations?query=authentication&format=index&limit=5"',
        'curl "http://localhost:37777/api/search/by-type?type=bugfix&limit=10"',
        'curl "http://localhost:37777/api/context/recent?project=claude-mem&limit=3"',
        'curl "http://localhost:37777/api/context/timeline?anchor=123&depth_before=5&depth_after=5"'
      ]
    });
  }
}
