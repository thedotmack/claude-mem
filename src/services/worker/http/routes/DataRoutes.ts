
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
import { requireLocalhost } from '../middleware.js';
import { isForeignLoopbackBrowserWrite } from './SettingsRoutes.js';
import { mergeProjectInto } from '../../../infrastructure/ProjectMerge.js';
import { normalizePlatformSource } from '../../../../shared/platform-source.js';
import { getObservationsByFilePath } from '../../../sqlite/observations/get.js';
import { getFirstObservationCreatedAt } from '../../../sqlite/observations/recent.js';
import { getParkedSlotWaiterCount } from '../../../../supervisor/process-registry.js';
import { getUptimeSeconds } from '../../../../shared/uptime.js';
import { assertCanonicalDecimal, type ContentKind } from '../../../sync/CanonicalContent.js';
import type { CloudSync } from '../../../sync/CloudSync.js';
import { emitContextInvalidation } from '../../../../shared/context-invalidation.js';

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

// Layer 4 of progressive disclosure: raw tool bodies, by explicit id only.
// `ids` accepts numeric tool_uses.id AND opaque tool_use_id strings, because a
// caller may hold either (search/list hands back the former, a transcript or an
// observation ref the latter). Required and non-empty on purpose — this route
// must never be a way to page the whole table of raw payloads.
const toolUsesBatchSchema = z.object({
  ids: z.preprocess((value) => {
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
  }, z.array(z.union([z.number().int(), z.string()]))),
  limit: z.number().int().positive().max(200).optional(),
  project: z.string().optional(),
  contentSessionId: z.string().optional(),
  platformSource: z.string().optional(),
  platform_source: z.string().optional(),
}).passthrough();

// The cloud/export shape (CloudSync `toCloud`) carries columns that are stored
// locally as JSON strings — facts, concepts, files_read/modified — as real
// arrays. Re-stringify them at the boundary so every downstream consumer
// (the SQLite binding layer and the ChromaDB `JSON.parse` path alike) sees the
// canonical JSON-string shape rather than a raw array. Without this, the array
// crashes bun:sqlite ("Binding expected string…") and silently drops from Chroma.
const OBSERVATION_JSON_FIELDS = ['facts', 'concepts', 'files_read', 'files_modified'] as const;
const SUMMARY_JSON_FIELDS = ['files_read', 'files_edited'] as const;

const jsonStringifyFields = (fields: readonly string[]) =>
  (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    let normalized: Record<string, unknown> | undefined;
    for (const field of fields) {
      const fieldValue = record[field];
      if (fieldValue !== null && typeof fieldValue === 'object') {
        normalized ??= { ...record };
        normalized[field] = JSON.stringify(fieldValue);
      }
    }
    return normalized ?? record;
  };

const projectMergeSchema = z.object({
  from: z.string().trim().min(1),
  into: z.string().trim().min(1),
  dryRun: z.boolean().optional(),
});

const importSchema = z.object({
  sessions: z.array(z.unknown()).optional(),
  summaries: z.array(z.preprocess(jsonStringifyFields(SUMMARY_JSON_FIELDS), z.unknown())).optional(),
  observations: z.array(z.preprocess(jsonStringifyFields(OBSERVATION_JSON_FIELDS), z.unknown())).optional(),
  prompts: z.array(z.unknown()).optional(),
}).passthrough();

// Per-row checks for /api/import: the columns each table requires (NOT NULL,
// no default), with session ids as non-empty strings. A row that fails is
// rejected with a named reason. Anything else the insert refuses (a foreign
// key to a session that is not in the database, an unbindable value) is caught
// per row in handleImport. Either way one bad row from a legacy or hand-edited
// export is reported instead of aborting the rest of the batch.
const importedSessionIdText = z.string().trim().min(1, 'expected a non-empty string');
const importedRequiredValue = z.custom<unknown>(
  (value) => value !== null && value !== undefined,
  { message: 'required' },
);
const importRowSchemas = {
  sessions: z.object({
    content_session_id: importedSessionIdText,
    project: importedRequiredValue,
    started_at: importedRequiredValue,
    started_at_epoch: importedRequiredValue,
  }).passthrough(),
  summaries: z.object({
    memory_session_id: importedSessionIdText,
    project: importedRequiredValue,
    created_at: importedRequiredValue,
    created_at_epoch: importedRequiredValue,
  }).passthrough(),
  observations: z.object({
    memory_session_id: importedSessionIdText,
    project: importedRequiredValue,
    type: importedRequiredValue,
    created_at: importedRequiredValue,
    created_at_epoch: importedRequiredValue,
  }).passthrough(),
  prompts: z.object({
    content_session_id: importedSessionIdText,
    prompt_number: importedRequiredValue,
    prompt_text: importedRequiredValue,
    created_at: importedRequiredValue,
    created_at_epoch: importedRequiredValue,
  }).passthrough(),
};

