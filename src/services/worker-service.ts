/**
 * Worker Service - Long-running HTTP service managed by PM2
 * Replaces detached Bun worker processes with single persistent Node service
 */

import express, { Request, Response } from 'express';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { SessionStore } from './sqlite/SessionStore.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../sdk/prompts.js';
import { parseObservations, parseSummary } from '../sdk/parser.js';
import type { SDKSession } from '../sdk/prompts.js';
import { logger } from '../utils/logger.js';
import { ensureAllDataDirs } from '../shared/paths.js';

const MODEL = process.env.CLAUDE_MEM_MODEL || 'claude-sonnet-4-5';
const DISALLOWED_TOOLS = ['Glob', 'Grep', 'ListMcpResourcesTool', 'WebSearch'];
const FIXED_PORT = parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777', 10);

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
  observationCounter: number; // Counter for correlation IDs
  startTime: number; // Session start timestamp
}

class WorkerService {
  private app: express.Application;
  private port: number | null = null;
  private sessions: Map<number, ActiveSession> = new Map();

  constructor() {
    this.app = express();
    this.app.use(express.json({ limit: '50mb' }));

    // Health check
    this.app.get('/health', this.handleHealth.bind(this));

    // Session endpoints
    this.app.post('/sessions/:sessionDbId/init', this.handleInit.bind(this));
    this.app.post('/sessions/:sessionDbId/observations', this.handleObservation.bind(this));
    this.app.post('/sessions/:sessionDbId/summarize', this.handleSummarize.bind(this));
    this.app.get('/sessions/:sessionDbId/status', this.handleStatus.bind(this));
    this.app.delete('/sessions/:sessionDbId', this.handleDelete.bind(this));
  }

