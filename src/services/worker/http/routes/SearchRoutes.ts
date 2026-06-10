
import express, { Request, Response } from 'express';
import * as fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { SearchManager } from '../../SearchManager.js';
import type { SearchTelemetryEnvelope } from '../../SearchManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';
import { groupByDate } from '../../../../shared/timeline-formatting.js';
import { countObservationsByProjects } from '../../../context/ObservationCompiler.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import type { ObservationSearchResult, SessionSummarySearchResult } from '../../../sqlite/types.js';
import { captureEvent } from '../../../telemetry/telemetry.js';

const ONBOARDING_EXPLAINER_PATH: string = path.resolve(__dirname, '../skills/how-it-works/onboarding-explainer.md');

const cachedOnboardingExplainer: string | null = (() => {
  try {
    const text = fs.readFileSync(ONBOARDING_EXPLAINER_PATH, 'utf-8');
    logger.info('SYSTEM', 'Cached onboarding explainer at boot', {
      path: ONBOARDING_EXPLAINER_PATH,
      bytes: Buffer.byteLength(text, 'utf-8'),
    });
    return text;
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Onboarding explainer not present at boot, /api/onboarding/explainer will 404', {
      path: ONBOARDING_EXPLAINER_PATH,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
})();

// TTL-cached settings reader. handleContextInject runs on every hook callback
// (PostToolUse fires after every Read/Edit), so re-parsing settings.json from
// disk on every request would mean a sync read per tool call. 5s is short
// enough that toggling CLAUDE_MEM_WELCOME_HINT_ENABLED is responsive in
// practice and long enough to absorb hook bursts.
const SETTINGS_CACHE_TTL_MS = 5000;

const WELCOME_HINT_TEMPLATE = `# claude-mem status

This project has no memory yet. The current session will seed it; subsequent sessions will receive auto-injected context for relevant past work.

Memory injection starts on your second session in a project.

\`/learn-codebase\` is available if the user wants to front-load the entire repo into memory in a single pass (~5 minutes on a typical repo, optional). Otherwise memory builds passively as work happens.

Live activity: {viewer_url}
How it works: \`/how-it-works\`

This message disappears once the first observation lands.
`;

const semanticContextSchema = z.object({
  q: z.string().optional(),
  project: z.string().optional(),
  limit: z.union([z.string(), z.number()]).optional(),
}).passthrough();

export class SearchRoutes extends BaseRouteHandler {
  private cachedSettings: ReturnType<typeof SettingsDefaultsManager.loadFromFile> | null = null;
  private cachedSettingsAt = 0;
  // Scope this cache to the route instance so separate server/test instances do
  // not inherit each other's positive observation state through shared modules.
  private readonly projectsKnownNonEmpty = new Set<string>();

  constructor(
    private searchManager: SearchManager
  ) {
    super();
  }

  private getCachedSettings(): ReturnType<typeof SettingsDefaultsManager.loadFromFile> {
    const now = Date.now();
    if (this.cachedSettings && now - this.cachedSettingsAt < SETTINGS_CACHE_TTL_MS) {
      return this.cachedSettings;
    }
    // Keep env overrides out of the cache so toggles remain request-local and
    // tests do not inherit a transient process.env value for the next 5 seconds.
    this.cachedSettings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, false);
    this.cachedSettingsAt = now;
    return this.cachedSettings;
  }

  private projectsHaveObservations(
    sessionStore: ReturnType<SearchManager['getSessionStore']>,
    projects: string[],
  ): boolean {
    if (projects.every(p => this.projectsKnownNonEmpty.has(p))) {
      return true;
    }
    const observationCount = countObservationsByProjects(sessionStore, projects);
    if (observationCount > 0) {
      for (const p of projects) this.projectsKnownNonEmpty.add(p);
      return true;
    }
    return false;
  }

  setupRoutes(app: express.Application): void {
    // One telemetry site for every /api/search* endpoint (unified + dedicated
    // variants), so search adoption is not undercounted. /api/search/help is
    // documentation, not a search. Properties are the endpoint name (OUR route
    // segment, bounded to a known enum), outcome, and latency — never query
    // text (see docs/public/telemetry.mdx).
    const KNOWN_SEARCH_ENDPOINTS = new Set([
      'unified', 'observations', 'sessions', 'prompts', 'by-concept', 'by-file', 'by-type',
    ]);
    app.use('/api/search', (req: Request, res: Response, next: express.NextFunction) => {
      if (req.path !== '/help') {
        const searchStartedAt = Date.now();
        const segment = req.path === '/' ? 'unified' : req.path.slice(1).split('/')[0];
        const endpoint = KNOWN_SEARCH_ENDPOINTS.has(segment) ? segment : 'other';
        res.once('finish', () => {
          // res.locals.searchTelemetry is the retrieval-quality envelope
          // (result_count, search_strategy, chroma_available, fallback_reason)
          // populated by SearchManager.search() and stashed by the handler —
          // counts/booleans/enums only, never response-body introspection.
          captureEvent('search_performed', {
            endpoint,
            outcome: res.statusCode < 400 ? 'ok' : 'error',
            duration_ms: Date.now() - searchStartedAt,
            ...(res.locals.searchTelemetry ?? {}),
          });
        });
      }
      next();
    });

    // context_injected is captured inside handleContextInject so the event can
    // carry the depth/economics stats computed during generation.

    app.get('/api/search', this.handleUnifiedSearch.bind(this));
    app.get('/api/timeline', this.handleUnifiedTimeline.bind(this));
    app.get('/api/decisions', this.handleDecisions.bind(this));
    app.get('/api/changes', this.handleChanges.bind(this));
    app.get('/api/how-it-works', this.handleHowItWorks.bind(this));

    app.get('/api/search/observations', this.handleSearchObservations.bind(this));
    app.get('/api/search/sessions', this.handleSearchSessions.bind(this));
    app.get('/api/search/prompts', this.handleSearchPrompts.bind(this));
    app.get('/api/search/by-concept', this.handleSearchByConcept.bind(this));
    app.get('/api/search/by-file', this.handleSearchByFile.bind(this));
    app.get('/api/search/by-type', this.handleSearchByType.bind(this));

    app.get('/api/context/recent', this.handleGetRecentContext.bind(this));
    app.get('/api/context/timeline', this.handleGetContextTimeline.bind(this));
    app.get('/api/context/preview', this.handleContextPreview.bind(this));
    app.get('/api/context/inject', this.handleContextInject.bind(this));
    app.post('/api/context/semantic', validateBody(semanticContextSchema), this.handleSemanticContext.bind(this));
    app.get('/api/onboarding/explainer', this.handleOnboardingExplainer.bind(this));

    app.get('/api/timeline/by-query', this.handleGetTimelineByQuery.bind(this));
    app.get('/api/search/help', this.handleSearchHelp.bind(this));
  }

  private handleUnifiedSearch = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    // Mutable telemetry sink: SearchManager.search() fills it with the
    // retrieval-quality envelope; the /api/search middleware spreads it into
    // search_performed on response finish. Stashed before the await so the
    // envelope survives even if response serialization fails afterwards.
    const searchTelemetry: SearchTelemetryEnvelope = {};
    res.locals.searchTelemetry = searchTelemetry;
    const result = await this.searchManager.search(req.query, searchTelemetry);
    res.json(result);
  });

  private handleUnifiedTimeline = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.timeline(req.query);
    res.json(result);
  });

  private handleDecisions = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.decisions(req.query);
    res.json(result);
  });

  private handleChanges = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.changes(req.query);
    res.json(result);
  });

  private handleHowItWorks = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.howItWorks(req.query);
    res.json(result);
  });

  private handleSearchObservations = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.searchObservations(req.query);
    res.json(result);
  });

  private handleSearchSessions = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.searchSessions(req.query);
    res.json(result);
  });

  private handleSearchPrompts = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.searchUserPrompts(req.query);
    res.json(result);
  });

  private handleSearchByConcept = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const orchestrator = this.searchManager.getOrchestrator();
    const formatter = this.searchManager.getFormatter();
    const query = req.query as Record<string, any>;
    const rawConcept = query.concepts ?? query.concept;
    const concept = Array.isArray(rawConcept) ? rawConcept[0] : rawConcept;
    const strategyResult = await orchestrator.findByConcept(concept, query);
    const observations = strategyResult.results.observations;

    if (observations.length === 0) {
      res.json({
        content: [{
          type: 'text' as const,
          text: `No observations found with concept "${concept}"`
        }]
      });
      return;
    }

    const header = `Found ${observations.length} observation(s) with concept "${concept}"\n\n${formatter.formatTableHeader()}`;
    const rows = observations.map((obs: ObservationSearchResult, i: number) => formatter.formatObservationIndex(obs, i));
    res.json({
      content: [{
        type: 'text' as const,
        text: header + '\n' + rows.join('\n')
      }]
    });
  });

  private handleSearchByFile = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const orchestrator = this.searchManager.getOrchestrator();
    const formatter = this.searchManager.getFormatter();
    const query = req.query as Record<string, any>;
    const rawFilePath = query.filePath ?? query.files;
    const filePath = Array.isArray(rawFilePath)
      ? rawFilePath[0]
      : (typeof rawFilePath === 'string' && rawFilePath.includes(','))
        ? rawFilePath.split(',')[0].trim()
        : rawFilePath;

    const { observations, sessions } = await orchestrator.findByFile(filePath, query);
    const totalResults = observations.length + sessions.length;

    if (totalResults === 0) {
      res.json({
        content: [{
          type: 'text' as const,
          text: `No results found for file "${filePath}"`
        }]
      });
      return;
    }

    const combined: Array<{
      type: 'observation' | 'session';
      data: ObservationSearchResult | SessionSummarySearchResult;
      epoch: number;
      created_at: string;
    }> = [
      ...observations.map((obs: ObservationSearchResult) => ({
        type: 'observation' as const,
        data: obs,
        epoch: obs.created_at_epoch,
        created_at: obs.created_at
      })),
      ...sessions.map((sess: SessionSummarySearchResult) => ({
        type: 'session' as const,
        data: sess,
        epoch: sess.created_at_epoch,
        created_at: sess.created_at
      }))
    ];

    combined.sort((a, b) => b.epoch - a.epoch);
    const resultsByDate = groupByDate(combined, item => item.created_at);

    const lines: string[] = [];
    lines.push(`Found ${totalResults} result(s) for file "${filePath}"`);
    lines.push('');

    for (const [day, dayResults] of resultsByDate) {
      lines.push(`### ${day}`);
      lines.push('');
      lines.push(formatter.formatTableHeader());
      for (const result of dayResults) {
        if (result.type === 'observation') {
          lines.push(formatter.formatObservationIndex(result.data as ObservationSearchResult, 0));
        } else {
          lines.push(formatter.formatSessionIndex(result.data as SessionSummarySearchResult, 0));
        }
      }
      lines.push('');
    }

    res.json({
      content: [{
        type: 'text' as const,
        text: lines.join('\n')
      }]
    });
  });

  private handleSearchByType = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const orchestrator = this.searchManager.getOrchestrator();
    const formatter = this.searchManager.getFormatter();
    const query = req.query as Record<string, any>;
    const rawType = query.type;
    const type = (typeof rawType === 'string' && rawType.includes(','))
      ? rawType.split(',').map((s: string) => s.trim()).filter(Boolean)
      : rawType;
    const typeStr = Array.isArray(type) ? type.join(', ') : type;

    const strategyResult = await orchestrator.findByType(type, query);
    const observations = strategyResult.results.observations;

    if (observations.length === 0) {
      res.json({
        content: [{
          type: 'text' as const,
          text: `No observations found with type "${typeStr}"`
        }]
      });
      return;
    }

    const header = `Found ${observations.length} observation(s) with type "${typeStr}"\n\n${formatter.formatTableHeader()}`;
    const rows = observations.map((obs: ObservationSearchResult, i: number) => formatter.formatObservationIndex(obs, i));
    res.json({
      content: [{
        type: 'text' as const,
        text: header + '\n' + rows.join('\n')
      }]
    });
  });

  private handleGetRecentContext = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.getRecentContext(req.query);
    res.json(result);
  });

  private handleGetContextTimeline = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.getContextTimeline(req.query);
    res.json(result);
  });

  private handleContextPreview = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const projectName = req.query.project as string;

    if (!projectName) {
      this.badRequest(res, 'Project parameter is required');
      return;
    }

    const { generateContext } = await import('../../../context-generator.js');

    const cwd = `/preview/${projectName}`;

    const contextText = await generateContext(
      {
        session_id: 'preview-' + Date.now(),
        cwd: cwd,
        projects: [projectName]
      },
      true  
    );

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(contextText);
  });

  private handleContextInject = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const projectsParam = (req.query.projects as string) || (req.query.project as string);
    const forHuman = req.query.colors === 'true';
    const full = req.query.full === 'true';

    if (!projectsParam) {
      this.badRequest(res, 'Project(s) parameter is required');
      return;
    }

    const projects = projectsParam.split(',').map(p => p.trim()).filter(Boolean);

    if (projects.length === 0) {
      this.badRequest(res, 'At least one project is required');
      return;
    }

    const settings = this.getCachedSettings();
    // Env always wins over cached settings (mirrors SettingsDefaultsManager
    // applyEnvOverrides semantics). Reading process.env is free, so honoring it
    // here keeps the welcome-hint toggle responsive without waiting out the
    // settings cache TTL.
    const hintEnabledRaw = process.env.CLAUDE_MEM_WELCOME_HINT_ENABLED ?? settings.CLAUDE_MEM_WELCOME_HINT_ENABLED;
    const hintEnabled = String(hintEnabledRaw ?? '').toLowerCase() === 'true';
    if (hintEnabled && !full) {
      const sessionStore = this.searchManager.getSessionStore();
      // Memoized: skips the COUNT(*) query once any project in the set has
      // observations. Hot-path: PostToolUse fires after every Read/Edit.
      if (!this.projectsHaveObservations(sessionStore, projects)) {
        const port = process.env.CLAUDE_MEM_WORKER_PORT ?? settings.CLAUDE_MEM_WORKER_PORT;
        const viewerUrl = `http://localhost:${port}`;
        const hintBody = WELCOME_HINT_TEMPLATE.replace('{viewer_url}', viewerUrl);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(hintBody);
        return;
      }
    }

    const { generateContextWithStats } = await import('../../../context-generator.js');

    const primaryProject = projects[projects.length - 1];
    const cwd = `/context/${primaryProject}`;

    const injectStartedAt = Date.now();
    let contextResult: Awaited<ReturnType<typeof generateContextWithStats>>;
    try {
      contextResult = await generateContextWithStats(
        {
          session_id: 'context-inject-' + Date.now(),
          cwd: cwd,
          projects: projects,
          full
        },
        forHuman
      );
    } catch (error) {
      captureEvent('context_injected', {
        outcome: 'error',
        duration_ms: Date.now() - injectStartedAt,
      });
      throw error;
    }

    // Stats are counts/enums computed alongside rendering (ContextInjectStats);
    // mode/provider snapshot the settings the injection ran under. Empty-state
    // responses (stats === null) injected no memory and are not counted.
    if (contextResult.stats) {
      const settingsSnapshot = this.getCachedSettings();
      captureEvent('context_injected', {
        outcome: 'ok',
        duration_ms: Date.now() - injectStartedAt,
        mode: settingsSnapshot.CLAUDE_MEM_MODE,
        provider: settingsSnapshot.CLAUDE_MEM_PROVIDER,
        ...contextResult.stats,
      });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(contextResult.text);
  });

  private handleSemanticContext = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const query = (req.body?.q || req.query.q) as string;
    const project = (req.body?.project || req.query.project) as string;
    const limit = Math.min(Math.max(parseInt(String(req.body?.limit || req.query.limit || '5'), 10) || 5, 1), 20);

    if (!query || query.length < 20) {
      res.json({ context: '', count: 0 });
      return;
    }

    let result: any;
    try {
      result = await this.searchManager.search({
        query, type: 'observations', project, limit: String(limit), format: 'json'
      });
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      logger.error('HTTP', 'Semantic context query failed', { query, project }, normalizedError);
      res.json({ context: '', count: 0 });
      return;
    }

    const observations = result?.observations || [];
    if (!observations.length) {
      res.json({ context: '', count: 0 });
      return;
    }

    const lines: string[] = ['## Relevant Past Work (semantic match)\n'];
    for (const obs of observations.slice(0, limit)) {
      const date = obs.created_at?.slice(0, 10) || '';
      lines.push(`### ${obs.title || 'Observation'} (${date})`);
      if (obs.narrative) lines.push(obs.narrative);
      lines.push('');
    }

    res.json({ context: lines.join('\n'), count: observations.length });
  });

  private handleOnboardingExplainer = this.wrapHandler((_req: Request, res: Response): void => {
    if (cachedOnboardingExplainer === null) {
      res.status(404).json({ error: 'Onboarding explainer not available' });
      return;
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(cachedOnboardingExplainer);
  });

  private handleGetTimelineByQuery = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.getTimelineByQuery(req.query);
    res.json(result);
  });

  private handleSearchHelp = this.wrapHandler((req: Request, res: Response): void => {
    const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
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
        `curl "${baseUrl}/api/search/observations?query=authentication&limit=5"`,
        `curl "${baseUrl}/api/search/by-type?type=bugfix&limit=10"`,
        `curl "${baseUrl}/api/context/recent?project=claude-mem&limit=3"`,
        `curl "${baseUrl}/api/context/timeline?anchor=123&depth_before=5&depth_after=5"`
      ]
    });
  });
}