type ImportRowKind = keyof typeof importRowSchemas;

interface ImportRowRejection {
  /** Position of the row in the request's array for its kind. */
  index: number;
  reason: string;
}

function describeImportRowIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.length > 0 ? issue.path.join('.') : 'row'}: ${issue.message}`)
    .join('; ');
}

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
    app.get('/api/session/:id', this.handleGetSessionById.bind(this));
    app.post('/api/sdk-sessions/batch', validateBody(sdkSessionsBatchSchema), this.handleGetSdkSessionsByIds.bind(this));
    app.get('/api/tool-uses', this.handleListToolUses.bind(this));
    app.post('/api/tool-uses/batch', validateBody(toolUsesBatchSchema), this.handleGetToolUsesByIds.bind(this));
    app.get('/api/prompt/:id', this.handleGetPromptById.bind(this));
    app.delete('/api/observation/:id', this.handleDeleteObservation.bind(this));
    app.delete('/api/summary/:id', this.handleDeleteSummary.bind(this));
    app.delete('/api/prompt/:id', this.handleDeletePrompt.bind(this));

    app.get('/api/stats', this.handleGetStats.bind(this));
    app.get('/api/projects', this.handleGetProjects.bind(this));
    app.post('/api/projects/merge', requireLocalhost, validateBody(projectMergeSchema), this.handleProjectMerge.bind(this));
    app.get('/api/sessions', this.handleGetSessions.bind(this));
    app.delete('/api/sessions/:platformSource/:contentSessionId', this.handleDeleteSession.bind(this));

    app.get('/api/processing-status', this.handleGetProcessingStatus.bind(this));

    app.post('/api/import', validateBody(importSchema), this.handleImport.bind(this));
  }

  private handleGetObservations = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource, contentSessionId } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getObservations(offset, limit, project, platformSource, contentSessionId);
    res.json(result);
  });

  private handleGetSummaries = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource, contentSessionId } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getSummaries(offset, limit, project, platformSource, contentSessionId);
    res.json(result);
  });

  private handleGetPrompts = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, platformSource, contentSessionId } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getPrompts(offset, limit, project, platformSource, contentSessionId);
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

    res.json(observations);
  });

  /**
   * Index/tally listing for `tool_uses` — Receipt's read path and the way a
   * caller finds ids worth disclosing. Deliberately projects a CHEAP shape:
   * identity + sizes, never `tool_input` / `tool_response`. Full bodies come
   * only from POST /api/tool-uses/batch with explicit ids.
   */
  private handleListToolUses = this.wrapHandler((req: Request, res: Response): void => {
    const store = this.dbManager.getSessionStore();
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);

    const asString = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    const asNumber = (value: unknown): number | undefined => {
      const parsed = Number(asString(value));
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    const toolName = asString(req.query.tool_name ?? req.query.toolName);

    const rows = store.queryToolUses({
      project: asString(req.query.project),
      contentSessionId: asString(req.query.session ?? req.query.contentSessionId),
      memorySessionId: asString(req.query.memorySessionId),
      toolName: toolName ? toolName.split(',').map(part => part.trim()).filter(Boolean) : undefined,
      agentId: asString(req.query.agentId),
      platformSource,
      dateStart: asNumber(req.query.dateStart),
      dateEnd: asNumber(req.query.dateEnd),
      limit: asNumber(req.query.limit),
      offset: asNumber(req.query.offset),
      orderBy: req.query.orderBy === 'date_asc' ? 'date_asc' : 'date_desc',
    });

    res.json({
      count: rows.length,
      toolUses: rows.map(row => ({
        id: row.id,
        tool_use_id: row.tool_use_id,
        tool_name: row.tool_name,
        project: row.project,
        content_session_id: row.content_session_id,
        memory_session_id: row.memory_session_id,
        platform_source: row.platform_source,
        agent_id: row.agent_id,
        agent_type: row.agent_type,
        observation_id: row.observation_id,
        or_generation_id: row.or_generation_id,
        or_session_id: row.or_session_id,
        prompt_number: row.prompt_number,
        created_at: row.created_at,
        created_at_epoch: row.created_at_epoch,
        // Size hints so a caller can budget tokens before disclosing a body.
        tool_input_bytes: row.tool_input ? Buffer.byteLength(row.tool_input, 'utf8') : 0,
        tool_response_bytes: row.tool_response ? Buffer.byteLength(row.tool_response, 'utf8') : 0,
      })),
    });
  });

  private handleGetToolUsesByIds = this.wrapHandler((req: Request, res: Response): void => {
    const { ids, limit, project, contentSessionId } = req.body as z.infer<typeof toolUsesBatchSchema>;

    if (ids.length === 0) {
      res.json([]);
      return;
    }

    const store = this.dbManager.getSessionStore();
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);
    res.json(store.getToolUsesByIds(ids, { limit, project, contentSessionId, platformSource }));
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

  private handleDeleteSummary = this.wrapHandler((req: Request, res: Response): void => {
    this.deleteSyncedContent(req, res, 'summary', 'session_summaries');
  });

  private handleDeletePrompt = this.wrapHandler((req: Request, res: Response): void => {
    this.deleteSyncedContent(req, res, 'prompt', 'user_prompts');
  });

  /** Pure safety check: can this row be deleted right now without stranding a replica? No mutation. */
  private assertRowDeletable(
    cloudSync: CloudSync | null,
    store: ReturnType<DatabaseManager['getSessionStore']>,
    kind: ContentKind,
    originLocalId: string,
  ): { ok: true } | { ok: false; status: number; error: string } {
    if (cloudSync?.isConfigured()) {
      if (!cloudSync.status().deviceId) {
        return { ok: false, status: 503, error: 'cloud sync identity unavailable; refusing an unreplicated delete' };
      }
      return { ok: true };
    }
    // A row with an acknowledged entity head must never be silently deleted
    // while its sync identity is unavailable: that would strand replicas.
    const acknowledged = store.db.prepare(`
      SELECT 1 AS found FROM sync_entity_heads
      WHERE kind = ? AND origin_local_id = ? LIMIT 1
    `).get(kind, originLocalId) as { found: number } | undefined;
    if (acknowledged) {
      return { ok: false, status: 503, error: 'cloud sync unavailable; refusing an unreplicated delete' };
    }
    return { ok: true };
  }

  /** Mutation only — caller must have already called assertRowDeletable for this row. */
  private commitRowDelete(
    cloudSync: CloudSync | null,
    store: ReturnType<DatabaseManager['getSessionStore']>,
    kind: ContentKind,
    table: 'observations' | 'session_summaries' | 'user_prompts',
    originLocalId: string,
  ): string | null {
    if (cloudSync?.isConfigured()) {
      return cloudSync.queueDelete(kind, originLocalId);
    }
    store.db.prepare(
      `DELETE FROM ${table} WHERE id = ? AND origin_device_id IS NULL`
    ).run(originLocalId);
    return null;
  }

  /** Production deletion surface: safety check and row delete for a single content row. */
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

    const cloudSync = this.dbManager.getCloudSync();
    const check = this.assertRowDeletable(cloudSync, store, kind, originLocalId);
    if (!check.ok) {
      res.status(check.status).json({ error: check.error });
      return;
    }

    const entityRev = this.commitRowDelete(cloudSync, store, kind, table, originLocalId);
    emitContextInvalidation('all', `delete-${kind}`);

    // Only after the delete committed: open viewer tabs drop the row live.
    this.sseBroadcaster.broadcast({ type: 'item_deleted', itemType: kind, id: Number(originLocalId) });
    res.json({ success: true, id: originLocalId, kind, entity_rev: entityRev });
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

  private handleGetSessions = this.wrapHandler((req: Request, res: Response): void => {
    const store = this.dbManager.getSessionStore();
    const project = BaseRouteHandler.firstString(req.query.project)?.trim() || undefined;
    const requestedLimit = Number(BaseRouteHandler.firstString(req.query.limit));
    const requestedOffset = Number(BaseRouteHandler.firstString(req.query.offset));
    // { sessions, hasMore }: the viewer pages through older sessions with offset.
    res.json(store.getSessionCatalog({
      project,
      platformSource: this.getOptionalPlatformSourceFromRequest(req),
      limit: Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : undefined,
      offset: Number.isFinite(requestedOffset) && requestedOffset > 0 ? requestedOffset : undefined,
    }));
  });

  /**
   * Delete one session and everything captured in it. A session is identified
   * by (platform_source, content_session_id): the same content id can exist
   * under two hosts. Sync-safe like the per-row deletes: every local child row
   * is tombstoned for cloud sync, and the session row is removed only after its
   * children are gone, so the FK cascade never drops a replicated row.
   */
  private handleDeleteSession = this.wrapHandler((req: Request, res: Response): void => {
    const rawPlatformSource = this.toStringParam(req.params.platformSource);
    const contentSessionId = this.toStringParam(req.params.contentSessionId);
    if (!rawPlatformSource || !contentSessionId) {
      this.badRequest(res, 'platformSource and contentSessionId are required');
      return;
    }
    const platformSource = normalizePlatformSource(rawPlatformSource);

    const store = this.dbManager.getSessionStore();
    const sessionRow = store.db.prepare(`
      SELECT id, memory_session_id
      FROM sdk_sessions
      WHERE content_session_id = ? AND COALESCE(platform_source, 'claude') = ?
    `).get(contentSessionId, platformSource) as { id: number; memory_session_id: string | null } | undefined;

    if (!sessionRow) {
      this.notFound(res, `Session ${platformSource}/${contentSessionId} not found`);
      return;
    }

    // Deleting a live session would cascade its pending work out from under
    // the running generator.
    if (this.sessionManager.getSession(sessionRow.id)) {
      res.status(409).json({ error: 'session is still active; delete it after it ends' });
      return;
    }

    // Rows synced from another device belong to that device: the FK cascade
    // would drop them here without a tombstone. Refuse instead.
    const remoteChildren = store.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM observations WHERE memory_session_id = ? AND origin_device_id IS NOT NULL)
        + (SELECT COUNT(*) FROM session_summaries WHERE memory_session_id = ? AND origin_device_id IS NOT NULL)
        + (SELECT COUNT(*) FROM user_prompts WHERE session_db_id = ? AND origin_device_id IS NOT NULL) AS n
    `).get(sessionRow.memory_session_id, sessionRow.memory_session_id, sessionRow.id) as { n: number };
    if (remoteChildren.n > 0) {
      res.status(409).json({
        error: 'session holds memories synced from another device; delete those on that device first',
        remoteItemCount: remoteChildren.n,
      });
      return;
    }

    type ChildRow = { kind: ContentKind; table: 'observations' | 'session_summaries' | 'user_prompts'; id: string };
    const childRows: ChildRow[] = [];

    if (sessionRow.memory_session_id) {
      const observations = store.db.prepare(
        `SELECT CAST(id AS TEXT) AS id FROM observations WHERE memory_session_id = ? AND origin_device_id IS NULL`
      ).all(sessionRow.memory_session_id) as Array<{ id: string }>;
      childRows.push(...observations.map(row => ({ kind: 'observation' as ContentKind, table: 'observations' as const, id: row.id })));

      const summaries = store.db.prepare(
        `SELECT CAST(id AS TEXT) AS id FROM session_summaries WHERE memory_session_id = ? AND origin_device_id IS NULL`
      ).all(sessionRow.memory_session_id) as Array<{ id: string }>;
      childRows.push(...summaries.map(row => ({ kind: 'summary' as ContentKind, table: 'session_summaries' as const, id: row.id })));
    }

    const prompts = store.db.prepare(
      `SELECT CAST(id AS TEXT) AS id FROM user_prompts WHERE session_db_id = ? AND origin_device_id IS NULL`
    ).all(sessionRow.id) as Array<{ id: string }>;
    childRows.push(...prompts.map(row => ({ kind: 'prompt' as ContentKind, table: 'user_prompts' as const, id: row.id })));

    const cloudSync = this.dbManager.getCloudSync();

    // Pre-flight: validate every row can be safely deleted BEFORE mutating any of them.
    for (const row of childRows) {
      const check = this.assertRowDeletable(cloudSync, store, row.kind, row.id);
      if (!check.ok) {
        res.status(check.status).json({ error: check.error });
        return;
      }
    }

    const deletedCounts = { observations: 0, summaries: 0, prompts: 0, toolUses: 0 };
    // One transaction for the whole session: queueDelete's own transaction
    // nests as a savepoint, so a failure part-way rolls back every tombstone
    // and row delete instead of leaving a half-deleted session.
    store.db.transaction(() => {
      for (const row of childRows) {
        this.commitRowDelete(cloudSync, store, row.kind, row.table, row.id);
        if (row.kind === 'observation') deletedCounts.observations++;
        else if (row.kind === 'summary') deletedCounts.summaries++;
        else deletedCounts.prompts++;
      }
      // The raw tool I/O backup is device-local (never synced); a deleted
      // session must not leave its captured tool inputs and outputs behind.
      deletedCounts.toolUses = store.db.prepare(
        `DELETE FROM tool_uses WHERE session_db_id = ? OR (content_session_id = ? AND platform_source = ?)`
      ).run(sessionRow.id, contentSessionId, platformSource).changes;
      store.db.prepare(`DELETE FROM sdk_sessions WHERE id = ?`).run(sessionRow.id);
    })();
    emitContextInvalidation('all', 'delete-session');

    // Only after the delete committed: open viewer tabs drop the session live.
    this.sseBroadcaster.broadcast({ type: 'session_deleted', platformSource, contentSessionId });
    res.json({ success: true, platformSource, contentSessionId, deletedCounts });
  });

  private handleGetProcessingStatus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const isProcessing = await this.sessionManager.isAnySessionProcessing();
    const queueDepth = await this.sessionManager.getTotalActiveWork();
    // #2756 — additive: sessions currently parked in waitForSlot, never a
    // breaking change to existing isProcessing/queueDepth consumers.
    const parkedSessions = getParkedSlotWaiterCount();
    res.json({ isProcessing, queueDepth, parkedSessions });
  });

  private parsePaginationParams(req: Request): { offset: number; limit: number; project?: string; platformSource?: string; contentSessionId?: string } {
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const project = req.query.project as string | undefined;
    const platformSource = this.getOptionalPlatformSourceFromRequest(req);
    const contentSessionId = req.query.contentSessionId as string | undefined;

    return { offset, limit, project, platformSource, contentSessionId };
  }

  /**
   * `claude-mem project merge <from> <into>` runs here so its Chroma patch can
   * land: this process holds the Chroma writer lock, and a merge run in the CLI
   * process was refused by it (gate P2-4). The merge re-keys memory on every
   * synced device, so other localhost pages may not trigger it.
   */
  private handleProjectMerge = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({ error: 'Project merges from a different localhost origin are not allowed' });
      return;
    }
    const { from, into, dryRun } = req.body as z.infer<typeof projectMergeSchema>;
    const mergeResult = await mergeProjectInto({ from, into, dryRun: dryRun ?? false });
    if (!dryRun) emitContextInvalidation('all', 'project-merge');
    res.json(mergeResult);
  });

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

    // Rows that could not be imported, by kind. "Skipped" above means the row
    // was already present; "rejected" means it failed validation or the insert
    // refused it. Reported back so a partial import is never silent.
    const rejected: Record<ImportRowKind, ImportRowRejection[]> = {
      sessions: [],
      summaries: [],
      observations: [],
      prompts: [],
    };
    const importEachRow = (kind: ImportRowKind, rows: unknown, importOne: (row: any) => void): void => {
      if (!Array.isArray(rows)) return;
      rows.forEach((row, index) => {
        const checked = importRowSchemas[kind].safeParse(row);
        if (!checked.success) {
          rejected[kind].push({ index, reason: describeImportRowIssues(checked.error) });
          return;
        }
        try {
          importOne(row);
        } catch (error: unknown) {
          rejected[kind].push({ index, reason: error instanceof Error ? error.message : String(error) });
        }
      });
    };

    importEachRow('sessions', sessions, (session) => {
      const result = store.importSdkSession(session);
      rememberSessionContext(session, result.id);
      if (result.imported) {
        stats.sessionsImported++;
      } else {
        stats.sessionsSkipped++;
      }
    });

    importEachRow('summaries', summaries, (summary) => {
      const result = store.importSessionSummary(summary);
      if (result.imported) {
        stats.summariesImported++;
      } else {
        stats.summariesSkipped++;
      }
    });

    const importedObservations: Array<{ id: number; obs: any }> = [];
    if (Array.isArray(observations)) {
      importEachRow('observations', observations, (obs) => {
        const result = store.importObservation(obs);
        if (result.imported) {
          stats.observationsImported++;
          importedObservations.push({ id: result.id, obs });
        } else {
          stats.observationsSkipped++;
        }
      });

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

    importEachRow('prompts', prompts, (prompt) => {
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
    });

    const rejectedCounts = {
      sessionsRejected: rejected.sessions.length,
      summariesRejected: rejected.summaries.length,
      observationsRejected: rejected.observations.length,
      promptsRejected: rejected.prompts.length,
    };
    if (Object.values(rejectedCounts).some(count => count > 0)) {
      logger.warn('HTTP', 'Import rejected rows', rejectedCounts);
    }

    emitContextInvalidation('all', 'import');
    res.json({
      success: true,
      stats: { ...stats, ...rejectedCounts },
      rejected,
    });
  });

}
