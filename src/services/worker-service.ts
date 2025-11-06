/**
 * Worker Service - Long-running HTTP service managed by PM2
 * Replaces detached Bun worker processes with single persistent Node service
 */

import express, { Request, Response } from 'express';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { SessionStore } from './sqlite/SessionStore.js';
import { ChromaSync } from './sync/ChromaSync.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../sdk/prompts.js';
import { parseObservations, parseSummary } from '../sdk/parser.js';
import type { SDKSession } from '../sdk/prompts.js';
import { logger } from '../utils/logger.js';
import { ensureAllDataDirs } from '../shared/paths.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const MODEL = process.env.CLAUDE_MEM_MODEL || 'claude-sonnet-4-5';
const DISALLOWED_TOOLS = ['Glob', 'Grep', 'ListMcpResourcesTool', 'WebSearch'];
const FIXED_PORT = parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777', 10);

/**
 * Cached Claude executable path
 */
let cachedClaudePath: string | null = null;

/**
 * Find Claude Code executable path using which (Unix/Mac) or where (Windows)
 * Cached after first call
 */
function findClaudePath(): string {
  if (cachedClaudePath) {
    return cachedClaudePath;
  }

  try {
    // Try environment variable first
    if (process.env.CLAUDE_CODE_PATH) {
      cachedClaudePath = process.env.CLAUDE_CODE_PATH;
      return cachedClaudePath;
    }

    // Use which on Unix/Mac, where on Windows
    const command = process.platform === 'win32' ? 'where claude' : 'which claude';
    const result = execSync(command, { encoding: 'utf8' }).trim();

    // On Windows, 'where' returns multiple lines if there are multiple matches, take the first
    const path = result.split('\n')[0].trim();

    if (!path) {
      throw new Error('Claude executable not found in PATH');
    }

    logger.info('SYSTEM', `Found Claude executable: ${path}`);
    cachedClaudePath = path;
    return cachedClaudePath;
  } catch (error: any) {
    logger.failure('SYSTEM', 'Failed to find Claude executable', {}, error);
    throw new Error('Claude Code executable not found. Please ensure claude is in your PATH or set CLAUDE_CODE_PATH environment variable.');
  }
}

interface ObservationMessage {
  type: 'observation';
  tool_name: string;
  tool_input: string;
  tool_output: string;
  prompt_number: number;
}

interface SummarizeMessage {
  type: 'summarize';
  prompt_number: number;
}

type WorkerMessage = ObservationMessage | SummarizeMessage;

/**
 * Active session state
 */
interface ActiveSession {
  sessionDbId: number;
  claudeSessionId: string; // Real Claude Code session ID
  sdkSessionId: string | null;
  project: string;
  userPrompt: string;
  pendingMessages: WorkerMessage[];
  abortController: AbortController;
  generatorPromise: Promise<void> | null;
  lastPromptNumber: number; // Track which prompt_number we last sent to SDK
  startTime: number; // Session start timestamp
}

class WorkerService {
  private app: express.Application;
  private port: number = FIXED_PORT;
  private sessions: Map<number, ActiveSession> = new Map();
  private chromaSync!: ChromaSync;
  private sseClients: Set<Response> = new Set();
  private isProcessing: boolean = false;
  private spinnerStopTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.app = express();
    this.app.use(express.json({ limit: '50mb' }));

    // Serve static files for web UI (viewer-bundle.js, logos, etc.)
    const uiDir = this.getUIDirectory();
    this.app.use(express.static(uiDir));

    // Health check
    this.app.get('/health', this.handleHealth.bind(this));

    // Web UI viewer
    this.app.get('/', this.handleViewerHTML.bind(this));

    // SSE stream for web UI
    this.app.get('/stream', this.handleSSEStream.bind(this));

    // API endpoints for web UI
    this.app.get('/api/stats', this.handleStats.bind(this));
    this.app.get('/api/settings', this.handleGetSettings.bind(this));
    this.app.post('/api/settings', this.handlePostSettings.bind(this));
    this.app.get('/api/observations', this.handleGetObservations.bind(this));
    this.app.get('/api/summaries', this.handleGetSummaries.bind(this));
    this.app.get('/api/prompts', this.handleGetPrompts.bind(this));
    this.app.get('/api/processing-status', this.handleGetProcessingStatus.bind(this));

