
import express, { Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import { readFileSync, statSync, existsSync } from 'fs';
import { logger } from '../../../../utils/logger.js';
import { getPackageRoot, paths } from '../../../../shared/paths.js';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import { PaginationHelper } from '../../PaginationHelper.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import type { WorkerService } from '../../../worker-service.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { normalizePlatformSource } from '../../../../shared/platform-source.js';
import { getObservationsByFilePath } from '../../../sqlite/observations/get.js';
import { getFirstObservationCreatedAt } from '../../../sqlite/observations/recent.js';
import { recordRetrieved } from '../../../reinforcement/persist.js';
import { getFactsByIds, recordFactsRetrieved } from '../../../sqlite/facts/store.js';
import { getFactProvenance, getFactsAt, parseTemporalTs } from '../../../sqlite/facts/audit.js';
import { consolidationEnabled, runConsolidation } from '../../../reinforcement/consolidation-judge.js';
import {
  readRetentionPolicy, runRetentionSweep, observationChromaDocIds,
} from '../../../reinforcement/retention.js';
import { eraseFactCascade, observationErasureChain } from '../../../reinforcement/erasure.js';
import { getUptimeSeconds } from '../../../../shared/uptime.js';
import { assertCanonicalDecimal, type ContentKind } from '../../../sync/CanonicalContent.js';

const integerArrayLike = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON, fall through to comma split
    }
    return value.split(',').map((part) => Number(part.trim()));
  }
  return value;
}, z.array(z.number().int()));

const stringArrayLike = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON, fall through to comma split
    }
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  }
  return value;
}, z.array(z.string()));

const observationsBatchSchema = z.object({
  ids: integerArrayLike,
  orderBy: z.enum(['date_desc', 'date_asc']).optional(),
  limit: z.number().int().positive().optional(),
  project: z.string().optional(),
  platformSource: z.string().optional(),
  platform_source: z.string().optional(),
}).passthrough();

const sdkSessionsBatchSchema = z.object({
  memorySessionIds: stringArrayLike,
}).passthrough();

const factsBatchSchema = z.object({
  ids: integerArrayLike,
  project: z.string().optional(),
}).passthrough();

const factsConsolidateSchema = z.object({
  project: z.string().min(1),
  force: z.boolean().optional(),
}).passthrough();

// Empty body is valid — dryRun defaults to true (report-only).
const retentionSweepSchema = z.object({
  dryRun: z.boolean().optional(),
}).passthrough().default({});

const importSchema = z.object({
  sessions: z.array(z.unknown()).optional(),
  summaries: z.array(z.unknown()).optional(),
  observations: z.array(z.unknown()).optional(),
  prompts: z.array(z.unknown()).optional(),
}).passthrough();

export class DataRoutes extends BaseRouteHandler {
  constructor(
    private paginationHelper: PaginationHelper,
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager,
    private sseBroadcaster: SSEBroadcaster,
    private workerService: WorkerService,
    private startTime: number
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/observations', this.handleGetObservations.bind(this));
    app.get('/api/summaries', this.handleGetSummaries.bind(this));
    app.get('/api/prompts', this.handleGetPrompts.bind(this));

    app.get('/api/observation/:id', this.handleGetObservationById.bind(this));
    app.get('/api/observations/by-file', this.handleGetObservationsByFile.bind(this));
    app.post('/api/observations/batch', validateBody(observationsBatchSchema), this.handleGetObservationsByIds.bind(this));
    app.get('/api/facts', this.handleGetFacts.bind(this));
    app.get('/api/facts/at', this.handleGetFactsAt.bind(this));
    app.get('/api/facts/:id/provenance', this.handleGetFactProvenance.bind(this));
    app.post('/api/facts/batch', validateBody(factsBatchSchema), this.handleGetFactsByIds.bind(this));
    app.post('/api/facts/consolidate', validateBody(factsConsolidateSchema), this.handleConsolidateFacts.bind(this));
    app.post('/api/maintenance/retention-sweep', validateBody(retentionSweepSchema), this.handleRetentionSweep.bind(this));
    app.get('/api/session/:id', this.handleGetSessionById.bind(this));
    app.post('/api/sdk-sessions/batch', validateBody(sdkSessionsBatchSchema), this.handleGetSdkSessionsByIds.bind(this));
    app.get('/api/prompt/:id', this.handleGetPromptById.bind(this));
    app.delete('/api/observation/:id', this.handleDeleteObservation.bind(this));
    app.delete('/api/facts/:id', this.handleDeleteFact.bind(this));
    app.delete('/api/summary/:id', this.handleDeleteSummary.bind(this));
    app.delete('/api/prompt/:id', this.handleDeletePrompt.bind(this));

    app.get('/api/stats', this.handleGetStats.bind(this));
    app.get('/api/projects', this.handleGetProjects.bind(this));

    app.get('/api/processing-status', this.handleGetProcessingStatus.bind(this));

    app.post('/api/import', validateBody(importSchema), this.handleImport.bind(this));
  }

