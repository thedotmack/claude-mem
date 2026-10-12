
import express, { Request, Response } from 'express';
import * as fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { SearchManager } from '../../SearchManager.js';
import type { SearchTelemetryEnvelope } from '../../SearchManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { AppError } from '../../../server/ErrorHandler.js';
import { scopedProjects } from '../../../sqlite/project-read-keys.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';
import { groupByDate } from '../../../../shared/timeline-formatting.js';
import { countObservationsByProjects } from '../../../context/ObservationCompiler.js';
import { observerHealthWarning, withObserverHealthWarning } from '../../../context/ContextBuilder.js';
import type { ContextInjectStats } from '../../../context/ContextBuilder.js';
import {
  ALL_PLATFORM_SOURCES_CACHE_KEY,
  contextCacheKeys,
  fillContextPlaceholders,
  type ContextCacheKeys,
} from '../../../../shared/context-cache.js';
import type { ContextCacheService, ContextVariantRender } from '../../ContextCacheService.js';

interface ContextInjectRender {
  /** The block with its time placeholders. */
  body: string;
  stats: ContextInjectStats | null;
  cacheable: boolean;
}
import { buildWorkStateContextSection } from '../../../context/sections/WorkStateRenderer.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { getViewerBaseUrl } from '../../../../shared/worker-utils.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { currentUserSettingsSaveCount } from '../../../../shared/context-invalidation.js';
import { getProjectContext } from '../../../../utils/project-name.js';
import { isProjectExcluded } from '../../../../utils/project-filter.js';
import type { ObservationSearchResult, SessionSummarySearchResult } from '../../../sqlite/types.js';
import { captureEvent } from '../../../telemetry/telemetry.js';
import { telemetryBuffer } from '../../../telemetry/buffer.js';
import { proTrialLine } from '../../../../shared/pro-promo.js';
import { ProgressiveMemorySearch } from '../../ProgressiveMemorySearch.js';
import { progressiveSearchToolResult, progressiveSearchToolError, type ProgressiveSearchInput } from '../../../../shared/progressive-search.js';

const ONBOARDING_EXPLAINER_PATH: string = path.resolve(__dirname, '../skills/how-it-works/onboarding-explainer.md');

// Read on first request, not at import. Hook processes share this module but
// never serve the onboarding explainer, so caching at import made every hook
// spawn read the file and log a boot line for nothing (#3665).
let onboardingExplainerCache: { text: string | null } | undefined;

function getOnboardingExplainer(): string | null {
  if (onboardingExplainerCache) {
    return onboardingExplainerCache.text;
  }
  let text: string | null;
  try {
    text = fs.readFileSync(ONBOARDING_EXPLAINER_PATH, 'utf-8');
    logger.debug('SYSTEM', 'Cached onboarding explainer on first request', {
      path: ONBOARDING_EXPLAINER_PATH,
      bytes: Buffer.byteLength(text, 'utf-8'),
    });
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Onboarding explainer not present, /api/onboarding/explainer will 404', {
      path: ONBOARDING_EXPLAINER_PATH,
      message: error instanceof Error ? error.message : String(error),
    });
    text = null;
  }
  onboardingExplainerCache = { text };
  return text;
}

// TTL-cached settings reader. handleContextInject runs on every hook callback
// (PostToolUse fires after every Read/Edit), so re-parsing settings.json from
// disk on every request would mean a sync read per tool call. 5s is short
// enough that toggling CLAUDE_MEM_WELCOME_HINT_ENABLED is responsive in
// practice and long enough to absorb hook bursts.
const SETTINGS_CACHE_TTL_MS = 5000;

/** Bound on the session-start pull when sync's Realtime channel is not live. */

const WELCOME_HINT_TEMPLATE = `# claude-mem status

This project has no memory yet. The current session will seed it; subsequent sessions will receive auto-injected context for relevant past work.

Memory injection starts on your second session in a project.

\`/learn-codebase\` is available if the user wants to front-load the entire repo into memory in a single pass (~5 minutes on a typical repo, optional). Otherwise memory builds passively as work happens.

Live activity: {viewer_url}
{pro_trial_line}
How it works: \`/how-it-works\`

This message disappears once the first observation lands.
`;

