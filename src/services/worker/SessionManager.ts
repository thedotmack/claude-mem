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
import type { ActiveSession, PendingMessage, PendingMessageWithId, ObservationData } from '../worker-types.js';

export class SessionManager {
  private dbManager: DatabaseManager;
  private sessions: Map<number, ActiveSession> = new Map();
  private sessionQueues: Map<number, EventEmitter> = new Map();
  private onSessionDeletedCallback?: () => void;

  // Counter for ephemeral message IDs (since we aren't using DB IDs anymore)
  private nextMessageId = 1;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  /**
   * Set callback to be called when a session is deleted (for broadcasting status)
   */
  setOnSessionDeleted(callback: () => void): void {
    this.onSessionDeletedCallback = callback;
  }

  /**
   * Initialize a new session or return existing one
   */
  initializeSession(sessionDbId: number, currentUserPrompt?: string, promptNumber?: number): ActiveSession {
    logger.info('SESSION', 'initializeSession called', {
      sessionDbId,
      promptNumber,
      has_currentUserPrompt: !!currentUserPrompt
    });

    // Check if already active
    let session = this.sessions.get(sessionDbId);
    if (session) {
      logger.info('SESSION', 'Returning cached session', {
        sessionDbId,
        contentSessionId: session.contentSessionId,
        lastPromptNumber: session.lastPromptNumber
      });

      // Refresh project from database in case it was updated by new-hook
      const dbSession = this.dbManager.getSessionById(sessionDbId);
      if (dbSession.project && dbSession.project !== session.project) {
        logger.debug('SESSION', 'Updating project from database', {
          sessionDbId,
          oldProject: session.project,
          newProject: dbSession.project
        });
        session.project = dbSession.project;
      }

      // Update userPrompt for continuation prompts
      if (currentUserPrompt) {
        logger.debug('SESSION', 'Updating userPrompt for continuation', {
          sessionDbId,
          promptNumber,
          oldPrompt: session.userPrompt.substring(0, 80),
          newPrompt: currentUserPrompt.substring(0, 80)
        });
        session.userPrompt = currentUserPrompt;
        session.lastPromptNumber = promptNumber || session.lastPromptNumber;
      }
      return session;
    }

    // Fetch from database
    const dbSession = this.dbManager.getSessionById(sessionDbId);

    logger.info('SESSION', 'Fetched session from database', {
      sessionDbId,
      content_session_id: dbSession.content_session_id,
      memory_session_id: dbSession.memory_session_id
    });

    // Use currentUserPrompt if provided, otherwise fall back to database (first prompt)
    const userPrompt = currentUserPrompt || dbSession.user_prompt;

    // Create active session
    // Load memorySessionId from database if previously captured (enables resume across restarts)
    session = {
      sessionDbId,
      contentSessionId: dbSession.content_session_id,
      memorySessionId: dbSession.memory_session_id || null,
      project: dbSession.project,
      userPrompt,
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.content_session_id),
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      pendingProcessingIds: new Set(),
      earliestPendingTimestamp: null,
      conversationHistory: [],
      currentProvider: null
    };