    // Session endpoints
    this.app.post('/sessions/:sessionDbId/init', this.handleInit.bind(this));
    this.app.post('/sessions/:sessionDbId/observations', this.handleObservation.bind(this));
    this.app.post('/sessions/:sessionDbId/summarize', this.handleSummarize.bind(this));
    this.app.post('/sessions/:sessionDbId/complete', this.handleComplete.bind(this));
    this.app.get('/sessions/:sessionDbId/status', this.handleStatus.bind(this));
  }

  async start(): Promise<void> {
    // Start HTTP server FIRST - nothing else matters until we can respond
    await new Promise<void>((resolve, reject) => {
      this.app.listen(FIXED_PORT, () => resolve())
        .on('error', reject);
    });

    logger.info('SYSTEM', 'Worker started', { port: FIXED_PORT, pid: process.pid });

    // Initialize ChromaSync after HTTP is ready
    this.chromaSync = new ChromaSync('claude-mem');
    logger.info('SYSTEM', 'ChromaSync initialized');

    // Clean up orphaned sessions from previous worker instances
    const db = new SessionStore();
    const cleanedCount = db.cleanupOrphanedSessions();
    db.close();

    if (cleanedCount > 0) {
      logger.info('SYSTEM', `Cleaned up ${cleanedCount} orphaned sessions`);
    }

    // Backfill Chroma in background (non-blocking, non-critical)
    logger.info('SYSTEM', 'Starting Chroma backfill in background...');
    this.chromaSync.ensureBackfilled()
      .then(() => {
        logger.info('SYSTEM', 'Chroma backfill complete');
      })
      .catch((error: Error) => {
        logger.error('SYSTEM', 'Chroma backfill failed - continuing anyway', {}, error);
        // Don't exit - allow worker to continue serving requests
      });
  }

  /**
   * Get UI directory path (works in both dev ESM and production CJS)
   */
  private getUIDirectory(): string {
    let scriptDir: string;
    if (typeof __dirname !== 'undefined') {
      // CJS context (production build)
      scriptDir = __dirname;
    } else {
      // ESM context (development)
      const __filename = fileURLToPath(import.meta.url);
      scriptDir = dirname(__filename);
    }
    return join(scriptDir, '..', 'ui');
  }

  /**
   * GET /health
   */
  private handleHealth(_req: Request, res: Response): void {
    res.json({ status: 'ok' });
  }

  /**
   * GET / - Serve viewer HTML
   */
  private handleViewerHTML(_req: Request, res: Response): void {
    try {
      const uiPath = join(this.getUIDirectory(), 'viewer.html');
      const html = readFileSync(uiPath, 'utf-8');
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error: any) {
      logger.error('WORKER', 'Failed to serve viewer HTML', {}, error);
      res.status(500).send('Failed to load viewer');
    }
  }

  /**
   * GET /stream - SSE endpoint for web UI
   */
  private handleSSEStream(req: Request, res: Response): void {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Add client to set
    this.sseClients.add(res);
    logger.info('WORKER', `SSE client connected`, { totalClients: this.sseClients.size });

    // Send only projects list - all data will be loaded via pagination
    const db = new SessionStore();
    const allProjects = db.getAllProjects();
    db.close();

    const initialData = {
      type: 'initial_load',
      projects: allProjects,
      timestamp: Date.now()
    };

    res.write(`data: ${JSON.stringify(initialData)}\n\n`);

    // Handle client disconnect
    req.on('close', () => {
      this.sseClients.delete(res);
      logger.info('WORKER', `SSE client disconnected`, { remainingClients: this.sseClients.size });
    });
  }

  /**
   * Broadcast SSE event to all connected clients
   */
  private broadcastSSE(event: any): void {
    if (this.sseClients.size === 0) {
      return; // No clients connected, skip broadcast
    }

    const data = `data: ${JSON.stringify(event)}\n\n`;
    const clientsToRemove: Response[] = [];

    for (const client of this.sseClients) {
      try {
        client.write(data);
      } catch (error) {
        // Client disconnected, mark for removal
        clientsToRemove.push(client);
      }
    }

    // Clean up disconnected clients
    for (const client of clientsToRemove) {
      this.sseClients.delete(client);
    }

    if (clientsToRemove.length > 0) {
      logger.info('WORKER', `SSE cleaned up disconnected clients`, { count: clientsToRemove.length });
    }
  }

  /**
   * Broadcast processing status to SSE clients
   */
  private broadcastProcessingStatus(isProcessing: boolean): void {
    this.isProcessing = isProcessing;
    this.broadcastSSE({
      type: 'processing_status',
      isProcessing
    });
  }

  /**
   * Check if all sessions have empty queues and stop spinner after debounce
   */
  private checkAndStopSpinner(): void {
    // Clear any existing timer
    if (this.spinnerStopTimer) {
      clearTimeout(this.spinnerStopTimer);
      this.spinnerStopTimer = null;
    }

    // Check if any session has pending messages
    const hasPendingMessages = Array.from(this.sessions.values()).some(
      session => session.pendingMessages.length > 0
    );

    if (!hasPendingMessages) {
      // Debounce: wait 1.5s and check again
      this.spinnerStopTimer = setTimeout(() => {
        const stillEmpty = Array.from(this.sessions.values()).every(
          session => session.pendingMessages.length === 0
        );

        if (stillEmpty) {
          logger.debug('WORKER', 'All queues empty - stopping spinner');
          this.broadcastProcessingStatus(false);
        }

        this.spinnerStopTimer = null;
      }, 1500);
    }
  }

  /**
   * GET /api/stats - Return worker and database stats
   */
  private handleStats(_req: Request, res: Response): void {
    try {
      const db = new SessionStore();

      // Get database stats
      const obsCount = db.db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      const sessionCount = db.db.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get() as { count: number };
      const summaryCount = db.db.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };

      // Get database file size
      const dbPath = join(homedir(), '.claude-mem', 'claude-mem.db');
      let dbSize = 0;
      if (existsSync(dbPath)) {
        dbSize = statSync(dbPath).size;
      }

      db.close();

      // Get worker stats
      const uptime = process.uptime();
      const version = process.env.npm_package_version || '5.0.3'; // fallback to current version

      res.json({
        worker: {
          version,
          uptime: Math.floor(uptime),
          activeSessions: this.sessions.size,
          sseClients: this.sseClients.size,
          port: this.port
        },
        database: {
          path: dbPath,
          size: dbSize,
          observations: obsCount.count,
          sessions: sessionCount.count,
          summaries: summaryCount.count
        }
      });
    } catch (error: any) {
      logger.error('WORKER', 'Failed to get stats', {}, error);
      res.status(500).json({ error: 'Failed to get stats' });
    }
  }

  /**
   * GET /api/settings - Read settings from ~/.claude/settings.json
   */
  private handleGetSettings(_req: Request, res: Response): void {
    try {
      const settingsPath = join(homedir(), '.claude', 'settings.json');

      if (!existsSync(settingsPath)) {
        // Return defaults if file doesn't exist
        res.json({
          CLAUDE_MEM_MODEL: 'claude-haiku-4-5',
          CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
          CLAUDE_MEM_WORKER_PORT: '37777'
        });
        return;
      }

      const settingsData = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsData);
      const env = settings.env || {};

      res.json({
        CLAUDE_MEM_MODEL: env.CLAUDE_MEM_MODEL || 'claude-haiku-4-5',
        CLAUDE_MEM_CONTEXT_OBSERVATIONS: env.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50',
        CLAUDE_MEM_WORKER_PORT: env.CLAUDE_MEM_WORKER_PORT || '37777'
      });
    } catch (error: any) {
      logger.error('WORKER', 'Failed to read settings', {}, error);
      res.status(500).json({ error: 'Failed to read settings' });
    }
  }

  /**
   * POST /api/settings - Update settings in ~/.claude/settings.json
   */
  private handlePostSettings(req: Request, res: Response): void {
    try {
      const { CLAUDE_MEM_MODEL, CLAUDE_MEM_CONTEXT_OBSERVATIONS, CLAUDE_MEM_WORKER_PORT } = req.body;

      // Validate inputs
      const validModels = ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4'];
      if (CLAUDE_MEM_MODEL && !validModels.includes(CLAUDE_MEM_MODEL)) {
        res.status(400).json({ success: false, error: `Invalid model name: ${CLAUDE_MEM_MODEL}` });
        return;
      }

      if (CLAUDE_MEM_CONTEXT_OBSERVATIONS) {
        const obsCount = parseInt(CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10);
        if (isNaN(obsCount) || obsCount < 1 || obsCount > 200) {
          res.status(400).json({ success: false, error: 'CLAUDE_MEM_CONTEXT_OBSERVATIONS must be between 1 and 200' });
          return;
        }
      }

      if (CLAUDE_MEM_WORKER_PORT) {
        const port = parseInt(CLAUDE_MEM_WORKER_PORT, 10);
        if (isNaN(port) || port < 1024 || port > 65535) {
          res.status(400).json({ success: false, error: 'CLAUDE_MEM_WORKER_PORT must be between 1024 and 65535' });
          return;
        }
      }

      // Read existing settings
      const settingsPath = join(homedir(), '.claude', 'settings.json');
      let settings: any = { env: {} };

      if (existsSync(settingsPath)) {
        const settingsData = readFileSync(settingsPath, 'utf-8');
        settings = JSON.parse(settingsData);
        if (!settings.env) {
          settings.env = {};
        }
      }

      // Update settings
      if (CLAUDE_MEM_MODEL) {
        settings.env.CLAUDE_MEM_MODEL = CLAUDE_MEM_MODEL;
      }
      if (CLAUDE_MEM_CONTEXT_OBSERVATIONS) {
        settings.env.CLAUDE_MEM_CONTEXT_OBSERVATIONS = CLAUDE_MEM_CONTEXT_OBSERVATIONS;
      }
      if (CLAUDE_MEM_WORKER_PORT) {
        settings.env.CLAUDE_MEM_WORKER_PORT = CLAUDE_MEM_WORKER_PORT;
      }

      // Write back
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

      logger.info('WORKER', 'Settings updated', {});
      res.json({ success: true, message: 'Settings updated successfully' });
    } catch (error: any) {
      logger.error('WORKER', 'Failed to update settings', {}, error);
      res.status(500).json({ success: false, error: 'Failed to update settings' });
    }
  }

  /**
   * GET /api/observations - Paginated observations fetch
   * Query params: offset (default 0), limit (default 50), project (optional)
   */
  private handleGetObservations(req: Request, res: Response): void {
    try {
      const offset = parseInt(req.query.offset as string || '0', 10);
      const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 100); // Cap at 100
      const project = req.query.project as string | undefined;

      const db = new SessionStore();

      // Build query with optional project filter
      let query = `
        SELECT id, type, title, subtitle, text, project, prompt_number, created_at, created_at_epoch
        FROM observations
      `;
      let countQuery = 'SELECT COUNT(*) as total FROM observations';
      const params: any[] = [];
      const countParams: any[] = [];

      if (project) {
        query += ' WHERE project = ?';
        countQuery += ' WHERE project = ?';
        params.push(project);
        countParams.push(project);
      }

      query += ' ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const stmt = db.db.prepare(query);
      const observations = stmt.all(...params);

      // Check if there are more results
      const countStmt = db.db.prepare(countQuery);
      const { total } = countStmt.get(...countParams) as { total: number };
      const hasMore = (offset + limit) < total;

      db.close();

      res.json({
        observations,
        hasMore,
        total,
        offset,
        limit
      });
    } catch (error: any) {
      logger.error('WORKER', 'Failed to get observations', {}, error);
      res.status(500).json({ error: 'Failed to get observations' });
    }
  }

  private handleGetSummaries(req: Request, res: Response): void {
    try {
      const offset = parseInt(req.query.offset as string || '0', 10);
      const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 100); // Cap at 100
      const project = req.query.project as string | undefined;

      const db = new SessionStore();

      // Build query with optional project filter
      // JOIN with sdk_sessions to get claude_session_id (needed for UI matching with processingSessions)
      let query = `
        SELECT
          ss.id,
          s.claude_session_id as session_id,
          ss.request,
          ss.learned,
          ss.completed,
          ss.next_steps,
          ss.project,
          ss.created_at,
          ss.created_at_epoch
        FROM session_summaries ss
        JOIN sdk_sessions s ON ss.sdk_session_id = s.sdk_session_id
      `;
      let countQuery = 'SELECT COUNT(*) as total FROM session_summaries';
      const params: any[] = [];
      const countParams: any[] = [];

      if (project) {
        query += ' WHERE ss.project = ?';
        countQuery += ' WHERE project = ?';
        params.push(project);
        countParams.push(project);
      }

      query += ' ORDER BY ss.created_at_epoch DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const stmt = db.db.prepare(query);
      const summaries = stmt.all(...params);

      // Check if there are more results
      const countStmt = db.db.prepare(countQuery);
      const { total } = countStmt.get(...countParams) as { total: number };
      const hasMore = (offset + limit) < total;

      db.close();

      res.json({
        summaries,
        hasMore,
        total,
        offset,
        limit
      });
    } catch (error: any) {
      logger.error('WORKER', 'Failed to get summaries', {}, error);
      res.status(500).json({ error: 'Failed to get summaries' });
    }
  }

  private handleGetPrompts(req: Request, res: Response): void {
    try {
      const offset = parseInt(req.query.offset as string || '0', 10);
      const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 100); // Cap at 100
      const project = req.query.project as string | undefined;

      const db = new SessionStore();

      // Build query with optional project filter - JOIN with sdk_sessions to get project
      let query = `
        SELECT up.id, up.claude_session_id, s.project, up.prompt_number, up.prompt_text, up.created_at, up.created_at_epoch
        FROM user_prompts up
        JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      `;
      let countQuery = `
        SELECT COUNT(*) as total
        FROM user_prompts up
        JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      `;
      const params: any[] = [];
      const countParams: any[] = [];

      if (project) {
        query += ' WHERE s.project = ?';
        countQuery += ' WHERE s.project = ?';
        params.push(project);
        countParams.push(project);
      }

      query += ' ORDER BY created_at_epoch DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const stmt = db.db.prepare(query);
      const prompts = stmt.all(...params);

      // Check if there are more results
      const countStmt = db.db.prepare(countQuery);
      const { total } = countStmt.get(...countParams) as { total: number };
      const hasMore = (offset + limit) < total;

      db.close();

      res.json({
        prompts,
        hasMore,
        total,
        offset,
        limit
      });
    } catch (error: any) {
      logger.error('WORKER', 'Failed to get prompts', {}, error);
      res.status(500).json({ error: 'Failed to get prompts' });
    }
  }

  /**
   * GET /api/processing-status
   * Returns current processing status (boolean)
   */
  private handleGetProcessingStatus(_req: Request, res: Response): void {
    res.json({ isProcessing: this.isProcessing });
  }

  /**
   * POST /sessions/:sessionDbId/init
   * Body: { project, userPrompt }
   */
  private async handleInit(req: Request, res: Response): Promise<void> {
    const sessionDbId = parseInt(req.params.sessionDbId, 10);
    const { project, userPrompt } = req.body;

    logger.info('WORKER', 'Session init', { sessionDbId, project });

    // Fetch real Claude Code session ID from database
    const db = new SessionStore();
    const dbSession = db.getSessionById(sessionDbId);
    if (!dbSession) {
      db.close();
      res.status(404).json({ error: 'Session not found in database' });
      return;
    }

    const claudeSessionId = dbSession.claude_session_id;

    // Create session state
    const session: ActiveSession = {
      sessionDbId,
      claudeSessionId,
      sdkSessionId: null,
      project,
      userPrompt,
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 0,
      startTime: Date.now()
    };

    this.sessions.set(sessionDbId, session);

    // Update port in database
    db.setWorkerPort(sessionDbId, this.port!);

    // Get the latest user_prompt for this session to sync to Chroma
    const latestPrompt = db.db.prepare(`
      SELECT
        up.*,
        s.sdk_session_id,
        s.project
      FROM user_prompts up
      JOIN sdk_sessions s ON up.claude_session_id = s.claude_session_id
      WHERE up.claude_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(claudeSessionId) as any;

    db.close();

    // Broadcast new prompt to SSE clients (for web UI)
    if (latestPrompt) {
      this.broadcastSSE({
        type: 'new_prompt',
        prompt: {
          id: latestPrompt.id,
          claude_session_id: latestPrompt.claude_session_id,
          project: latestPrompt.project,
          prompt_number: latestPrompt.prompt_number,
          prompt_text: latestPrompt.prompt_text,
          created_at_epoch: latestPrompt.created_at_epoch
        }
      });
    }

    // Sync user prompt to Chroma (fire-and-forget, but crash on failure)
    if (latestPrompt) {
      this.chromaSync.syncUserPrompt(
        latestPrompt.id,
        latestPrompt.sdk_session_id,
        latestPrompt.project,
        latestPrompt.prompt_text,
        latestPrompt.prompt_number,
        latestPrompt.created_at_epoch
      ).catch(err => {
        logger.failure('WORKER', 'Failed to sync user_prompt to Chroma - continuing', { promptId: latestPrompt.id }, err);
        // Don't crash - SQLite has the data
      });
    }

    // Start SDK agent in background
    session.generatorPromise = this.runSDKAgent(session).catch(err => {
      logger.failure('WORKER', 'SDK agent error', { sessionId: sessionDbId }, err);
      const db = new SessionStore();
      db.markSessionFailed(sessionDbId);
      db.close();
      this.sessions.delete(sessionDbId);
    });

    // Start processing indicator (user submitted prompt)
    this.broadcastProcessingStatus(true);

    logger.success('WORKER', 'Session initialized', { sessionId: sessionDbId, port: this.port });
    res.json({
      status: 'initialized',
      sessionDbId,
      port: this.port
    });
  }

  /**
   * POST /sessions/:sessionDbId/observations
   * Body: { tool_name, tool_input, tool_output, prompt_number }
   */
  private handleObservation(req: Request, res: Response): void {
    const sessionDbId = parseInt(req.params.sessionDbId, 10);
    const { tool_name, tool_input, tool_output, prompt_number } = req.body;

    let session = this.sessions.get(sessionDbId);
    if (!session) {
      // Auto-create session if not in memory (worker restart, etc.)
      // Sessions are organizational metadata - observations are first-class data in vector store
      // Session ID comes from Claude Code hooks (guaranteed valid)
      const db = new SessionStore();
      const dbSession = db.getSessionById(sessionDbId);
      db.close();

      session = {
        sessionDbId,
        claudeSessionId: dbSession!.claude_session_id,
        sdkSessionId: null,
        project: dbSession!.project,
        userPrompt: dbSession!.user_prompt,
        pendingMessages: [],
        abortController: new AbortController(),
        generatorPromise: null,
        lastPromptNumber: 0,
        startTime: Date.now()
      };
      this.sessions.set(sessionDbId, session);

      // Start SDK agent in background
      session.generatorPromise = this.runSDKAgent(session).catch(err => {
        logger.failure('WORKER', 'SDK agent error', { sessionId: sessionDbId }, err);
        const db = new SessionStore();
        db.markSessionFailed(sessionDbId);
        db.close();
        this.sessions.delete(sessionDbId);
      });
    }

    const toolStr = logger.formatTool(tool_name, tool_input);

    logger.dataIn('WORKER', `Observation queued: ${toolStr}`, {
      sessionId: sessionDbId,
      queue: session.pendingMessages.length + 1
    });

    session.pendingMessages.push({
      type: 'observation',
      tool_name,
      tool_input,
      tool_output,
      prompt_number
    });

    res.json({ status: 'queued', queueLength: session.pendingMessages.length });
  }

  /**
   * POST /sessions/:sessionDbId/summarize
   * Body: { prompt_number }
   */
  private handleSummarize(req: Request, res: Response): void {
    const sessionDbId = parseInt(req.params.sessionDbId, 10);
    const { prompt_number } = req.body;

    let session = this.sessions.get(sessionDbId);
    if (!session) {
      // Auto-create session if not in memory (worker restart, etc.)
      // Sessions are organizational metadata - observations are first-class data in vector store
      // Session ID comes from Claude Code hooks (guaranteed valid)
      const db = new SessionStore();
      const dbSession = db.getSessionById(sessionDbId);
      db.close();

      session = {
        sessionDbId,
        claudeSessionId: dbSession!.claude_session_id,
        sdkSessionId: null,
        project: dbSession!.project,
        userPrompt: dbSession!.user_prompt,
        pendingMessages: [],
        abortController: new AbortController(),
        generatorPromise: null,
        lastPromptNumber: 0,
        startTime: Date.now()
      };
      this.sessions.set(sessionDbId, session);

      // Start SDK agent in background
      session.generatorPromise = this.runSDKAgent(session).catch(err => {
        logger.failure('WORKER', 'SDK agent error', { sessionId: sessionDbId }, err);
        const db = new SessionStore();
        db.markSessionFailed(sessionDbId);
        db.close();
        this.sessions.delete(sessionDbId);
      });
    }

    logger.dataIn('WORKER', 'Summary requested', {
      sessionId: sessionDbId,
      promptNumber: prompt_number,
      queue: session.pendingMessages.length + 1
    });

    session.pendingMessages.push({
      type: 'summarize',
      prompt_number
    });

    res.json({ status: 'queued', queueLength: session.pendingMessages.length });
  }

  /**
   * POST /sessions/:sessionDbId/complete
   * Called by cleanup hook to stop spinner when session ends
   */
  private handleComplete(req: Request, res: Response): void {
    const sessionDbId = parseInt(req.params.sessionDbId, 10);

    logger.info('WORKER', 'Session completed - stopping spinner', { sessionId: sessionDbId });

    // Stop processing indicator
    this.broadcastProcessingStatus(false);

    res.json({ status: 'ok' });
  }

  /**
   * GET /sessions/:sessionDbId/status
   */
  private handleStatus(req: Request, res: Response): void {
    const sessionDbId = parseInt(req.params.sessionDbId, 10);

    const session = this.sessions.get(sessionDbId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json({
      sessionDbId,
      sdkSessionId: session.sdkSessionId,
      project: session.project,
      pendingMessages: session.pendingMessages.length
    });
  }

  /**
   * Run SDK agent for a session
   */
  private async runSDKAgent(session: ActiveSession): Promise<void> {
    logger.info('SDK', 'Agent starting', { sessionId: session.sessionDbId });

    const claudePath = findClaudePath();
    logger.info('SDK', `Using Claude executable: ${claudePath}`, { sessionId: session.sessionDbId });

    try {
      const queryResult = query({
        prompt: this.createMessageGenerator(session),
        options: {
          model: MODEL,
          disallowedTools: DISALLOWED_TOOLS,
          abortController: session.abortController,
          pathToClaudeCodeExecutable: claudePath
        }
      });

      for await (const message of queryResult) {
        // Handle assistant messages
        if (message.type === 'assistant') {
          const content = message.message.content;
          const textContent = Array.isArray(content)
            ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
            : typeof content === 'string' ? content : '';

          const responseSize = textContent.length;
          logger.dataOut('SDK', `Response received (${responseSize} chars)`, {
            sessionId: session.sessionDbId,
            promptNumber: session.lastPromptNumber
          });

          // In debug mode, log the full response
          logger.debug('SDK', 'Full response', { sessionId: session.sessionDbId }, textContent);

          // Parse and store with prompt number (non-blocking Chroma sync)
          this.handleAgentMessage(session, textContent, session.lastPromptNumber);
        }

        // Capture usage data from result messages
        if (message.type === 'result' && message.subtype === 'success') {
          // Usage telemetry is captured at SDK level
        }
      }

      // Mark completed
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`
      });

      const db = new SessionStore();
      db.markSessionCompleted(session.sessionDbId);
      db.close();

      this.sessions.delete(session.sessionDbId);

    } catch (error: any) {
      if (error.name === 'AbortError') {
        logger.warn('SDK', 'Agent aborted', { sessionId: session.sessionDbId });
      } else {
        logger.failure('SDK', 'Agent error', { sessionId: session.sessionDbId }, error);
      }
      throw error;
    }
  }

  /**
   * Create async message generator for SDK streaming
   * Keeps running continuously - no finalize, agent stays alive for entire Claude Code session
   */
  private async* createMessageGenerator(session: ActiveSession): AsyncIterable<SDKUserMessage> {
    // Use real Claude Code session ID instead of fake session-{dbId}
    const initPrompt = buildInitPrompt(session.project, session.claudeSessionId, session.userPrompt);

    logger.dataIn('SDK', `Init prompt sent (${initPrompt.length} chars)`, {
      sessionId: session.sessionDbId,
      claudeSessionId: session.claudeSessionId,
      project: session.project
    });
    logger.debug('SDK', 'Full init prompt', { sessionId: session.sessionDbId }, initPrompt);

    yield {
      type: 'user',
      session_id: session.claudeSessionId, // Use real session ID from the start
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: initPrompt
      }
    };

    // Process messages continuously until session is deleted
    while (true) {
      if (session.abortController.signal.aborted) {
        break;
      }

      if (session.pendingMessages.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      while (session.pendingMessages.length > 0) {
        const message = session.pendingMessages.shift()!;

        if (message.type === 'summarize') {
          session.lastPromptNumber = message.prompt_number;

          const db = new SessionStore();
          const dbSession = db.getSessionById(session.sessionDbId) as SDKSession;
          db.close();

          const summarizePrompt = buildSummaryPrompt(dbSession);

          logger.dataIn('SDK', `Summary prompt sent (${summarizePrompt.length} chars)`, {
            sessionId: session.sessionDbId,
            promptNumber: message.prompt_number
          });
          logger.debug('SDK', 'Full summary prompt', { sessionId: session.sessionDbId }, summarizePrompt);

          yield {
            type: 'user',
            session_id: session.claudeSessionId,
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: summarizePrompt
            }
          };
        } else if (message.type === 'observation') {
          session.lastPromptNumber = message.prompt_number;

          const observationPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name,
            tool_input: message.tool_input,
            tool_output: message.tool_output,
            created_at_epoch: Date.now()
          });

          const toolStr = logger.formatTool(message.tool_name, message.tool_input);

          logger.dataIn('SDK', `Observation prompt: ${toolStr}`, {
            sessionId: session.sessionDbId,
            promptNumber: message.prompt_number,
            size: `${observationPrompt.length} chars`
          });
          logger.debug('SDK', 'Full observation prompt', { sessionId: session.sessionDbId }, observationPrompt);

          yield {
            type: 'user',
            session_id: session.claudeSessionId, // Use real session ID
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: observationPrompt
            }
          };
        }
      }
    }
  }

  /**
   * Handle agent message - parse and store observations/summaries
   * Gets prompt_number from the message that triggered this response
   */
  private handleAgentMessage(session: ActiveSession, content: string, promptNumber: number): void {
    // Always log what we received for debugging
    logger.info('PARSER', `Processing response (${content.length} chars)`, {
      sessionId: session.sessionDbId,
      promptNumber,
      preview: content.substring(0, 200)
    });

    // Parse observations
    const observations = parseObservations(content);

    if (observations.length > 0) {
      logger.info('PARSER', `Parsed ${observations.length} observation(s)`, {
        sessionId: session.sessionDbId,
        promptNumber,
        types: observations.map(o => o.type).join(', ')
      });
    }

    const db = new SessionStore();

    // Store observations and sync to Chroma (non-blocking, fail-fast)
    for (const obs of observations) {
      const { id, createdAtEpoch } = db.storeObservation(session.claudeSessionId, session.project, obs, promptNumber);
      logger.success('DB', 'Observation stored', {
        sessionId: session.sessionDbId,
        type: obs.type,
        title: obs.title,
        id
      });

      // Broadcast to SSE clients (for web UI)
      this.broadcastSSE({
        type: 'new_observation',
        observation: {
          id,
          session_id: session.claudeSessionId,
          type: obs.type,
          title: obs.title,
          subtitle: obs.subtitle,
          project: session.project,
          prompt_number: promptNumber,
          created_at_epoch: createdAtEpoch
        }
      });

      // Sync to Chroma (non-blocking fire-and-forget, but crash on failure)
      this.chromaSync.syncObservation(
        id,
        session.claudeSessionId,
        session.project,
        obs,
        promptNumber,
        createdAtEpoch
      ).then(() => {
        logger.success('WORKER', 'Observation synced to Chroma', {
          sessionId: session.sessionDbId,
          observationId: id
        });
      }).catch((error: Error) => {
        logger.error('WORKER', 'Observation sync failed - continuing', {
          sessionId: session.sessionDbId,
          observationId: id
        }, error);
        // Don't crash - SQLite has the data
      });
    }

    // Parse summary and ALWAYS store it
    logger.info('PARSER', 'Looking for summary tags...', { sessionId: session.sessionDbId });
    const summary = parseSummary(content, session.sessionDbId);
    if (summary) {
      logger.success('PARSER', 'Summary parsed successfully!', {
        sessionId: session.sessionDbId,
        promptNumber,
        hasRequest: !!summary.request,
        hasInvestigated: !!summary.investigated,
        hasLearned: !!summary.learned,
        hasCompleted: !!summary.completed,
        hasNextSteps: !!summary.next_steps
      });

      const { id, createdAtEpoch } = db.storeSummary(session.claudeSessionId, session.project, summary, promptNumber);
      logger.success('DB', '📝 SUMMARY STORED IN DATABASE', { sessionId: session.sessionDbId, promptNumber, id });

      // Broadcast to SSE clients (for web UI)
      this.broadcastSSE({
        type: 'new_summary',
        summary: {
          id,
          session_id: session.claudeSessionId,
          request: summary.request,
          investigated: summary.investigated,
          learned: summary.learned,
          completed: summary.completed,
          next_steps: summary.next_steps,
          notes: summary.notes,
          project: session.project,
          prompt_number: promptNumber,
          created_at_epoch: createdAtEpoch
        }
      });

      // Sync to Chroma (non-blocking fire-and-forget, but crash on failure)
      this.chromaSync.syncSummary(
        id,
        session.claudeSessionId,
        session.project,
        summary,
        promptNumber,
        createdAtEpoch
      ).then(() => {
        logger.success('WORKER', 'Summary synced to Chroma', {
          sessionId: session.sessionDbId,
          summaryId: id
        });
      }).catch((error: Error) => {
        logger.error('WORKER', 'Summary sync failed - continuing', {
          sessionId: session.sessionDbId,
          summaryId: id
        }, error);
        // Don't crash - SQLite has the data
      });
    } else {
      logger.warn('PARSER', 'NO SUMMARY TAGS FOUND in response', {
        sessionId: session.sessionDbId,
        promptNumber,
        contentSample: content.substring(0, 500)
      });
    }

    db.close();

    // Check if queue is empty and stop spinner after debounce
    this.checkAndStopSpinner();
  }
}

// Main entry point
async function main() {
  const service = new WorkerService();
  await service.start();

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.warn('SYSTEM', 'Shutting down (SIGINT)');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.warn('SYSTEM', 'Shutting down (SIGTERM)');
    process.exit(0);
  });
}

// Auto-start when run directly (not when imported)
main().catch(err => {
  logger.failure('SYSTEM', 'Fatal startup error', {}, err);
  process.exit(1);
});

export { WorkerService };
