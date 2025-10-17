/**
 * Worker Service - Long-running HTTP service managed by PM2
 * Replaces detached Bun worker processes with single persistent Node service
 */

import express, { Request, Response } from 'express';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { HooksDatabase } from './sqlite/HooksDatabase.js';
import { buildInitPrompt, buildObservationPrompt, buildFinalizePrompt } from '../sdk/prompts.js';
import { parseObservations, parseSummary } from '../sdk/parser.js';
import type { SDKSession } from '../sdk/prompts.js';
import { findAvailablePort } from '../utils/port-allocator.js';

const MODEL = 'claude-sonnet-4-5';
const DISALLOWED_TOOLS = ['Glob', 'Grep', 'ListMcpResourcesTool', 'WebSearch'];

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
  sdkSessionId: string | null;
  project: string;
  userPrompt: string;
  pendingMessages: WorkerMessage[];
  abortController: AbortController;
  generatorPromise: Promise<void> | null;
  lastPromptNumber: number; // Track which prompt_number we last sent to SDK
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
    // Find available port
    const port = await findAvailablePort();
    if (!port) {
      throw new Error('No available ports in range 37000-37999');
    }

    this.port = port;

    // Clean up orphaned sessions from previous worker instances
    const db = new HooksDatabase();
    const cleanedCount = db.cleanupOrphanedSessions();
    db.close();

    if (cleanedCount > 0) {
      console.log(`[WorkerService] Cleaned up ${cleanedCount} orphaned sessions`);
    }

    return new Promise((resolve, reject) => {
      this.app.listen(port, '127.0.0.1', () => {
        console.log(`[WorkerService] Started on http://127.0.0.1:${port}`);
        console.log(`[WorkerService] PID: ${process.pid}`);
        console.log(`[WorkerService] Active sessions: ${this.sessions.size}`);

        // Write port to file for hooks to discover
        const { writeFileSync } = require('fs');
        const { join } = require('path');
        const { homedir } = require('os');
        const portFile = join(homedir(), '.claude-mem', 'worker.port');
        writeFileSync(portFile, port.toString(), 'utf8');

        resolve();
      }).on('error', reject);
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

    console.log(`[WorkerService] Initializing session ${sessionDbId}`, { project });

    if (this.sessions.has(sessionDbId)) {
      res.status(409).json({ error: 'Session already exists' });
      return;
    }

    // Create session state
    const session: ActiveSession = {
      sessionDbId,
      sdkSessionId: null,
      project,
      userPrompt,
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 0
    };

    this.sessions.set(sessionDbId, session);

    // Update port in database
    const db = new HooksDatabase();
    db.setWorkerPort(sessionDbId, this.port!);
    db.close();

    // Start SDK agent in background
    session.generatorPromise = this.runSDKAgent(session).catch(err => {
      console.error(`[WorkerService] SDK agent error for session ${sessionDbId}:`, err);
      const db = new HooksDatabase();
      db.markSessionFailed(sessionDbId);
      db.close();
      this.sessions.delete(sessionDbId);
    });

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

    const session = this.sessions.get(sessionDbId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    console.log(`[WorkerService] Queueing observation for session ${sessionDbId}:`, tool_name);

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

    const session = this.sessions.get(sessionDbId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    console.log(`[WorkerService] Requesting summary for session ${sessionDbId}, prompt #${prompt_number}`);

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

    console.error(`[WorkerService] Deleting session ${sessionDbId}`);

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
    const db = new HooksDatabase();
    db.markSessionFailed(sessionDbId);
    db.close();

    this.sessions.delete(sessionDbId);

    res.json({ status: 'deleted' });
  }

  /**
   * Run SDK agent for a session
   */
  private async runSDKAgent(session: ActiveSession): Promise<void> {
    console.log(`[WorkerService] Starting SDK agent for session ${session.sessionDbId}`);

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
            const db = new HooksDatabase();
            const updated = db.updateSDKSessionId(session.sessionDbId, systemMsg.session_id);
            db.close();

            if (updated) {
              console.log(`[WorkerService] SDK session initialized:`, systemMsg.session_id);
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

          console.log(`[WorkerService] SDK response for prompt #${session.lastPromptNumber}:\n${textContent}`);

          // Parse and store with prompt number
          this.handleAgentMessage(session, textContent, session.lastPromptNumber);
        }
      }

      // Mark completed
      console.log(`[WorkerService] SDK agent completed for session ${session.sessionDbId}`);
      const db = new HooksDatabase();
      db.markSessionCompleted(session.sessionDbId);
      db.close();

      this.sessions.delete(session.sessionDbId);

    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.error(`[WorkerService] SDK agent aborted for session ${session.sessionDbId}`);
      } else {
        console.error(`[WorkerService] SDK agent error for session ${session.sessionDbId}:`, error);
      }
      throw error;
    }
  }

  /**
   * Create async message generator for SDK streaming
   * Keeps running continuously - no finalize, agent stays alive for entire Claude Code session
   */
  private async* createMessageGenerator(session: ActiveSession): AsyncIterable<SDKUserMessage> {
    const claudeSessionId = `session-${session.sessionDbId}`;
    const initPrompt = buildInitPrompt(session.project, claudeSessionId, session.userPrompt);

    console.log(`[WorkerService] Yielding init prompt:\n${initPrompt}`);

    yield {
      type: 'user',
      session_id: session.sdkSessionId || claudeSessionId,
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
          console.log(`[WorkerService] Processing SUMMARIZE for session ${session.sessionDbId}, prompt #${message.prompt_number}`);
          session.lastPromptNumber = message.prompt_number;

          const db = new HooksDatabase();
          const dbSession = db.getSessionById(session.sessionDbId) as SDKSession | undefined;
          db.close();

          if (dbSession) {
            const summarizePrompt = `You have been processing tool observations for this session. Please generate a summary of what you've learned from prompt #${message.prompt_number}.

Use this XML format:

<session_summary>
  <request>What was the user trying to accomplish in this prompt?</request>
  <investigated>What code/systems did you explore?</investigated>
  <learned>What did you learn about the codebase?</learned>
  <completed>What was done or determined?</completed>
  <next_steps>What should happen next?</next_steps>
  <files_read>["file1.ts", "file2.ts"]</files_read>
  <files_edited>["file3.ts"]</files_edited>
  <notes>Any additional context or insights</notes>
</session_summary>

Respond ONLY with the XML block. Be concise and specific.`;

            console.log(`[WorkerService] Yielding summarize prompt:\n${summarizePrompt}`);

            yield {
              type: 'user',
              session_id: session.sdkSessionId || claudeSessionId,
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

          console.log(`[WorkerService] Yielding observation (prompt #${message.prompt_number}):\n${observationPrompt}`);

          yield {
            type: 'user',
            session_id: session.sdkSessionId || claudeSessionId,
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
    // Parse observations
    const observations = parseObservations(content);
    console.log(`[WorkerService] Parsed ${observations.length} observations for prompt #${promptNumber}`);

    const db = new HooksDatabase();
    for (const obs of observations) {
      if (session.sdkSessionId) {
        db.storeObservation(session.sdkSessionId, session.project, obs.type, obs.text, promptNumber);
      }
    }

    // Parse summary
    const summary = parseSummary(content);
    if (summary && session.sdkSessionId) {
      console.log(`[WorkerService] Parsed summary for session ${session.sessionDbId}, prompt #${promptNumber}`);

      const summaryWithArrays = {
        request: summary.request,
        investigated: summary.investigated,
        learned: summary.learned,
        completed: summary.completed,
        next_steps: summary.next_steps,
        files_read: JSON.stringify(summary.files_read),
        files_edited: JSON.stringify(summary.files_edited),
        notes: summary.notes
      };

      db.storeSummary(session.sdkSessionId, session.project, summaryWithArrays, promptNumber);
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
    console.error('[WorkerService] Shutting down gracefully...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.error('[WorkerService] Shutting down gracefully...');
    process.exit(0);
  });
}

// Auto-start when run directly (not when imported)
main().catch(err => {
  console.error('[WorkerService] Fatal error:', err);
  process.exit(1);
});

export { WorkerService };
