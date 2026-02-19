/**
 * Data Routes
 *
 * Handles data retrieval operations: observations, summaries, prompts, stats, processing status.
 * All endpoints use direct database access via service layer.
 */

import type { Request, Response } from 'express';
import type express from 'express';
import path from 'path';
import { readFileSync, statSync, existsSync } from 'fs';
import { logger } from '../../../../utils/logger.js';
import { homedir } from 'os';
import { getPackageRoot } from '../../../../shared/paths.js';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import type { PaginationHelper } from '../../PaginationHelper.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import type { SessionManager } from '../../SessionManager.js';
import type { SSEBroadcaster } from '../../SSEBroadcaster.js';
import type { WorkerService } from '../../../worker-service.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { PendingMessageStore } from '../../../sqlite/PendingMessageStore.js';

/** Request body for POST /api/observations/batch */
interface ObservationsBatchBody {
  ids: unknown;
  orderBy?: 'date_desc' | 'date_asc';
  limit?: number;
  project?: string;
}

/** Request body for POST /api/sdk-sessions/batch */
interface SdkSessionsBatchBody {
  memorySessionIds: unknown;
}

/** Request body for POST /api/import */
interface ImportBody {
  sessions: unknown;
  summaries: unknown;
  observations: unknown;
  prompts: unknown;
}

/** Request body for POST /api/pending-queue/process */
interface ProcessPendingQueueBody {
  sessionLimit?: string | number;
}

/** Type for import method parameters matching SessionStore signatures */
interface ImportSdkSession {
  content_session_id: string;
  memory_session_id: string;
  project: string;
  user_prompt: string;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: string;
}

interface ImportSessionSummary {
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
  prompt_number: number | null;
  discovery_tokens: number;
  created_at: string;
  created_at_epoch: number;
}

interface ImportObservation {
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  discovery_tokens: number;
  created_at: string;
  created_at_epoch: number;
}

