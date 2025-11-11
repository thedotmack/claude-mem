/**
 * SessionManager: Event-driven session lifecycle
 *
 * Responsibility:
 * - Manage active session lifecycle
 * - Handle event-driven message queues
 * - Coordinate between HTTP requests and SDK agent
 * - Zero-latency event notification (no polling)
 */

import { EventEmitter } from 'events';
import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession, PendingMessage, ObservationData } from '../worker-types.js';

export class SessionManager {
  private dbManager: DatabaseManager;
  private sessions: Map<number, ActiveSession> = new Map();
  private sessionQueues: Map<number, EventEmitter> = new Map();

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  /**
   * Initialize a new session or return existing one
   */
  initializeSession(sessionDbId: number): ActiveSession {
    // Check if already active
    let session = this.sessions.get(sessionDbId);
    if (session) {
      return session;
    }

    // Fetch from database
    const dbSession = this.dbManager.getSessionById(sessionDbId);

    // Create active session
    session = {
      sessionDbId,
      claudeSessionId: dbSession.claude_session_id,
      sdkSessionId: null,
      project: dbSession.project,
      userPrompt: dbSession.user_prompt,
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: this.dbManager.getSessionStore().getPromptCounter(sessionDbId),
      startTime: Date.now()
    };

    this.sessions.set(sessionDbId, session);

    // Create event emitter for queue notifications
    const emitter = new EventEmitter();
    this.sessionQueues.set(sessionDbId, emitter);

    logger.info('SESSION', 'Session initialized', {
      sessionId: sessionDbId,
      project: session.project,
      claudeSessionId: session.claudeSessionId,
      queueDepth: 0,
      hasGenerator: false
    });

    return session;
  }

  /**
   * Get active session by ID
   */
  getSession(sessionDbId: number): ActiveSession | undefined {
    return this.sessions.get(sessionDbId);
  }

  /**
   * Queue an observation for processing (zero-latency notification)
   * Auto-initializes session if not in memory but exists in database
   */
  queueObservation(sessionDbId: number, data: ObservationData): void {
    // Auto-initialize from database if needed (handles worker restarts)
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const beforeDepth = session.pendingMessages.length;

    session.pendingMessages.push({
      type: 'observation',
      tool_name: data.tool_name,
      tool_input: data.tool_input,
      tool_response: data.tool_response,
      prompt_number: data.prompt_number
    });

    const afterDepth = session.pendingMessages.length;

    // Notify generator immediately (zero latency)
    const emitter = this.sessionQueues.get(sessionDbId);
    emitter?.emit('message');

    // Format tool name for logging
    const toolSummary = logger.formatTool(data.tool_name, data.tool_input);

    logger.info('SESSION', `Observation queued (${beforeDepth}→${afterDepth})`, {
      sessionId: sessionDbId,
      tool: toolSummary,
      hasGenerator: !!session.generatorPromise
    });
  }

  /**
   * Queue a summarize request (zero-latency notification)
   * Auto-initializes session if not in memory but exists in database
   */
  queueSummarize(sessionDbId: number): void {
    // Auto-initialize from database if needed (handles worker restarts)
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const beforeDepth = session.pendingMessages.length;

    session.pendingMessages.push({ type: 'summarize' });

    const afterDepth = session.pendingMessages.length;

    const emitter = this.sessionQueues.get(sessionDbId);
    emitter?.emit('message');

    logger.info('SESSION', `Summarize queued (${beforeDepth}→${afterDepth})`, {
      sessionId: sessionDbId,
      hasGenerator: !!session.generatorPromise
    });
  }

  /**
   * Delete a session (abort SDK agent and cleanup)
   */
  async deleteSession(sessionDbId: number): Promise<void> {
    const session = this.sessions.get(sessionDbId);
    if (!session) {
      return; // Already deleted
    }

    const sessionDuration = Date.now() - session.startTime;

    // Abort the SDK agent
    session.abortController.abort();

    // Wait for generator to finish
    if (session.generatorPromise) {
      await session.generatorPromise.catch(() => {});
    }

    // Cleanup
    this.sessions.delete(sessionDbId);
    this.sessionQueues.delete(sessionDbId);

    logger.info('SESSION', 'Session deleted', {
      sessionId: sessionDbId,
      duration: `${(sessionDuration / 1000).toFixed(1)}s`,
      project: session.project
    });
  }

  /**
   * Shutdown all active sessions
   */
  async shutdownAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map(id => this.deleteSession(id)));
  }

  /**
   * Check if any session has pending messages (for spinner tracking)
   */
  hasPendingMessages(): boolean {
    return Array.from(this.sessions.values()).some(
      session => session.pendingMessages.length > 0
    );
  }

  /**
   * Get number of active sessions (for stats)
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get message iterator for SDKAgent to consume (event-driven, no polling)
   * Auto-initializes session if not in memory but exists in database
   */
  async *getMessageIterator(sessionDbId: number): AsyncIterableIterator<PendingMessage> {
    // Auto-initialize from database if needed (handles worker restarts)
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const emitter = this.sessionQueues.get(sessionDbId);
    if (!emitter) {
      throw new Error(`No emitter for session ${sessionDbId}`);
    }

    while (!session.abortController.signal.aborted) {
      // Wait for messages if queue is empty
      if (session.pendingMessages.length === 0) {
        await new Promise<void>(resolve => {
          const handler = () => resolve();
          emitter.once('message', handler);

          // Also listen for abort
          session.abortController.signal.addEventListener('abort', () => {
            emitter.off('message', handler);
            resolve();
          }, { once: true });
        });
      }

      // Yield all pending messages
      while (session.pendingMessages.length > 0) {
        const message = session.pendingMessages.shift()!;
        yield message;
      }
    }
  }
}