  async start(): Promise<void> {
    this.port = FIXED_PORT;

    // Clean up orphaned sessions from previous worker instances
    const db = new SessionStore();
    const cleanedCount = db.cleanupOrphanedSessions();
    db.close();

    if (cleanedCount > 0) {
      logger.info('SYSTEM', `Cleaned up ${cleanedCount} orphaned sessions`);
    }

    return new Promise((resolve, reject) => {
      this.app.listen(FIXED_PORT, '127.0.0.1', () => {
        logger.info('SYSTEM', `Worker started`, { port: FIXED_PORT, pid: process.pid, activeSessions: this.sessions.size });
        resolve();
      }).on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          logger.error('SYSTEM', `Port ${FIXED_PORT} already in use - worker may already be running`);
        }
        reject(err);
      });
    });
  }

  /**
   * GET /health
   */
  private handleHealth(req: Request, res: Response): void {
    res.json({
      status: 'ok',
      port: this.port,
      pid: process.pid,
      activeSessions: this.sessions.size,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    });
  }

  /**
   * POST /sessions/:sessionDbId/init
   * Body: { project, userPrompt }
   */
  private async handleInit(req: Request, res: Response): Promise<void> {
    const sessionDbId = parseInt(req.params.sessionDbId, 10);
    const { project, userPrompt } = req.body;

    const correlationId = logger.sessionId(sessionDbId);
    logger.info('WORKER', 'Session init', { correlationId, project });

    // Fetch real Claude Code session ID from database
    const db = new SessionStore();
    const dbSession = db.getSessionById(sessionDbId);
    if (!dbSession) {
      db.close();
      res.status(404).json({ error: 'Session not found in database' });
      return;
    }

    // Get the real claude_session_id (which is the same as sdk_session_id now)
    const claudeSessionId = dbSession.sdk_session_id || `session-${sessionDbId}`;

    // Create session state
    const session: ActiveSession = {
      sessionDbId,
      claudeSessionId,
      sdkSessionId: dbSession.sdk_session_id || null, // Set from database since we set both fields now
      project,
      userPrompt,
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 0,
      observationCounter: 0,
      startTime: Date.now()
    };

    this.sessions.set(sessionDbId, session);

    // Update port in database
    db.setWorkerPort(sessionDbId, this.port!);
    db.close();

    // Start SDK agent in background
    session.generatorPromise = this.runSDKAgent(session).catch(err => {
      logger.failure('WORKER', 'SDK agent error', { sessionId: sessionDbId }, err);
      const db = new SessionStore();
      db.markSessionFailed(sessionDbId);
      db.close();
      this.sessions.delete(sessionDbId);
    });

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
      // Auto-create session if it doesn't exist (e.g., worker restarted)
      // Fetch real session ID from database
      const db = new SessionStore();
      const dbSession = db.getSessionById(sessionDbId);
      db.close();

      const claudeSessionId = dbSession?.sdk_session_id || `session-${sessionDbId}`;

      session = {
        sessionDbId,
        claudeSessionId,
        sdkSessionId: null,
        project: dbSession?.project || '',
        userPrompt: dbSession?.user_prompt || '',
        pendingMessages: [],
        abortController: new AbortController(),
        generatorPromise: null,
        lastPromptNumber: 0,
        observationCounter: 0,
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

    // Create correlation ID for tracking this observation
    session.observationCounter++;
    const correlationId = logger.correlationId(sessionDbId, session.observationCounter);
    const toolStr = logger.formatTool(tool_name, tool_input);

    logger.dataIn('WORKER', `Observation queued: ${toolStr}`, {
      correlationId,
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
      // Auto-create session if it doesn't exist (e.g., worker restarted)
      // Fetch real session ID from database
      const db = new SessionStore();
      const dbSession = db.getSessionById(sessionDbId);
      db.close();

      const claudeSessionId = dbSession?.sdk_session_id || `session-${sessionDbId}`;

      session = {
        sessionDbId,
        claudeSessionId,
        sdkSessionId: null,
        project: dbSession?.project || '',
        userPrompt: dbSession?.user_prompt || '',
        pendingMessages: [],
        abortController: new AbortController(),
        generatorPromise: null,
        lastPromptNumber: 0,
        observationCounter: 0,
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
   * DELETE /sessions/:sessionDbId
   */
  private async handleDelete(req: Request, res: Response): Promise<void> {
    const sessionDbId = parseInt(req.params.sessionDbId, 10);

    const session = this.sessions.get(sessionDbId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    logger.warn('WORKER', 'Session delete requested', { sessionId: sessionDbId });

    // Abort SDK agent
    session.abortController.abort();

    // Wait for generator to finish (with timeout)
    if (session.generatorPromise) {
      await Promise.race([
        session.generatorPromise,
        new Promise(resolve => setTimeout(resolve, 5000))
      ]);
    }

    // Mark as failed since we're aborting
    const db = new SessionStore();
    db.markSessionFailed(sessionDbId);
    db.close();

    this.sessions.delete(sessionDbId);

    logger.info('WORKER', 'Session deleted', { sessionId: sessionDbId });
    res.json({ status: 'deleted' });
  }

  /**
   * Run SDK agent for a session
   */
  private async runSDKAgent(session: ActiveSession): Promise<void> {
    logger.info('SDK', 'Agent starting', { sessionId: session.sessionDbId });

    const claudePath = process.env.CLAUDE_CODE_PATH || '/Users/alexnewman/.nvm/versions/node/v24.5.0/bin/claude';

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
        // Handle system init message
        if (message.type === 'system' && message.subtype === 'init') {
          const systemMsg = message as SDKSystemMessage;
          if (systemMsg.session_id) {
            // Update in database first, check if it succeeded
            const db = new SessionStore();
            const updated = db.updateSDKSessionId(session.sessionDbId, systemMsg.session_id);
            db.close();

            if (updated) {
              logger.success('SDK', 'Session initialized', {
                sessionId: session.sessionDbId,
                sdkSessionId: systemMsg.session_id
              });
              session.sdkSessionId = systemMsg.session_id;
            }
          }
        }
        // Handle assistant messages
        else if (message.type === 'assistant') {
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

          // Parse and store with prompt number
          this.handleAgentMessage(session, textContent, session.lastPromptNumber);
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
          const dbSession = db.getSessionById(session.sessionDbId) as SDKSession | undefined;
          db.close();

          if (dbSession) {
            const summarizePrompt = buildSummaryPrompt(dbSession);

            logger.dataIn('SDK', `Summary prompt sent (${summarizePrompt.length} chars)`, {
              sessionId: session.sessionDbId,
              promptNumber: message.prompt_number
            });
            logger.debug('SDK', 'Full summary prompt', { sessionId: session.sessionDbId }, summarizePrompt);

            yield {
              type: 'user',
              session_id: session.claudeSessionId, // Use real session ID
              parent_tool_use_id: null,
              message: {
                role: 'user',
                content: summarizePrompt
              }
            };
          }
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
          const correlationId = logger.correlationId(session.sessionDbId, session.observationCounter);

          logger.dataIn('SDK', `Observation prompt: ${toolStr}`, {
            correlationId,
            promptNumber: message.prompt_number,
            size: `${observationPrompt.length} chars`
          });
          logger.debug('SDK', 'Full observation prompt', { correlationId }, observationPrompt);

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
    const correlationId = logger.correlationId(session.sessionDbId, session.observationCounter);

    // Parse observations
    const observations = parseObservations(content, correlationId);

    if (observations.length > 0) {
      logger.info('PARSER', `Parsed ${observations.length} observation(s)`, {
        correlationId,
        promptNumber,
        types: observations.map(o => o.type).join(', ')
      });
    }

    const db = new SessionStore();
    for (const obs of observations) {
      if (session.sdkSessionId) {
        db.storeObservation(session.sdkSessionId, session.project, obs, promptNumber);
        logger.success('DB', 'Observation stored', {
          correlationId,
          type: obs.type,
          title: obs.title
        });
      }
    }

    // Parse summary
    const summary = parseSummary(content, session.sessionDbId);
    if (summary && session.sdkSessionId) {
      logger.info('PARSER', 'Summary parsed', {
        sessionId: session.sessionDbId,
        promptNumber
      });

      db.storeSummary(session.sdkSessionId, session.project, summary, promptNumber);
      logger.success('DB', 'Summary stored', { sessionId: session.sessionDbId });
    }

    db.close();
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