interface ImportUserPrompt {
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

// Cache package version at module load time (read once at startup)
const cachedPackageVersion: string = (() => {
  try {
    const packageRoot = getPackageRoot();
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string };
    return packageJson.version;
  } catch {
    return 'unknown';
  }
})();

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
    // Pagination endpoints
    app.get('/api/observations', this.handleGetObservations.bind(this));
    app.get('/api/summaries', this.handleGetSummaries.bind(this));
    app.get('/api/prompts', this.handleGetPrompts.bind(this));

    // Fetch by ID endpoints
    app.get('/api/observation/:id', this.handleGetObservationById.bind(this));
    app.post('/api/observations/batch', this.handleGetObservationsByIds.bind(this));
    app.get('/api/session/:id', this.handleGetSessionById.bind(this));
    app.post('/api/sdk-sessions/batch', this.handleGetSdkSessionsByIds.bind(this));
    app.get('/api/prompt/:id', this.handleGetPromptById.bind(this));

    // Metadata endpoints
    app.get('/api/stats', this.handleGetStats.bind(this));
    app.get('/api/projects', this.handleGetProjects.bind(this));

    // Processing status endpoints
    app.get('/api/processing-status', this.handleGetProcessingStatus.bind(this));
    app.post('/api/processing', this.handleSetProcessing.bind(this));

    // Pending queue management endpoints
    app.get('/api/pending-queue', this.handleGetPendingQueue.bind(this));
    app.post('/api/pending-queue/process', this.handleProcessPendingQueue.bind(this));
    app.delete('/api/pending-queue/failed', this.handleClearFailedQueue.bind(this));
    app.delete('/api/pending-queue/all', this.handleClearAllQueue.bind(this));

    // Import endpoint
    app.post('/api/import', this.handleImport.bind(this));
  }

  /**
   * Get paginated observations
   */
  private handleGetObservations = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, sessionId, summaryId, unsummarized } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getObservations(offset, limit, project, sessionId, summaryId, unsummarized);
    res.json(result);
  });

  /**
   * Get paginated summaries
   */
  private handleGetSummaries = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, sessionId } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getSummaries(offset, limit, project, sessionId);
    res.json(result);
  });

  /**
   * Get paginated user prompts
   */
  private handleGetPrompts = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project, sessionId, summaryId, unsummarized } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getPrompts(offset, limit, project, sessionId, summaryId, unsummarized);
    res.json(result);
  });

  /**
   * Get observation by ID
   * GET /api/observation/:id
   */
  private handleGetObservationById = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const observation = store.getObservationById(id);

    if (!observation) {
      this.notFound(res, `Observation #${String(id)} not found`);
      return;
    }

    res.json(observation);
  });

  /**
   * Get observations by array of IDs
   * POST /api/observations/batch
   * Body: { ids: number[], orderBy?: 'date_desc' | 'date_asc', limit?: number, project?: string }
   */
  private handleGetObservationsByIds = this.wrapHandler((req: Request, res: Response): void => {
    const body = req.body as ObservationsBatchBody;
    const { ids, orderBy, limit, project } = body;

    if (!ids || !Array.isArray(ids)) {
      this.badRequest(res, 'ids must be an array of numbers');
      return;
    }

    if (ids.length === 0) {
      res.json([]);
      return;
    }

    if (ids.length > 500) {
      this.badRequest(res, 'Maximum 500 IDs per batch request');
      return;
    }

    // Validate all IDs are numbers
    if (!ids.every((id: unknown) => typeof id === 'number' && Number.isInteger(id))) {
      this.badRequest(res, 'All ids must be integers');
      return;
    }

    const validatedIds = ids as number[];
    const store = this.dbManager.getSessionStore();
    const observations = store.getObservationsByIds(validatedIds, { orderBy, limit, project });

    res.json(observations);
  });

  /**
   * Get session by ID
   * GET /api/session/:id
   */
  private handleGetSessionById = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const sessions = store.getSessionSummariesByIds([id]);

    if (sessions.length === 0) {
      this.notFound(res, `Session #${String(id)} not found`);
      return;
    }

    res.json(sessions[0]);
  });

  /**
   * Get SDK sessions by SDK session IDs
   * POST /api/sdk-sessions/batch
   * Body: { memorySessionIds: string[] }
   */
  private handleGetSdkSessionsByIds = this.wrapHandler((req: Request, res: Response): void => {
    const body = req.body as SdkSessionsBatchBody;
    const { memorySessionIds } = body;

    if (!Array.isArray(memorySessionIds)) {
      this.badRequest(res, 'memorySessionIds must be an array');
      return;
    }

    if (memorySessionIds.length > 500) {
      this.badRequest(res, 'Maximum 500 IDs per batch request');
      return;
    }

    // Validate each element is a non-empty string
    if (!memorySessionIds.every((id: unknown) => typeof id === 'string' && id.length > 0)) {
      this.badRequest(res, 'All memorySessionIds must be non-empty strings');
      return;
    }

    const validatedIds = memorySessionIds as string[];
    const store = this.dbManager.getSessionStore();
    const sessions = store.getSdkSessionsBySessionIds(validatedIds);
    res.json(sessions);
  });

  /**
   * Get user prompt by ID
   * GET /api/prompt/:id
   */
  private handleGetPromptById = this.wrapHandler((req: Request, res: Response): void => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const store = this.dbManager.getSessionStore();
    const prompts = store.getUserPromptsByIds([id]);

    if (prompts.length === 0) {
      this.notFound(res, `Prompt #${String(id)} not found`);
      return;
    }

    res.json(prompts[0]);
  });

  /**
   * Get database statistics (with worker metadata)
   */
  private handleGetStats = this.wrapHandler((req: Request, res: Response): void => {
    const db = this.dbManager.getSessionStore().db;

    // Get database stats
    const totalObservations = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
    const totalSessions = db.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get() as { count: number };
    const totalSummaries = db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };

    // Get database file size and path
    const dbPath = path.join(homedir(), '.magic-claude-mem', 'magic-claude-mem.db');
    let dbSize = 0;
    if (existsSync(dbPath)) {
      dbSize = statSync(dbPath).size;
    }

    // Worker metadata
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const activeSessions = this.sessionManager.getActiveSessionCount();
    const sseClients = this.sseBroadcaster.getClientCount();

    res.json({
      worker: {
        version: cachedPackageVersion,
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
        summaries: totalSummaries.count
      }
    });
  });

  /**
   * Get list of distinct projects from observations
   * GET /api/projects
   */
  private handleGetProjects = this.wrapHandler((req: Request, res: Response): void => {
    const db = this.dbManager.getSessionStore().db;

    const rows = db.prepare(`
      SELECT project
      FROM observations
      WHERE project IS NOT NULL
      GROUP BY project
      ORDER BY MAX(created_at_epoch) DESC
    `).all() as Array<{ project: string }>;

    const projects = rows.map(row => row.project);

    res.json({ projects });
  });

  /**
   * Get current processing status
   * GET /api/processing-status
   */
  private handleGetProcessingStatus = this.wrapHandler((req: Request, res: Response): void => {
    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalActiveWork(); // Includes queued + actively processing
    res.json({ isProcessing, queueDepth });
  });

  /**
   * Set processing status (called by hooks)
   * NOTE: This now broadcasts computed status based on active processing (ignores input)
   */
  private handleSetProcessing = this.wrapHandler((req: Request, res: Response): void => {
    // Broadcast current computed status (ignores manual input)
    this.workerService.broadcastProcessingStatus();

    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalQueueDepth();
    const activeSessions = this.sessionManager.getActiveSessionCount();

    res.json({ status: 'ok', isProcessing, queueDepth, activeSessions });
  });

  /** Create a PendingMessageStore for queue operations. */
  private createPendingStore(): PendingMessageStore {
    return new PendingMessageStore(this.dbManager.getSessionStore().db, 3);
  }

  /**
   * Parse pagination parameters from request query
   */
  private parsePaginationParams(req: Request): { offset: number; limit: number; project?: string; sessionId?: string; summaryId?: number; unsummarized?: boolean } {
    const offset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string, 10) || 20, 100));
    const project = req.query.project as string | undefined;
    const sessionId = req.query.session_id as string | undefined;
    const unsummarized = req.query.unsummarized === 'true';

    const parsedSummaryId = parseInt(req.query.summary_id as string, 10);
    const summaryId = Number.isFinite(parsedSummaryId) ? parsedSummaryId : undefined;

    return { offset, limit, project, sessionId, summaryId, unsummarized };
  }

  /**
   * Import memories from export file
   * POST /api/import
   * Body: { sessions: [], summaries: [], observations: [], prompts: [] }
   */
  private handleImport = this.wrapHandler((req: Request, res: Response): void => {
    const body = req.body as ImportBody;
    const { sessions, summaries, observations, prompts } = body;

    // Validate size limits per entity type (max 10000 each)
    const MAX_IMPORT_SIZE = 10000;
    for (const [name, items] of Object.entries({ sessions, summaries, observations, prompts })) {
      if (Array.isArray(items) && items.length > MAX_IMPORT_SIZE) {
        this.badRequest(res, `Maximum ${String(MAX_IMPORT_SIZE)} items per entity type (${name} has ${String((items as unknown[]).length)})`);
        return;
      }
    }

    const store = this.dbManager.getSessionStore();

    function runImport<T>(items: unknown, importFn: (item: T) => { imported: boolean }): { imported: number; skipped: number } {
      let imported = 0;
      let skipped = 0;
      if (Array.isArray(items)) {
        for (const item of items as T[]) {
          if (importFn(item).imported) {
            imported++;
          } else {
            skipped++;
          }
        }
      }
      return { imported, skipped };
    }

    // Wrap all imports in a single transaction for atomicity
    const importAll = store.db.transaction(() => {
      const sessionsResult = runImport<ImportSdkSession>(sessions, s => store.importSdkSession(s));
      const summariesResult = runImport<ImportSessionSummary>(summaries, s => store.importSessionSummary(s));
      const observationsResult = runImport<ImportObservation>(observations, o => store.importObservation(o));
      const promptsResult = runImport<ImportUserPrompt>(prompts, p => store.importUserPrompt(p));
      return { sessionsResult, summariesResult, observationsResult, promptsResult };
    });
    const { sessionsResult, summariesResult, observationsResult, promptsResult } = importAll();

    const stats = {
      sessionsImported: sessionsResult.imported,
      sessionsSkipped: sessionsResult.skipped,
      summariesImported: summariesResult.imported,
      summariesSkipped: summariesResult.skipped,
      observationsImported: observationsResult.imported,
      observationsSkipped: observationsResult.skipped,
      promptsImported: promptsResult.imported,
      promptsSkipped: promptsResult.skipped,
    };

    res.json({
      success: true,
      stats
    });
  });

  /**
   * Get pending queue contents
   * GET /api/pending-queue
   * Returns all pending, processing, and failed messages with optional recently processed
   */
  private handleGetPendingQueue = this.wrapHandler((req: Request, res: Response): void => {
    const pendingStore = this.createPendingStore();

    // Get queue contents (pending, processing, failed)
    const queueMessages = pendingStore.getQueueMessages();

    // Get recently processed (last 30 min, up to 20)
    const recentlyProcessed = pendingStore.getRecentlyProcessed(20, 30);

    // Get stuck message count (processing > 5 min)
    const stuckCount = pendingStore.getStuckCount(5 * 60 * 1000);

    // Get sessions with pending work
    const sessionsWithPending = pendingStore.getSessionsWithPendingMessages();

    const statusCounts = { pending: 0, processing: 0, failed: 0 };
    for (const m of queueMessages) {
      if (m.status in statusCounts) {
        statusCounts[m.status as keyof typeof statusCounts]++;
      }
    }

    res.json({
      queue: {
        messages: queueMessages,
        totalPending: statusCounts.pending,
        totalProcessing: statusCounts.processing,
        totalFailed: statusCounts.failed,
        stuckCount
      },
      recentlyProcessed,
      sessionsWithPendingWork: sessionsWithPending
    });
  });

  /**
   * Process pending queue
   * POST /api/pending-queue/process
   * Body: { sessionLimit?: number } - defaults to 10
   * Starts SDK agents for sessions with pending messages
   */
  private handleProcessPendingQueue = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const body = req.body as ProcessPendingQueueBody;
    const sessionLimit = Math.min(
      Math.max(parseInt(String(body.sessionLimit), 10) || 10, 1),
      100 // Max 100 sessions at once
    );

    const result = await this.workerService.processPendingQueues(sessionLimit);

    res.json({
      success: true,
      ...result
    });
  });

  /**
   * Clear all failed messages from the queue
   * DELETE /api/pending-queue/failed
   * Returns the number of messages cleared
   */
  private handleClearFailedQueue = this.wrapHandler((req: Request, res: Response): void => {
    const pendingStore = this.createPendingStore();

    const clearedCount = pendingStore.clearFailed();

    logger.info('QUEUE', 'Cleared failed queue messages', { clearedCount });

    res.json({
      success: true,
      clearedCount
    });
  });

  /**
   * Clear all messages from the queue (pending, processing, and failed)
   * DELETE /api/pending-queue/all
   * Returns the number of messages cleared
   */
  private handleClearAllQueue = this.wrapHandler((req: Request, res: Response): void => {
    const pendingStore = this.createPendingStore();

    const clearedCount = pendingStore.clearAll();

    logger.warn('QUEUE', 'Cleared ALL queue messages (pending, processing, failed)', { clearedCount });

    res.json({
      success: true,
      clearedCount
    });
  });
}