  private handleGetObservations = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getObservations(offset, limit, project, platformSource);
    res.json(result);
  });

  private handleGetSummaries = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getSummaries(offset, limit, project, platformSource);
    res.json(result);
  });

  private handleGetPrompts = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getPrompts(offset, limit, project, platformSource);
    res.json(result);
  });

  private handleGetObservationById = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);
    const observation = store.getObservationById(id, platformSource);

    if (!observation) {
      this.notFound(res, `Observation #${id} not found`);
      return;
    }

    res.json(observation);
  });

  private handleGetObservationsByFile = this.wrapHandler((req: Request, res: Response): void => {
    // #2691 — `path` may be repeated (?path=abs&path=rel) to carry multiple
    // candidate forms (absolute, project-root-relative, cwd-relative) so the
    // query matches however PostToolUse stored the path. Paths can contain
    // commas, so we rely on repeated query params rather than comma-splitting.
    const rawPath = req.query.path;
    const candidatePaths = (Array.isArray(rawPath) ? rawPath : [rawPath])
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (candidatePaths.length === 0) {
      this.badRequest(res, 'path query parameter is required');
      return;
    }

    const projectsParam = req.query.projects as string | undefined;
    const projects = projectsParam ? projectsParam.split(',').filter(Boolean) : undefined;
    const parsedLimit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const limit = Number.isFinite(parsedLimit) && parsedLimit! > 0 ? parsedLimit : undefined;
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);

    const db = this.dbManager.getSessionStore().db;
    const observations = getObservationsByFilePath(db, candidatePaths, { projects, limit, platformSource });

    res.json({ observations, count: observations.length });
  });

  private handleGetObservationsByIds = this.wrapHandler((req: Request, res: Response): void => {
    const { ids, orderBy, limit, project } = req.body as z.infer<typeof observationsBatchSchema>;

    if (ids.length === 0) {
      res.json([]);
      return;
    }

    const store = this.dbManager.getSessionStore();
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);
    const observations = store.getObservationsByIds(ids, { orderBy, limit, project, platformSource });

    // ACT-R retrieval practice: the agent actively recalled these memories, so
    // their traces get a real reinforcement date (same-day idempotent — a chatty
    // agent can't inflate a note by re-fetching it). Best-effort: a missed
    // reinforcement costs a little ranking accuracy, never a response.
    try {
      recordRetrieved(store.db, observations.map(o => o.id));
    } catch (error) {
      logger.debug('DB', 'Retrieval reinforcement skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    res.json(observations);
  });

  /**
   * Semantic memory layer — compact listing of active facts for the MCP
   * `facts` tool (~30 tokens/line). Optional `query` runs the facts FTS
   * index; `kind` filters by fact kind. MCP-shaped response, like /api/search.
   */
  private handleGetFacts = this.wrapHandler((req: Request, res: Response): void => {
    const project = DataRoutes.firstString(req.query.project);
    const query = DataRoutes.firstString(req.query.query) ?? DataRoutes.firstString(req.query.q);
    const kind = DataRoutes.firstString(req.query.kind);
    const parsedLimit = parseInt(DataRoutes.firstString(req.query.limit) ?? '', 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 50;

    const search = this.dbManager.getSessionSearch();
    const facts = search.searchFacts(query, { project, kind, limit });

    const lines: string[] = [];
    lines.push(facts.length > 0 ? `${facts.length} active fact(s)` : 'No active facts');
    lines.push('');
    for (const fact of facts) {
      lines.push(`#${fact.id} [${fact.kind}] ${fact.fact}`);
    }

    res.json({
      content: [{
        type: 'text' as const,
        text: lines.join('\n')
      }]
    });
  });

  /**
   * Semantic memory layer — full fact rows by id for the MCP `get_facts`
   * tool. Retrieval practice: actively recalling a fact appends a real
   * reinforcement date (same-day idempotent), mirroring
   * /api/observations/batch. Best-effort: a missed reinforcement costs a
   * little ranking accuracy, never a response.
   */
  private handleGetFactsByIds = this.wrapHandler((req: Request, res: Response): void => {
    const { ids, project } = req.body as z.infer<typeof factsBatchSchema>;

    if (ids.length === 0) {
      res.json([]);
      return;
    }

    const store = this.dbManager.getSessionStore();
    let facts = getFactsByIds(store.db, ids);
    if (project) {
      facts = facts.filter(f => f.project === project);
    }

    try {
      recordFactsRetrieved(store.db, facts.map(f => f.id));
    } catch (error) {
      logger.debug('DB', 'Fact retrieval reinforcement skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    res.json(facts);
  });

  /**
   * Provenance audit (audit G6) — "where did this belief come from": the fact
   * row, its source observations (stale-flagged when superseded), the
   * supersession chain up to the active head, and the rows it replaced.
   * Read-only.
   */
  private handleGetFactProvenance = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const report = getFactProvenance(store.db, id);
    if (!report) {
      this.notFound(res, `fact #${id} not found`);
      return;
    }

    res.json(report);
  });

  /**
   * Temporal belief query (audit G6) — facts that were true at `ts` (epoch ms
   * or ISO 8601), including rows superseded or invalidated since ("what did
   * we believe then"). Each row carries its status as of today. Read-only.
   */
  private handleGetFactsAt = this.wrapHandler((req: Request, res: Response): void => {
    const project = DataRoutes.firstString(req.query.project);
    if (!project) {
      this.badRequest(res, 'project query parameter is required');
      return;
    }

    const ts = parseTemporalTs(DataRoutes.firstString(req.query.ts));
    if (ts === null) {
      this.badRequest(res, 'ts query parameter is required and must be epoch ms or an ISO 8601 date');
      return;
    }

    const includeActive = DataRoutes.firstString(req.query.includeActive) !== 'false';
    const parsedLimit = parseInt(DataRoutes.firstString(req.query.limit) ?? '', 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;

    const store = this.dbManager.getSessionStore();
    const facts = getFactsAt(store.db, project, ts, { includeActive, limit });

    res.json({
      project,
      ts,
      date: new Date(ts).toISOString(),
      count: facts.length,
      facts,
    });
  });

  /**
   * Semantic memory layer — manual consolidation trigger for a project.
   * Throttled unless `force` is set; still master-gated by
   * CLAUDE_MEM_CONSOLIDATION_ENABLED. Never throws: a failed pass reports as
   * a NOOP summary.
   */
  private handleConsolidateFacts = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { project, force } = req.body as z.infer<typeof factsConsolidateSchema>;

    if (!consolidationEnabled()) {
      res.json({ ran: false, reason: 'CLAUDE_MEM_CONSOLIDATION_ENABLED is not true', added: 0, updated: 0, deleted: 0, noop: false, rejected: [] });
      return;
    }

    const store = this.dbManager.getSessionStore();
    const summary = await runConsolidation(store.db, project, undefined, new Date(), { force: force === true });
    res.json(summary);
  });

  /**
   * Retention sweep (audit G2) — explicit age/strength-threshold deletion of
   * stale observations into the deleted_observations audit table. Dry-run by
   * default: `{"dryRun":true}` (or an empty body) only reports candidates.
   * Apply is gated on CLAUDE_MEM_RETENTION_ENABLED=true. Never runs on a
   * timer — explicit invocation only.
   */
  private handleRetentionSweep = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { dryRun } = req.body as z.infer<typeof retentionSweepSchema>;
    const apply = dryRun !== true;
    const policy = readRetentionPolicy();

    if (apply && !policy.enabled) {
      res.status(403).json({
        error: 'retention sweep is disabled — set CLAUDE_MEM_RETENTION_ENABLED=true to apply (dry-run is always allowed)',
      });
      return;
    }

    const store = this.dbManager.getSessionStore();
    const result = runRetentionSweep(store.db, policy, { dryRun: !apply });

    // Chroma tombstone, fail-soft: SQLite's audit table is the source of
    // truth, orphaned vectors reconcile on the next full reindex.
    let chromaRemoved = 0;
    const chromaSync = this.dbManager.getChromaSync();
    if (apply && chromaSync && result.snapshots.length > 0) {
      const docIds = result.snapshots.flatMap(observationChromaDocIds);
      try {
        chromaRemoved = await chromaSync.removeDocuments(docIds);
      } catch (error) {
        logger.warn('RETENTION', 'Chroma tombstone after retention sweep failed', {
          batchId: result.batchId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    res.json({
      dryRun: result.dryRun,
      policy: result.policy,
      scanned: result.scanned,
      candidates: result.candidates,
      deleted: result.deleted,
      batchId: result.batchId,
      chromaRemoved,
    });
  });

  private handleGetSessionById = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);
    const project = DataRoutes.firstString(req.query.project);
    const sessions = store.getSessionSummariesByIds([id], { project, platformSource });

    if (sessions.length === 0) {
      this.notFound(res, `Session #${id} not found`);
      return;
    }

    res.json(sessions[0]);
  });

  private handleGetSdkSessionsByIds = this.wrapHandler((req: Request, res: Response): void => {
    const { memorySessionIds } = req.body as z.infer<typeof sdkSessionsBatchSchema>;

    const store = this.dbManager.getSessionStore();
    const sessions = store.getSdkSessionsBySessionIds(memorySessionIds);
    res.json(sessions);
  });

  private handleGetPromptById = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);
    const project = DataRoutes.firstString(req.query.project);
    const prompts = store.getUserPromptsByIds([id], { project, platformSource });

    if (prompts.length === 0) {
      this.notFound(res, `Prompt #${id} not found`);
      return;
    }

    res.json(prompts[0]);
  });

  private handleDeleteObservation = this.wrapHandler((req: Request, res: Response): void => {
    this.deleteSyncedContent(req, res, 'observation', 'observations');
  });

  /**
   * Hard delete of a semantic fact (audit G5) — cascades to the rows
   * tombstoned BY it (recursive superseded_by chain). Facts are not
   * cloud-synced, so unlike deleteSyncedContent this is a plain local
   * delete; the semantic_facts_ad FTS trigger cleans the index.
   */
  private handleDeleteFact = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const result = eraseFactCascade(store.db, id);
    if (result.deletedIds.length === 0) {
      this.notFound(res, `fact #${id} not found`);
      return;
    }

    res.json({ success: true, id, kind: 'fact', cascaded: result.cascaded });
  });

  private handleDeleteSummary = this.wrapHandler((req: Request, res: Response): void => {
    this.deleteSyncedContent(req, res, 'summary', 'session_summaries');
  });

  private handleDeletePrompt = this.wrapHandler((req: Request, res: Response): void => {
    this.deleteSyncedContent(req, res, 'prompt', 'user_prompts');
  });

  /** Production deletion surface: tombstone enqueue and row delete are one transaction. */
  private deleteSyncedContent(
    req: Request,
    res: Response,
    kind: ContentKind,
    table: 'observations' | 'session_summaries' | 'user_prompts',
  ): void {
    let originLocalId: string;
    try {
      originLocalId = assertCanonicalDecimal(req.params.id, { positive: true });
    } catch {
      this.badRequest(res, 'id must be a positive canonical decimal string');
      return;
    }

    const store = this.dbManager.getSessionStore();
    const row = store.db.prepare(`
      SELECT CAST(id AS TEXT) AS id FROM ${table}
      WHERE id = ? AND origin_device_id IS NULL
    `).get(originLocalId) as { id: string } | undefined;
    if (!row) {
      this.notFound(res, `${kind} #${originLocalId} not found`);
      return;
    }

    // Erasure cascade (audit G5): a hard delete of an observation also removes
    // the rows tombstoned BY it (recursive superseded_by chain) — otherwise
    // the "erased" content survives in the DB as a marked row.
    const chain = kind === 'observation'
      ? observationErasureChain(store.db, Number(originLocalId))
      : [Number(originLocalId)];

    const cloudSync = this.dbManager.getCloudSync();
    let entityRev: string | null = null;
    if (cloudSync?.isConfigured()) {
      if (!cloudSync.status().deviceId) {
        res.status(503).json({ error: 'cloud sync identity unavailable; refusing an unreplicated delete' });
        return;
      }
      for (const chainId of chain) {
        const rev = cloudSync.queueDelete(kind, String(chainId));
        if (chainId === chain[0]) entityRev = rev;
      }
    } else {
      // A row with an acknowledged entity head must never be silently deleted
      // while its sync identity is unavailable: that would strand replicas.
      const placeholders = chain.map(() => '?').join(',');
      const acknowledged = store.db.prepare(`
        SELECT 1 AS found FROM sync_entity_heads
        WHERE kind = ? AND origin_local_id IN (${placeholders}) LIMIT 1
      `).get(kind, ...chain.map(String)) as { found: number } | undefined;
      if (acknowledged) {
        res.status(503).json({ error: 'cloud sync unavailable; refusing an unreplicated delete' });
        return;
      }
      store.db.prepare(
        `DELETE FROM ${table} WHERE id IN (${placeholders}) AND origin_device_id IS NULL`
      ).run(...chain);
    }

    const cascaded = chain.length - 1;
    if (cascaded > 0) {
      logger.info('ERASURE', `Delete of ${kind} #${originLocalId} cascaded to ${cascaded} tombstone(s)`, {
        chain,
      });
    }

    res.json({ success: true, id: originLocalId, kind, entity_rev: entityRev, cascaded });
  }

  private handleGetStats = this.wrapHandler((req: Request, res: Response): void => {
    const db = this.dbManager.getSessionStore().db;

    const packageRoot = getPackageRoot();
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version;

    const totalObservations = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
    const totalSessions = db.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get() as { count: number };
    const totalSummaries = db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };
    const firstObservationAt = getFirstObservationCreatedAt(db);

    const dbPath = paths.database();
    let dbSize = 0;
    if (existsSync(dbPath)) {
      dbSize = statSync(dbPath).size;
    }

    const uptime = getUptimeSeconds(this.startTime);
    const activeSessions = this.sessionManager.getActiveSessionCount();
    const sseClients = this.sseBroadcaster.getClientCount();

    res.json({
      worker: {
        version,
        uptime,
        activeSessions,
        sseClients,
        port: getWorkerPort()
      },
      database: {
        path: dbPath,
        size: dbSize,
        observations: totalObservations.count,
        sessions: totalSessions.count,
        summaries: totalSummaries.count,
        firstObservationAt
      }
    });
  });

  private handleGetProjects = this.wrapHandler((req: Request, res: Response): void => {
    const store = this.dbManager.getSessionStore();
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);

    if (platformSource) {
      const projects = store.getAllProjects(platformSource);
      res.json({
        projects,
        sources: [platformSource],
        projectsBySource: { [platformSource]: projects }
      });
      return;
    }

    res.json(store.getProjectCatalog());
  });

  private handleGetProcessingStatus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const isProcessing = await this.sessionManager.isAnySessionProcessing();
    const queueDepth = await this.sessionManager.getTotalActiveWork(); 
    res.json({ isProcessing, queueDepth });
  });

  private parsePaginationParams(req: Request): { offset: number; limit: number; project?: string; platformSource?: string } {
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100); 
    const project = req.query.project as string | undefined;
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);

    return { offset, limit, project, platformSource };
  }

  private handleImport = this.wrapHandler((req: Request, res: Response): void => {
    const { sessions, summaries, observations, prompts } = req.body;

    const stats = {
      sessionsImported: 0,
      sessionsSkipped: 0,
      summariesImported: 0,
      summariesSkipped: 0,
      observationsImported: 0,
      observationsSkipped: 0,
      promptsImported: 0,
      promptsSkipped: 0
    };

    const store = this.dbManager.getSessionStore();
    const sessionContextByKey = new Map<string, { id: number; platformSource: string }>();
    const sessionContextsByContentId = new Map<string, Array<{ id: number; platformSource: string }>>();
    const sessionContextKey = (platformSource: string, contentSessionId: string): string =>
      `${platformSource}\0${contentSessionId}`;
    const rememberSessionContext = (session: any, id: number): void => {
      if (!session || typeof session !== 'object' || typeof session.content_session_id !== 'string') {
        return;
      }
      const platformSource = normalizePlatformSource(session.platform_source);
      const context = { id, platformSource };
      sessionContextByKey.set(sessionContextKey(platformSource, session.content_session_id), context);
      const existing = sessionContextsByContentId.get(session.content_session_id) ?? [];
      existing.push(context);
      sessionContextsByContentId.set(session.content_session_id, existing);
    };

    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        const result = store.importSdkSession(session);
        rememberSessionContext(session, result.id);
        if (result.imported) {
          stats.sessionsImported++;
        } else {
          stats.sessionsSkipped++;
        }
      }
    }

    if (Array.isArray(summaries)) {
      for (const summary of summaries) {
        const result = store.importSessionSummary(summary);
        if (result.imported) {
          stats.summariesImported++;
        } else {
          stats.summariesSkipped++;
        }
      }
    }

    const importedObservations: Array<{ id: number; obs: typeof observations[0] }> = [];
    if (Array.isArray(observations)) {
      for (const obs of observations) {
        const result = store.importObservation(obs);
        if (result.imported) {
          stats.observationsImported++;
          importedObservations.push({ id: result.id, obs });
        } else {
          stats.observationsSkipped++;
        }
      }

      if (stats.observationsImported > 0) {
        store.rebuildObservationsFTSIndex();
      }

      const chromaSync = this.dbManager.getChromaSync();
      if (chromaSync && importedObservations.length > 0) {
        const CHROMA_SYNC_CONCURRENCY = 8;
        const safeParseJson = (val: string | null): string[] => {
          if (!val) return [];
          try { return JSON.parse(val); } catch { return []; }
        };

        const syncOne = async ({ id, obs }: { id: number; obs: any }) => {
          const sourceRow = store.db.prepare(`
            SELECT COALESCE(NULLIF(platform_source, ''), 'claude') as platform_source
            FROM sdk_sessions
            WHERE memory_session_id = ?
            LIMIT 1
          `).get(obs.memory_session_id) as { platform_source?: string } | undefined;
          const platformSource = typeof obs.platform_source === 'string'
            ? normalizePlatformSource(obs.platform_source)
            : normalizePlatformSource(sourceRow?.platform_source);
          const parsedObs = {
            type: obs.type || 'discovery',
            title: obs.title || null,
            subtitle: obs.subtitle || null,
            facts: safeParseJson(obs.facts),
            narrative: obs.narrative || null,
            concepts: safeParseJson(obs.concepts),
            files_read: safeParseJson(obs.files_read),
            files_modified: safeParseJson(obs.files_modified),
          };

          await chromaSync.syncObservation(
            id,
            obs.memory_session_id,
            obs.project,
            parsedObs,
            obs.prompt_number || 0,
            obs.created_at_epoch,
            platformSource
          ).catch(err => {
            logger.error('CHROMA', 'Import ChromaDB sync failed', { id }, err as Error);
          });
        };

        (async () => {
          for (let i = 0; i < importedObservations.length; i += CHROMA_SYNC_CONCURRENCY) {
            const batch = importedObservations.slice(i, i + CHROMA_SYNC_CONCURRENCY);
            await Promise.all(batch.map(syncOne));
          }
        })().catch(err => {
          logger.error('CHROMA', 'Import ChromaDB batch sync failed', {}, err as Error);
        });
      }
    }

    if (Array.isArray(prompts)) {
      for (const prompt of prompts) {
        let promptToImport = prompt;
        if (prompt && typeof prompt === 'object' && !Array.isArray(prompt)) {
          const promptRecord = prompt as Record<string, unknown>;
          const contentSessionId = typeof promptRecord.content_session_id === 'string'
            ? promptRecord.content_session_id
            : undefined;
          const explicitPlatformSource = typeof promptRecord.platform_source === 'string'
            ? normalizePlatformSource(promptRecord.platform_source)
            : undefined;

          if (contentSessionId) {
            let sessionContext: { id: number; platformSource: string } | undefined;
            if (explicitPlatformSource) {
              sessionContext = sessionContextByKey.get(sessionContextKey(explicitPlatformSource, contentSessionId));
            } else {
              const candidates = sessionContextsByContentId.get(contentSessionId) ?? [];
              sessionContext = candidates.length === 1 ? candidates[0] : undefined;
            }

            if (sessionContext) {
              promptToImport = {
                ...promptRecord,
                session_db_id: sessionContext.id,
                platform_source: explicitPlatformSource ?? sessionContext.platformSource,
              };
            } else if (explicitPlatformSource) {
              promptToImport = {
                ...promptRecord,
                platform_source: explicitPlatformSource,
              };
            }
          }
        }

        const result = store.importUserPrompt(promptToImport as any);
        if (result.imported) {
          stats.promptsImported++;
        } else {
          stats.promptsSkipped++;
        }
      }
    }

    res.json({
      success: true,
      stats
    });
  });

}