    logger.info('SESSION', 'Creating new session object', {
      sessionDbId,
      contentSessionId: dbSession.content_session_id,
      memorySessionId: dbSession.memory_session_id || '(none - fresh session)',
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.content_session_id)
    });

    this.sessions.set(sessionDbId, session);

    // Create event emitter for queue notifications
    const emitter = new EventEmitter();
    this.sessionQueues.set(sessionDbId, emitter);

    logger.info('SESSION', 'Session initialized', {
      sessionId: sessionDbId,
      project: session.project,
      contentSessionId: session.contentSessionId,
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

    const message: PendingMessage = {
      type: 'observation',
      tool_name: data.tool_name,
      tool_input: data.tool_input,
      tool_response: data.tool_response,
      prompt_number: data.prompt_number,
      cwd: data.cwd
    };

    // Push to in-memory queue
    session.pendingMessages.push(message);

    // Notify generator immediately (zero latency)
    const emitter = this.sessionQueues.get(sessionDbId);
    emitter?.emit('message');

    // Format tool name for logging
    const toolSummary = logger.formatTool(data.tool_name, data.tool_input);

    logger.info('SESSION', `Observation queued`, {
      sessionId: sessionDbId,
      tool: toolSummary,
      hasGenerator: !!session.generatorPromise,
      queueDepth: session.pendingMessages.length
    });
  }

  /**
   * Queue a summarize request (zero-latency notification)
   * Auto-initializes session if not in memory but exists in database
   */
  queueSummarize(sessionDbId: number, lastUserMessage: string, lastAssistantMessage?: string): void {
    // Auto-initialize from database if needed (handles worker restarts)
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const message: PendingMessage = {
      type: 'summarize',
      last_user_message: lastUserMessage,
      last_assistant_message: lastAssistantMessage
    };

    // Push to in-memory queue
    session.pendingMessages.push(message);

    const emitter = this.sessionQueues.get(sessionDbId);
    emitter?.emit('message');

    logger.info('SESSION', `Summarize queued`, {
      sessionId: sessionDbId,
      hasGenerator: !!session.generatorPromise,
      queueDepth: session.pendingMessages.length
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

    // Trigger callback to broadcast status update (spinner may need to stop)
    if (this.onSessionDeletedCallback) {
      this.onSessionDeletedCallback();
    }
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
    // Check all active sessions for pending messages
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
   * Get total queue depth across all sessions (for activity indicator)
   */
  getTotalQueueDepth(): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      total += session.pendingMessages.length;
    }
    return total;
  }

  /**
   * Get total active work (queued + currently processing)
   * Counts both pending messages and items actively being processed by SDK agents
   */
  getTotalActiveWork(): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      // Count queued messages
      total += session.pendingMessages.length;
      // Count currently processing item (1 per active generator)
      if (session.generatorPromise !== null) {
        total += 1;
      }
    }
    return total;
  }

  /**
   * Get all pending messages across all sessions (for UI display)
   */
  getAllPendingMessages(): Array<PendingMessage & { project: string; sessionDbId: number }> {
    const messages: Array<PendingMessage & { project: string; sessionDbId: number }> = [];
    
    for (const session of this.sessions.values()) {
      for (const msg of session.pendingMessages) {
        messages.push({
          ...msg,
          project: session.project,
          sessionDbId: session.sessionDbId
        });
      }
    }
    
    return messages;
  }

  /**
   * Check if any session is actively processing (has pending messages OR active generator)
   */
  isAnySessionProcessing(): boolean {
    for (const session of this.sessions.values()) {
      // Has queued messages waiting to be processed
      if (session.pendingMessages.length > 0) {
        return true;
      }
      // Has active SDK generator running (processing dequeued messages)
      if (session.generatorPromise !== null) {
        return true;
      }
    }
    return false;
  }

  /**
   * Convert pending message to message with ephemeral ID
   */
  private toPendingMessageWithId(msg: PendingMessage): PendingMessageWithId {
    return {
      ...msg,
      _persistentId: this.nextMessageId++,
      _originalTimestamp: Date.now() // We lose original timestamp for in-memory messages if not stored
    };
  }

  /**
   * Wait for next message from queue (replaces getMessageIterator)
   * Returns next message or null if session aborted
   */
  async waitForNextMessage(sessionDbId: number, signal: AbortSignal): Promise<PendingMessageWithId | null> {
    // Auto-initialize from database if needed (handles worker restarts)
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const emitter = this.sessionQueues.get(sessionDbId);
    if (!emitter) {
      throw new Error(`No emitter for session ${sessionDbId}`);
    }

    while (!signal.aborted) {
      // 1. Check if message is already available
      if (session.pendingMessages.length > 0) {
        const message = session.pendingMessages.shift()!;
        const msgWithId = this.toPendingMessageWithId(message);
        
        // Track ID/Timestamp for compatibility with Agent code
        // (Though in-memory queue doesn't need "marking processed")
        session.pendingProcessingIds.add(msgWithId._persistentId);
        
        if (session.earliestPendingTimestamp === null) {
            session.earliestPendingTimestamp = msgWithId._originalTimestamp;
        }
        
        return msgWithId;
      }

      // 2. Queue empty - wait for wake-up event
      await new Promise<void>((resolve) => {
        const onMessage = () => {
          cleanup();
          resolve();
        };

        const onAbort = () => {
          cleanup();
          resolve();
        };

        const cleanup = () => {
          emitter.off('message', onMessage);
          signal.removeEventListener('abort', onAbort);
        };

        emitter.once('message', onMessage);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    return null;
  }

  /**
   * Get the PendingMessageStore (kept for compatibility but throws error)
   * We shouldn't need this anymore as we use in-memory queue
   */
  getPendingMessageStore(): any {
    return {
      // Mock store that does nothing for markProcessed/cleanupProcessed
      markProcessed: () => {},
      cleanupProcessed: () => 0,
      resetStuckMessages: () => 0
    };
  }
}