const semanticContextSchema = z.object({
  q: z.string().optional(),
  project: z.string().optional(),
  // Every key the checkout reads (gate P2-5); a list, or comma-separated.
  projects: z.union([z.array(z.string()), z.string()]).optional(),
  limit: z.union([z.string(), z.number()]).optional(),
  platformSource: z.string().optional(),
  platform_source: z.string().optional(),
}).passthrough();

export class SearchRoutes extends BaseRouteHandler {
  private progressiveSearch?: ProgressiveMemorySearch;
  private cachedSettings: ReturnType<typeof SettingsDefaultsManager.loadFromFile> | null = null;
  private cachedSettingsAt = 0;
  private cachedSettingsSaveCount = -1;
  // Scope this cache to the route instance so separate server/test instances do
  // not inherit each other's positive observation state through shared modules.
  private readonly projectsKnownNonEmpty = new Set<string>();

  constructor(
    private searchManager: SearchManager,
    // Records each live SessionStart render so the hook can read it from disk
    // next time (liveness plan, Phase 6). Null in tests and tools that only
    // need the route.
    private contextCache: Pick<ContextCacheService, 'recordLiveRender' | 'removalGenerationNow' | 'warmVariant'> | null = null,
    // Cloud sync's pull loop (null when sync is off). Structural so tests can stub it.
    private syncClient: { pullOnce(options?: { timeoutMs?: number }): Promise<void>; isSocketLive(): boolean } | null = null,
  ) {
    super();
  }

