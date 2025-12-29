/**
 * Data Routes
 *
 * Handles data retrieval operations: observations, summaries, prompts, stats, processing status.
 * All endpoints use direct database access via service layer.
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync, statSync, existsSync } from 'fs';
import { logger } from '../../../../utils/logger.js';
import { homedir } from 'os';
import { getPackageRoot } from '../../../../shared/paths.js';
import { getWorkerPort } from '../../../../shared/worker-utils.js';
import { PaginationHelper } from '../../PaginationHelper.js';
import { DatabaseManager } from '../../DatabaseManager.js';
import { SessionManager } from '../../SessionManager.js';
import { SSEBroadcaster } from '../../SSEBroadcaster.js';
import type { WorkerService } from '../../../worker-service.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { getSessionSavings, getAllSessionSavings } from '../../../context-generator.js';

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
    app.get('/api/session/:sdkSessionId/stats', this.handleGetSessionStats.bind(this));
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

    // Import endpoint
    app.post('/api/import', this.handleImport.bind(this));

    // Memory importance and access tracking endpoints (Phase 1: Titans concepts)
    app.get('/api/memory/:id/stats', this.handleGetMemoryStats.bind(this));
    app.post('/api/memory/stats/batch', this.handleGetMemoryStatsBatch.bind(this));
    app.get('/api/memory/rare', this.handleGetRareMemories.bind(this));
    app.get('/api/memory/low-importance', this.handleGetLowImportanceMemories.bind(this));
    app.post('/api/memory/:id/access', this.handleRecordMemoryAccess.bind(this));
    app.post('/api/memory/access/batch', this.handleRecordMemoryAccessBatch.bind(this));

    // Surprise and momentum endpoints (Phase 2: Titans concepts)
    app.get('/api/surprise/:id', this.handleGetSurprise.bind(this));
    app.get('/api/surprising', this.handleGetSurprisingMemories.bind(this));
    app.get('/api/surprise/stats/:project', this.handleGetProjectSurpriseStats.bind(this));
    app.get('/api/momentum/stats', this.handleGetMomentumStats.bind(this));
    app.post('/api/momentum/boost', this.handleManualBoost.bind(this));
    app.delete('/api/momentum', this.handleClearMomentum.bind(this));

    // Smart management endpoints (Phase 3: Titans concepts)
    app.post('/api/cleanup/run', this.handleRunCleanup.bind(this));
    app.get('/api/cleanup/stats', this.handleGetCleanupStats.bind(this));
    app.post('/api/cleanup/config', this.handleUpdateCleanupConfig.bind(this));
    app.get('/api/cleanup/candidates', this.handleGetCleanupCandidates.bind(this));
    app.get('/api/cleanup/retention/:project', this.handleGetRetentionStats.bind(this));
    app.post('/api/compression/recommendation/:id', this.handleGetCompressionRecommendation.bind(this));
    app.get('/api/compression/stats/:project', this.handleGetCompressionStats.bind(this));
  }

  /**
   * Get paginated observations
   */
  private handleGetObservations = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getObservations(offset, limit, project);
    res.json(result);
  });

  /**
   * Get paginated summaries
   */
  private handleGetSummaries = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getSummaries(offset, limit, project);
    res.json(result);
  });

  /**
   * Get paginated user prompts
   */
  private handleGetPrompts = this.wrapHandler((req: Request, res: Response): void => {
    const { offset, limit, project } = this.parsePaginationParams(req);
    const result = this.paginationHelper.getPrompts(offset, limit, project);
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
      this.notFound(res, `Observation #${id} not found`);
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
    const { ids, orderBy, limit, project } = req.body;

    if (!ids || !Array.isArray(ids)) {
      this.badRequest(res, 'ids must be an array of numbers');
      return;
    }

    if (ids.length === 0) {
      res.json([]);
      return;
    }

    // Validate all IDs are numbers
    if (!ids.every(id => typeof id === 'number' && Number.isInteger(id))) {
      this.badRequest(res, 'All ids must be integers');
      return;
    }

    const store = this.dbManager.getSessionStore();
    const observations = store.getObservationsByIds(ids, { orderBy, limit, project });

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
      this.notFound(res, `Session #${id} not found`);
      return;
    }

    res.json(sessions[0]);
  });

  /**
   * Get session-specific statistics
   * GET /api/session/:sdkSessionId/stats
   * Returns: observations count, tokens, duration for this session
   */
  private handleGetSessionStats = this.wrapHandler((req: Request, res: Response): void => {
    const sdkSessionId = req.params.sdkSessionId;

    if (!sdkSessionId) {
      this.badRequest(res, 'Missing sdkSessionId');
      return;
    }

    const db = this.dbManager.getSessionStore().db;

    // Get session stats
    const sessionStats = db.prepare(`
      SELECT
        COUNT(*) as observations_count,
        COALESCE(SUM(discovery_tokens), 0) as total_tokens,
        MIN(created_at_epoch) as first_observation_at,
        MAX(created_at_epoch) as last_observation_at
      FROM observations
      WHERE sdk_session_id = ?
    `).get(sdkSessionId) as {
      observations_count: number;
      total_tokens: number;
      first_observation_at: number | null;
      last_observation_at: number | null;
    };

    // Get user prompts count for this session
    const promptStats = db.prepare(`
      SELECT COUNT(*) as prompts_count
      FROM user_prompts
      WHERE claude_session_id = ?
    `).get(sdkSessionId) as { prompts_count: number };

    // Calculate session duration
    let durationMs = 0;
    if (sessionStats.first_observation_at && sessionStats.last_observation_at) {
      durationMs = sessionStats.last_observation_at - sessionStats.first_observation_at;
    }

    res.json({
      sdkSessionId,
      observationsCount: sessionStats.observations_count,
      totalTokens: sessionStats.total_tokens,
      promptsCount: promptStats.prompts_count,
      durationMs,
      firstObservationAt: sessionStats.first_observation_at,
      lastObservationAt: sessionStats.last_observation_at
    });
  });

  /**
   * Get SDK sessions by SDK session IDs
   * POST /api/sdk-sessions/batch
   * Body: { memorySessionIds: string[] }
   */
  private handleGetSdkSessionsByIds = this.wrapHandler((req: Request, res: Response): void => {
    const { memorySessionIds } = req.body;

    if (!Array.isArray(memorySessionIds)) {
      this.badRequest(res, 'memorySessionIds must be an array');
      return;
    }

    const store = this.dbManager.getSessionStore();
    const sessions = store.getSdkSessionsBySessionIds(memorySessionIds);
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
      this.notFound(res, `Prompt #${id} not found`);
      return;
    }

    res.json(prompts[0]);
  });

  /**
   * Get database statistics (with worker metadata)
   */
  private handleGetStats = this.wrapHandler((req: Request, res: Response): void => {
    const db = this.dbManager.getSessionStore().db;

    // Read version from package.json
    const packageRoot = getPackageRoot();
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version;

    // Get database stats
    const totalObservations = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
    const totalSessions = db.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get() as { count: number };
    const totalSummaries = db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };

    // Get database file size and path
    const dbPath = path.join(homedir(), '.claude-mem', 'claude-mem.db');
    let dbSize = 0;
    if (existsSync(dbPath)) {
      dbSize = statSync(dbPath).size;
    }

    // Worker metadata
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const activeSessions = this.sessionManager.getActiveSessionCount();
    const sseClients = this.sseBroadcaster.getClientCount();

    // Get session savings (from most recent context generation)
    const project = req.query.project as string | undefined;
    const currentSavings = getSessionSavings(project);
    const allSavings = getAllSessionSavings();

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
        summaries: totalSummaries.count
      },
      savings: currentSavings ? {
        current: {
          project: currentSavings.project,
          savings: currentSavings.savings,
          savingsPercent: currentSavings.savingsPercent,
          totalReadTokens: currentSavings.totalReadTokens,
          totalDiscoveryTokens: currentSavings.totalDiscoveryTokens,
          totalObservations: currentSavings.totalObservations,
          calculatedAt: currentSavings.calculatedAt
        },
        allProjects: allSavings.map(s => ({
          project: s.project,
          savings: s.savings,
          savingsPercent: s.savingsPercent,
          calculatedAt: s.calculatedAt
        }))
      } : null
    });
  });

  /**
   * Get list of distinct projects from observations
   * GET /api/projects
   */
  private handleGetProjects = this.wrapHandler((req: Request, res: Response): void => {
    const db = this.dbManager.getSessionStore().db;

    const rows = db.prepare(`
      SELECT DISTINCT project
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

  /**
   * Parse pagination parameters from request query
   */
  private parsePaginationParams(req: Request): { offset: number; limit: number; project?: string } {
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100); // Max 100
    const project = req.query.project as string | undefined;

    return { offset, limit, project };
  }

  /**
   * Import memories from export file
   * POST /api/import
   * Body: { sessions: [], summaries: [], observations: [], prompts: [] }
   */
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

    // Import sessions first (dependency for everything else)
    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        const result = store.importSdkSession(session);
        if (result.imported) {
          stats.sessionsImported++;
        } else {
          stats.sessionsSkipped++;
        }
      }
    }

    // Import summaries (depends on sessions)
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

    // Import observations (depends on sessions)
    if (Array.isArray(observations)) {
      for (const obs of observations) {
        const result = store.importObservation(obs);
        if (result.imported) {
          stats.observationsImported++;
        } else {
          stats.observationsSkipped++;
        }
      }
    }

    // Import prompts (depends on sessions)
    if (Array.isArray(prompts)) {
      for (const prompt of prompts) {
        const result = store.importUserPrompt(prompt);
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

  /**
   * Get pending queue contents
   * GET /api/pending-queue
   * Returns all pending, processing, and failed messages with optional recently processed
   */
  private handleGetPendingQueue = this.wrapHandler((req: Request, res: Response): void => {
    const { PendingMessageStore } = require('../../../sqlite/PendingMessageStore.js');
    const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);

    // Get queue contents (pending, processing, failed)
    const queueMessages = pendingStore.getQueueMessages();

    // Get recently processed (last 30 min, up to 20)
    const recentlyProcessed = pendingStore.getRecentlyProcessed(20, 30);

    // Get stuck message count (processing > 5 min)
    const stuckCount = pendingStore.getStuckCount(5 * 60 * 1000);

    // Get sessions with pending work
    const sessionsWithPending = pendingStore.getSessionsWithPendingMessages();

    res.json({
      queue: {
        messages: queueMessages,
        totalPending: queueMessages.filter((m: { status: string }) => m.status === 'pending').length,
        totalProcessing: queueMessages.filter((m: { status: string }) => m.status === 'processing').length,
        totalFailed: queueMessages.filter((m: { status: string }) => m.status === 'failed').length,
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
    const sessionLimit = Math.min(
      Math.max(parseInt(req.body.sessionLimit, 10) || 10, 1),
      100 // Max 100 sessions at once
    );

    const result = await this.workerService.processPendingQueues(sessionLimit);

    res.json({
      success: true,
      ...result
    });
  });

  /**
   * Get memory importance and access statistics
   * GET /api/memory/:id/stats
   */
  private handleGetMemoryStats = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const { AccessTracker } = await import('../../AccessTracker.js');
    const { ImportanceScorer } = await import('../../ImportanceScorer.js');
    const { SemanticRarity } = await import('../../SemanticRarity.js');

    const db = this.dbManager.getSessionStore().db;
    const accessTracker = new AccessTracker(db);
    const importanceScorer = new ImportanceScorer(db);
    const semanticRarity = new SemanticRarity(db);

    // Get observation
    const observation = this.dbManager.getSessionStore().getObservationById(id);
    if (!observation) {
      this.notFound(res, `Observation #${id} not found`);
      return;
    }

    // Get access stats
    const accessStats = accessTracker.getAccessStats(id, 30);

    // Update and get importance score
    await importanceScorer.updateScore(id);
    const importanceScore = importanceScorer.getScore(id);

    // Get semantic rarity
    const rarityResult = await semanticRarity.calculate(observation, { sampleSize: 50 });

    res.json({
      id,
      importanceScore,
      accessStats,
      rarity: rarityResult.score,
      rarityConfidence: rarityResult.confidence,
      similarMemories: rarityResult.similarMemories.slice(0, 5), // Top 5 similar
    });
  });

  /**
   * Get memory statistics for multiple memories
   * POST /api/memory/stats/batch
   * Body: { ids: number[] }
   */
  private handleGetMemoryStatsBatch = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids)) {
      this.badRequest(res, 'ids must be an array of numbers');
      return;
    }

    const { AccessTracker } = await import('../../AccessTracker.js');
    const { ImportanceScorer } = await import('../../ImportanceScorer.js');

    const db = this.dbManager.getSessionStore().db;
    const accessTracker = new AccessTracker(db);
    const importanceScorer = new ImportanceScorer(db);

    const accessStats = accessTracker.getAccessStatsBatch(ids, 30);
    const importanceScores = importanceScorer.getScoresBatch(ids);

    const results = ids.map(id => ({
      id,
      importanceScore: importanceScores.get(id) ?? 0.5,
      accessStats: accessStats.get(id) ?? null,
    }));

    res.json(results);
  });

  /**
   * Get rare memories (high semantic rarity)
   * GET /api/memory/rare?threshold=0.7&limit=50&project=
   */
  private handleGetRareMemories = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const threshold = parseFloat(req.query.threshold as string) || 0.7;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const project = req.query.project as string | undefined;

    const { SemanticRarity } = await import('../../SemanticRarity.js');

    const db = this.dbManager.getSessionStore().db;
    const semanticRarity = new SemanticRarity(db);

    // Get rare memories
    let rareMemories = await semanticRarity.getRareMemories(threshold, limit);

    // Filter by project if specified
    if (project) {
      const store = this.dbManager.getSessionStore();
      const projectObsIds = new Set(
        store.getObservationsByIds(rareMemories.map(m => m.id), { project })
          .map(o => o.id)
      );
      rareMemories = rareMemories.filter(m => projectObsIds.has(m.id));
    }

    res.json({
      threshold,
      count: rareMemories.length,
      memories: rareMemories,
    });
  });

  /**
   * Get low importance memories (cleanup candidates)
   * GET /api/memory/low-importance?threshold=0.3&olderThanDays=90&limit=100
   */
  private handleGetLowImportanceMemories = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const threshold = parseFloat(req.query.threshold as string) || 0.3;
    const olderThanDays = parseInt(req.query.olderThanDays as string, 10) || 90;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);

    const { ImportanceScorer } = await import('../../ImportanceScorer.js');

    const db = this.dbManager.getSessionStore().db;
    const importanceScorer = new ImportanceScorer(db);

    const lowImportanceMemories = importanceScorer.getLowImportanceMemories(
      threshold,
      olderThanDays,
      limit
    );

    res.json({
      threshold,
      olderThanDays,
      count: lowImportanceMemories.length,
      memories: lowImportanceMemories,
    });
  });

  /**
   * Record access to a memory
   * POST /api/memory/:id/access
   * Body: { context?: string }
   */
  private handleRecordMemoryAccess = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const { context } = req.body;

    const { AccessTracker } = await import('../../AccessTracker.js');

    const db = this.dbManager.getSessionStore().db;
    const accessTracker = new AccessTracker(db);

    await accessTracker.recordAccess(id, context);

    res.json({ success: true, id });
  });

  /**
   * Record access to multiple memories
   * POST /api/memory/access/batch
   * Body: { ids: number[], context?: string }
   */
  private handleRecordMemoryAccessBatch = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { ids, context } = req.body;

    if (!ids || !Array.isArray(ids)) {
      this.badRequest(res, 'ids must be an array of numbers');
      return;
    }

    const { AccessTracker } = await import('../../AccessTracker.js');

    const db = this.dbManager.getSessionStore().db;
    const accessTracker = new AccessTracker(db);

    await accessTracker.recordAccessBatch(ids, context);

    res.json({ success: true, count: ids.length });
  });

  /**
   * Get surprise score for a specific memory
   * GET /api/surprise/:id
   */
  private handleGetSurprise = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const { SurpriseMetric } = await import('../../SurpriseMetric.js');

    const db = this.dbManager.getSessionStore().db;
    const surpriseMetric = new SurpriseMetric(db);

    const observation = this.dbManager.getSessionStore().getObservationById(id);
    if (!observation) {
      this.notFound(res, `Observation #${id} not found`);
      return;
    }

    const result = await surpriseMetric.calculate(observation, { sampleSize: 50 });

    res.json({
      id,
      surprise: result.score,
      confidence: result.confidence,
      factors: result.factors,
      similarMemories: result.similarMemories.slice(0, 5),
    });
  });

  /**
   * Get surprising memories (high surprise scores)
   * GET /api/surprising?threshold=0.7&limit=50&project=
   */
  private handleGetSurprisingMemories = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const threshold = parseFloat(req.query.threshold as string) || 0.7;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const project = req.query.project as string | undefined;

    const { SurpriseMetric } = await import('../../SurpriseMetric.js');

    const db = this.dbManager.getSessionStore().db;
    const surpriseMetric = new SurpriseMetric(db);

    let surprisingMemories = await surpriseMetric.getSurprisingMemories(threshold, limit, 30);

    // Filter by project if specified
    if (project) {
      const store = this.dbManager.getSessionStore();
      const projectObsIds = new Set(
        store.getObservationsByIds(surprisingMemories.map(m => m.id), { project })
          .map(o => o.id)
      );
      surprisingMemories = surprisingMemories.filter(m => projectObsIds.has(m.id));
    }

    res.json({
      threshold,
      count: surprisingMemories.length,
      memories: surprisingMemories,
    });
  });

  /**
   * Get surprise statistics for a project
   * GET /api/surprise/stats/:project?lookbackDays=30
   */
  private handleGetProjectSurpriseStats = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const project = req.params.project;
    const lookbackDays = parseInt(req.query.lookbackDays as string, 10) || 30;

    const { SurpriseMetric } = await import('../../SurpriseMetric.js');

    const db = this.dbManager.getSessionStore().db;
    const surpriseMetric = new SurpriseMetric(db);

    const stats = await surpriseMetric.getProjectSurpriseStats(project, lookbackDays);

    res.json({
      project,
      lookbackDays,
      stats,
    });
  });

  /**
   * Get momentum buffer statistics
   * GET /api/momentum/stats
   */
  private handleGetMomentumStats = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { getMomentumBuffer } = await import('../../MomentumBuffer.js');

    const momentumBuffer = getMomentumBuffer();
    const stats = momentumBuffer.getStats();

    res.json(stats);
  });

  /**
   * Manually boost a topic
   * POST /api/momentum/boost
   * Body: { topics: string[], duration?: number, boostFactor?: number }
   */
  private handleManualBoost = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { topics, duration, boostFactor } = req.body;

    if (!topics || !Array.isArray(topics)) {
      this.badRequest(res, 'topics must be an array of strings');
      return;
    }

    const { getMomentumBuffer } = await import('../../MomentumBuffer.js');

    const momentumBuffer = getMomentumBuffer();
    momentumBuffer.boostMultiple(topics, { duration, boostFactor });

    res.json({
      success: true,
      topics,
      duration: duration || 5,
      boostFactor: boostFactor || 1.5,
    });
  });

  /**
   * Clear all momentum boosts
   * DELETE /api/momentum
   */
  private handleClearMomentum = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { getMomentumBuffer } = await import('../../MomentumBuffer.js');

    const momentumBuffer = getMomentumBuffer();
    momentumBuffer.clearAll();

    res.json({ success: true, message: 'All momentum boosts cleared' });
  });

  /**
   * Run cleanup job manually
   * POST /api/cleanup/run?dryRun=true
   */
  private handleRunCleanup = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const dryRun = req.query.dryRun !== 'false';

    const { getCleanupJob } = await import('../../CleanupJob.js');
    const cleanupJob = getCleanupJob(this.dbManager.getSessionStore().db);

    const result = await cleanupJob.run();

    res.json({
      ...result,
      dryRun,
    });
  });

  /**
   * Get cleanup job statistics
   * GET /api/cleanup/stats
   */
  private handleGetCleanupStats = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { getCleanupJob } = await import('../../CleanupJob.js');
    const cleanupJob = getCleanupJob(this.dbManager.getSessionStore().db);

    const stats = cleanupJob.getStats();

    res.json(stats);
  });

  /**
   * Update cleanup job configuration
   * POST /api/cleanup/config
   * Body: { enableMemoryCleanup?: boolean, memoryCleanupIntervalHours?: number, ... }
   */
  private handleUpdateCleanupConfig = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { getCleanupJob } = await import('../../CleanupJob.js');
    const cleanupJob = getCleanupJob(this.dbManager.getSessionStore().db);

    cleanupJob.updateConfig(req.body);

    const stats = cleanupJob.getStats();

    res.json({
      success: true,
      config: stats.config,
    });
  });

  /**
   * Get cleanup candidates (memories that can be forgotten)
   * GET /api/cleanup/candidates?limit=100
   */
  private handleGetCleanupCandidates = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);

    const { ForgettingPolicy } = await import('../../ForgettingPolicy.js');
    const db = this.dbManager.getSessionStore().db;
    const policy = new ForgettingPolicy(db);

    const candidates = await policy.getCleanupCandidates(limit);

    res.json({
      count: candidates.length,
      limit,
      candidates,
    });
  });

  /**
   * Get retention statistics for a project
   * GET /api/cleanup/retention/:project?lookbackDays=365
   */
  private handleGetRetentionStats = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const project = req.params.project;
    const lookbackDays = parseInt(req.query.lookbackDays as string, 10) || 365;

    const { ForgettingPolicy } = await import('../../ForgettingPolicy.js');
    const db = this.dbManager.getSessionStore().db;
    const policy = new ForgettingPolicy(db);

    const stats = await policy.getProjectRetentionStats(project, lookbackDays);

    res.json({
      project,
      lookbackDays,
      stats,
    });
  });

  /**
   * Get compression recommendation for an observation
   * POST /api/compression/recommendation/:id
   */
  private handleGetCompressionRecommendation = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const id = this.parseIntParam(req, res, 'id');
    if (id === null) return;

    const { CompressionOptimizer } = await import('../../CompressionOptimizer.js');
    const db = this.dbManager.getSessionStore().db;
    const optimizer = new CompressionOptimizer(db);

    const observation = this.dbManager.getSessionStore().getObservationById(id);
    if (!observation) {
      this.notFound(res, `Observation #${id} not found`);
      return;
    }

    const recommendation = await optimizer.getRecommendation(observation);

    res.json({
      id,
      recommendation,
    });
  });

  /**
   * Get compression statistics for a project
   * GET /api/compression/stats/:project?lookbackDays=90
   */
  private handleGetCompressionStats = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const project = req.params.project;
    const lookbackDays = parseInt(req.query.lookbackDays as string, 10) || 90;

    const { CompressionOptimizer } = await import('../../CompressionOptimizer.js');
    const db = this.dbManager.getSessionStore().db;
    const optimizer = new CompressionOptimizer(db);

    const stats = await optimizer.getProjectCompressionStats(project, lookbackDays);

    // Also estimate token savings
    const savings = await optimizer.estimateTokenSavings(project, lookbackDays);

    res.json({
      project,
      lookbackDays,
      stats,
      savings,
    });
  });
}
