
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
import { telemetryBuffer } from '../../../telemetry/buffer.js';

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
  platformSource: z.string().optional(),
  platform_source: z.string().optional(),
}).passthrough();

export class SearchRoutes extends BaseRouteHandler {
  private cachedSettings: ReturnType<typeof SettingsDefaultsManager.loadFromFile> | null = null;
  private cachedSettingsAt = 0;
  // Scope this cache to the route instance so separate server/test instances do
  // not inherit each other's positive observation state through shared modules.
  private readonly projectsKnownNonEmpty = new Set<string>();

  constructor(
    private searchManager: SearchManager,
    // Structural type (not the SyncClient class) so tests can pass a stub and
    // route construction stays decoupled from sync wiring. Null when sync is
    // unconfigured — context injection then skips the session-start pull.
    private syncClient: { pullOnce(options?: { timeoutMs?: number }): Promise<void> } | null = null
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
    platformSource?: string,
  ): boolean {
    const cacheKey = platformSource ? `${platformSource}\0${projects.join('\0')}` : projects.join('\0');
    if (this.projectsKnownNonEmpty.has(cacheKey)) {
      return true;
    }
    const observationCount = countObservationsByProjects(sessionStore, projects, platformSource);
    if (observationCount > 0) {
      this.projectsKnownNonEmpty.add(cacheKey);
      return true;
    }
    return false;
  }

  setupRoutes(app: express.Application): void {
    // One telemetry site for every /api/search* endpoint (unified + dedicated
    // variants), so search adoption is not undercounted. Properties are the
    // endpoint name (OUR route segment, bounded to a known enum), outcome, and
    // latency — never query text (see docs/public/telemetry.mdx).
    const KNOWN_SEARCH_ENDPOINTS = new Set([
      'unified', 'observations', 'by-file',
    ]);
    app.use('/api/search', (req: Request, res: Response, next: express.NextFunction) => {
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
      next();
    });

    // context_injected is captured inside handleContextInject so the event can
    // carry the depth/economics stats computed during generation.

    app.get('/api/search', this.handleUnifiedSearch.bind(this));
    app.get('/api/timeline', this.handleUnifiedTimeline.bind(this));

    app.get('/api/search/observations', this.handleSearchObservations.bind(this));
    app.get('/api/search/by-file', this.handleSearchByFile.bind(this));

    app.get('/api/context/recent', this.handleGetRecentContext.bind(this));
    app.get('/api/context/preview', this.handleContextPreview.bind(this));
    app.get('/api/context/inject', this.handleContextInject.bind(this));
    app.post('/api/context/semantic', validateBody(semanticContextSchema), this.handleSemanticContext.bind(this));
    app.get('/api/onboarding/explainer', this.handleOnboardingExplainer.bind(this));

    app.get('/api/timeline/by-query', this.handleGetTimelineByQuery.bind(this));
  }

  private handleUnifiedSearch = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    // Mutable telemetry sink: SearchManager.search() fills it with the
    // retrieval-quality envelope; the /api/search middleware spreads it into
    // search_performed on response finish. Stashed before the await so the
    // envelope survives even if response serialization fails afterwards.
    const searchTelemetry: SearchTelemetryEnvelope = {};
    res.locals.searchTelemetry = searchTelemetry;
    const result = await this.searchManager.search(this.queryWithPlatformSource(req), searchTelemetry);
    res.json(result);
  });

  private handleUnifiedTimeline = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.timeline(this.queryWithPlatformSource(req));
    res.json(result);
  });

  private handleSearchObservations = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.searchObservations(this.queryWithPlatformSource(req));
    res.json(result);
  });

  private handleSearchByFile = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const orchestrator = this.searchManager.getOrchestrator();
    const formatter = this.searchManager.getFormatter();
    const query = this.queryWithPlatformSource(req);
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

  private handleGetRecentContext = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.getRecentContext(this.queryWithPlatformSource(req));
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
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);

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
      if (!this.projectsHaveObservations(sessionStore, projects, platformSource)) {
        const port = process.env.CLAUDE_MEM_WORKER_PORT ?? settings.CLAUDE_MEM_WORKER_PORT;
        const viewerUrl = `http://localhost:${port}`;
        const hintBody = WELCOME_HINT_TEMPLATE.replace('{viewer_url}', viewerUrl);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(hintBody);
        return;
      }
    }

    const { generateContextWithStats } = await import('../../../context-generator.js');

    // Immediate session-start pull (plan Phase 3 task 4, prime directive #3):
    // catch up on other devices' ops before compiling context. Hard-bounded so
    // a dead network can't stall injection; pullOnce never throws — failure
    // simply proceeds with local data.
    if (this.syncClient) {
      await this.syncClient.pullOnce({ timeoutMs: 1500 });
    }

    const primaryProject = projects[projects.length - 1];
    const cwd = `/context/${primaryProject}`;

    const injectStartedAt = Date.now();
    const injectRequest = {
      session_id: 'context-inject-' + Date.now(),
      cwd: cwd,
      projects: projects,
      ...(platformSource ? { platformSource } : {}),
      full
    };
    let contextResult: Awaited<ReturnType<typeof generateContextWithStats>>;
    try {
      contextResult = await generateContextWithStats(injectRequest, forHuman);
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      // context_injected is HOOK-level (no sessionDbId in scope) → null key,
      // routed to the 5-minute time-window rollup, NOT the per-session path.
      telemetryBuffer.record('context_injected', null, {
        outcome: 'error',
        duration_ms: Date.now() - injectStartedAt,
      });
      logger.error('HTTP', 'Context injection failed', { projects, platformSource, full }, normalizedError);
      throw error;
    }

    // Stats are counts/enums computed alongside rendering (ContextInjectStats);
    // mode/provider snapshot the settings the injection ran under. Empty-state
    // responses (stats === null) injected no memory and are not counted.
    if (contextResult.stats) {
      const settingsSnapshot = this.getCachedSettings();
      // Hook-level → null key, time-window rollup (see error branch above).
      telemetryBuffer.record('context_injected', null, {
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
    const query = SearchRoutes.firstString(req.body?.q) ?? SearchRoutes.firstString(req.query.q) ?? '';
    const project = SearchRoutes.firstString(req.body?.project) ?? SearchRoutes.firstString(req.query.project);
    const limit = Math.min(Math.max(parseInt(String(req.body?.limit || req.query.limit || '5'), 10) || 5, 1), 20);
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);

    if (!query || query.length < 20) {
      res.json({ context: '', count: 0 });
      return;
    }

    let result: any;
    try {
      result = await this.searchManager.search({
        query,
        type: 'observations',
        project,
        limit: String(limit),
        format: 'json',
        ...(platformSource ? { platformSource } : {}),
      });
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      logger.error('HTTP', 'Semantic context query failed', { query, project, platformSource }, normalizedError);
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

  private queryWithPlatformSource(req: Request): Record<string, any> {
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);
    if (!platformSource) {
      return req.query as Record<string, any>;
    }
    return {
      ...(req.query as Record<string, any>),
      platformSource,
    };
  }

  private handleOnboardingExplainer = this.wrapHandler((_req: Request, res: Response): void => {
    if (cachedOnboardingExplainer === null) {
      res.status(404).json({ error: 'Onboarding explainer not available' });
      return;
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(cachedOnboardingExplainer);
  });

  private handleGetTimelineByQuery = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.getTimelineByQuery(this.queryWithPlatformSource(req));
    res.json(result);
  });
}