  private getCachedSettings(): ReturnType<typeof SettingsDefaultsManager.loadFromFile> {
    const now = Date.now();
    // A settings save (SettingsRoutes) invalidates the snapshot immediately.
    const saveCount = currentUserSettingsSaveCount();
    if (this.cachedSettings && now - this.cachedSettingsAt < SETTINGS_CACHE_TTL_MS && this.cachedSettingsSaveCount === saveCount) {
      return this.cachedSettings;
    }
    // Keep env overrides out of the cache so toggles remain request-local and
    // tests do not inherit a transient process.env value for the next 5 seconds.
    this.cachedSettings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, false);
    this.cachedSettingsAt = now;
    this.cachedSettingsSaveCount = saveCount;
    return this.cachedSettings;
  }

  /**
   * "Include last message", env first like every setting (applyEnvOverrides):
   * the hook and the renderer both read it that way, so a file-only read here
   * missed an env-only setting and the asking session was not excluded.
   */
  private showLastMessageEnabled(): boolean {
    return (process.env.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE
      ?? this.getCachedSettings().CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE) === 'true';
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
    app.post('/api/mem-search', this.handleProgressiveSearch.bind(this));
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
    const result = await this.searchManager.search(this.searchArgsFromRequest(req), searchTelemetry);
    res.json(result);
  });

  private handleProgressiveSearch = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    this.progressiveSearch ??= new ProgressiveMemorySearch(this.searchManager, this.searchManager.getSessionStore());
    const { searchScope, projects, ...input } = req.body ?? {};
    const scope = typeof searchScope === 'string' ? `worker/${searchScope}` : 'worker/global';
    try {
      res.json(progressiveSearchToolResult(await this.progressiveSearch.run(input as ProgressiveSearchInput, scope, projects)));
    } catch (error) {
      res.json(progressiveSearchToolError(error));
    }
  });

  private handleUnifiedTimeline = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.timeline(this.searchArgsFromRequest(req));
    res.json(result);
  });

  private handleSearchObservations = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.searchObservations(this.searchArgsFromRequest(req));
    res.json(result);
  });

  private handleSearchByFile = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const orchestrator = this.searchManager.getOrchestrator();
    const formatter = this.searchManager.getFormatter();
    const query = this.searchArgsFromRequest(req);
    const rawFilePath = query.filePath ?? query.files;
    const filePath = Array.isArray(rawFilePath)
      ? rawFilePath[0]
      : (query.filePath === undefined && typeof rawFilePath === 'string' && rawFilePath.includes(','))
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
    const resultsByDate = groupByDate(combined, item => item.created_at, { order: 'desc' });

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
    const result = await this.searchManager.getRecentContext(this.searchArgsFromRequest(req));
    res.json(result);
  });

  private handleContextPreview = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const projectName = req.query.project as string;
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);

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
        projects: [projectName],
        ...(platformSource ? { platformSource } : {})
      },
      true  
    );

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(contextText);
  });

  private handleContextInject = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    let projectsParam = (req.query.projects as string) || (req.query.project as string);
    const hostCwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
    // "Include last message" picks the prior session's reply by excluding the
    // session that asks, so only then is its id used, and that answer stays live.
    const showLastMessage = this.showLastMessageEnabled();
    const hostSessionId = showLastMessage && typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    // An excluded checkout receives no context, whether the host names its
    // projects itself (a DSH project override) or leaves them to the worker.
    if (hostCwd.trim()) {
      const excludedProjects = process.env.CLAUDE_MEM_EXCLUDED_PROJECTS
        ?? this.getCachedSettings().CLAUDE_MEM_EXCLUDED_PROJECTS;
      if (isProjectExcluded(hostCwd, excludedProjects)) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send('');
        return;
      }
    }
    // A host that cannot run the project resolver itself (the OMP hook) sends
    // its cwd instead: read the keys the CLI context hook sends for that checkout.
    if (!projectsParam && hostCwd.trim()) {
      projectsParam = getProjectContext(hostCwd).allProjects.join(',');
    }
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

    const injectStartedAt = Date.now();
    // Local-first: render from the local db now, never wait on the network.
    // The pull is only a nudge (wakes a suspended sync loop, catches up for the
    // next session); ops it applies invalidate the cached files as usual.
    if (this.syncClient && !this.syncClient.isSocketLive()) {
      void this.syncClient.pullOnce();
    }
    // A delete that lands while this renders must not see its row written back to the cache.
    const removalGenerationAtRenderStart = this.contextCache?.removalGenerationNow();
    let rendered: ContextInjectRender;
    try {
      rendered = await this.renderContextInjectBody({ projects, platformSource, forHuman, full, cwd: hostCwd || undefined, sessionId: hostSessionId, includePriorMessage: showLastMessage });
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
    if (rendered.stats) {
      const settingsSnapshot = this.getCachedSettings();
      // Hook-level → null key, time-window rollup (see error branch above).
      telemetryBuffer.record('context_injected', null, {
        outcome: 'ok',
        duration_ms: Date.now() - injectStartedAt,
        mode: settingsSnapshot.CLAUDE_MEM_MODE,
        provider: settingsSnapshot.CLAUDE_MEM_PROVIDER,
        ...rendered.stats,
      });
    }

    // Precomputed SessionStart context (liveness plan, Phase 6): this render is
    // what the hook reads from disk next time, and the variant is kept fresh
    // from here on. `full` is a one-off human request and is never cached. An
    // answer with the prior reply is not persisted either, since the reply was
    // chosen for this session: its variant is warmed instead, without a reply.
    const respondedAtEpochMs = Date.now();
    if (!full && this.contextCache) {
      const keys = contextCacheKeys(projects, platformSource, forHuman, hostCwd || undefined);
      if (showLastMessage) {
        this.contextCache.warmVariant(keys);
      } else {
        this.contextCache.recordLiveRender(
          keys,
          { body: rendered.body, cacheable: rendered.cacheable },
          respondedAtEpochMs,
          removalGenerationAtRenderStart,
        );
      }
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(fillContextPlaceholders(rendered.body, respondedAtEpochMs));
  });

  /**
   * Re-render one cached variant (ContextCacheService). Same body the live
   * route sends with "Include last message" off, before its placeholders are
   * filled: any session may read it, so it never carries a prior reply.
   */
  async renderContextVariant(keys: ContextCacheKeys): Promise<ContextVariantRender> {
    const rendered = await this.renderContextInjectBody({
      projects: keys.projects,
      cwd: keys.cwd,
      platformSource: keys.platformSource === ALL_PLATFORM_SOURCES_CACHE_KEY ? undefined : keys.platformSource,
      forHuman: keys.colors,
      full: false,
      includePriorMessage: false,
    });
    return { body: rendered.body, cacheable: rendered.cacheable };
  }

  /**
   * The SessionStart block for one request, with its wall-clock parts left as
   * placeholders (shared/context-cache.ts): the live route fills them on send,
   * the hook fills them when it reads the cached copy.
   */
  private async renderContextInjectBody(request: {
    projects: string[];
    platformSource: string | undefined;
    forHuman: boolean;
    full: boolean;
    cwd?: string;
    /** The asking host session, excluded when the prior reply is chosen. */
    sessionId?: string;
    /** "Include last message" for this render; false for any block that may be cached. */
    includePriorMessage: boolean;
  }): Promise<ContextInjectRender> {
    const { projects, platformSource, forHuman, full } = request;
    // Health banners change with time, and a prior reply is chosen for the
    // session that asked: a block that may carry either is served live only.
    const cacheable = !request.includePriorMessage && observerHealthWarning(false) === '';

    // The agent's open to-do lists and working state lead every answer this
    // route gives a session, the welcome hint included; memory is fitted to
    // what that leaves of the 10K delivery limit. The terminal preview is for
    // the human and goes without it.
    const workStateSection = forHuman
      ? ''
      : buildWorkStateContextSection(this.searchManager.getSessionStore().getWorkStateEntries(projects), 'placeholders');
    const withWorkState = (text: string): string =>
      workStateSection && text ? `${workStateSection}\n\n${text}` : workStateSection || text;

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
        const viewerUrl = getViewerBaseUrl(port);
        const hintBody = WELCOME_HINT_TEMPLATE
          .replace('{viewer_url}', viewerUrl)
          .replace('{pro_trial_line}', proTrialLine('welcome-hint'));
        // A project with zero observations is exactly where a failing observer
        // hides: without this the health warning (applied inside
        // generateContextWithStats) never reached the user this early-return serves.
        return { body: withWorkState(withObserverHealthWarning(hintBody, forHuman)), stats: null, cacheable };
      }
    }

    const { generateContextWithStats } = await import('../../../context-generator.js');

    // Session-start sync freshness lives in handleContextInject (the live
    // path); a cached re-render needs none: ContextCacheService only keeps
    // files servable while Realtime delivers ops as they happen.
    const primaryProject = projects[projects.length - 1];
    const cwd = request.cwd ?? `/context/${primaryProject}`;

    const contextResult = await generateContextWithStats({
      session_id: request.sessionId ?? 'context-inject-' + Date.now(),
      cwd: cwd,
      projects: projects,
      ...(platformSource ? { platformSource } : {}),
      full,
      reserveChars: workStateSection ? workStateSection.length + 2 : 0,
      timePlaceholders: true,
      includePriorMessage: request.includePriorMessage,
    }, forHuman);
    return { body: withWorkState(contextResult.text), stats: contextResult.stats, cacheable };
  }

  private handleSemanticContext = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const query = SearchRoutes.firstString(req.body?.q) ?? SearchRoutes.firstString(req.query.q) ?? '';
    const project = SearchRoutes.firstString(req.body?.project) ?? SearchRoutes.firstString(req.query.project);
    const projects = SearchRoutes.parseProjectsParam(req.body?.projects ?? req.query.projects);
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
        ...(projects.length > 0 ? { projects } : {}),
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

  /**
   * A search route's arguments: the query string, with the platform source
   * (from the query or a header) and `projects` parsed into a list.
   */
  private searchArgsFromRequest(req: Request): Record<string, any> {
    const searchArgs: Record<string, any> = { ...(req.query as Record<string, any>) };
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);
    if (platformSource) {
      searchArgs.platformSource = platformSource;
    }
    const projects = SearchRoutes.parseProjectsParam(searchArgs.projects);
    if (projects.length > 0) {
      searchArgs.projects = projects;
    } else {
      delete searchArgs.projects;
    }
    return searchArgs;
  }

  /**
   * The project keys a search's `projects` parameter names (gate P2-5): a
   * list, or comma-separated, as a query string sends it (`projects=a,b`, or
   * the key repeated). Parsed once, here, so every search strategy receives a
   * list. Any other shape is rejected instead of searching every project.
   */
  private static parseProjectsParam(value: unknown): string[] {
    if (value === undefined) {
      return [];
    }
    const entries: unknown[] = Array.isArray(value) ? value : [value];
    if (!entries.every((entry): entry is string => typeof entry === 'string')) {
      throw new AppError(
        'projects must be a project key, a comma-separated list of keys, or a list of keys',
        400,
        'INVALID_PROJECTS'
      );
    }
    return scopedProjects({ projects: entries.flatMap(entry => entry.split(',')) });
  }

  private handleOnboardingExplainer = this.wrapHandler((_req: Request, res: Response): void => {
    const cachedOnboardingExplainer = getOnboardingExplainer();
    if (cachedOnboardingExplainer === null) {
      res.status(404).json({ error: 'Onboarding explainer not available' });
      return;
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(cachedOnboardingExplainer);
  });

  private handleGetTimelineByQuery = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const result = await this.searchManager.getTimelineByQuery(this.searchArgsFromRequest(req));
    res.json(result);
  });
}
