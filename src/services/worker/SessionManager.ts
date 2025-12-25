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
import { PendingMessageStore } from '../sqlite/PendingMessageStore.js';

export class SessionManager {
  private dbManager: DatabaseManager;
  private sessions: Map<number, ActiveSession> = new Map();
  private sessionQueues: Map<number, EventEmitter> = new Map();
  private onSessionDeletedCallback?: () => void;
  private pendingStore: PendingMessageStore | null = null;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  /**
   * Get or create PendingMessageStore (lazy initialization to avoid circular dependency)
   */
  private getPendingStore(): PendingMessageStore {
    if (!this.pendingStore) {
      const sessionStore = this.dbManager.getSessionStore();
      this.pendingStore = new PendingMessageStore(sessionStore.db, 3);
    }
    return this.pendingStore;
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
    // Check if already active
    let session = this.sessions.get(sessionDbId);
    if (session) {
      // Refresh project from database in case it was updated by new-hook
      // This fixes the bug where sessions created with empty project get updated
      // in the database but the in-memory session still has the stale empty value
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
      } else {
        logger.debug('SESSION', 'No currentUserPrompt provided for existing session', {
          sessionDbId,
          promptNumber,
          usingCachedPrompt: session.userPrompt.substring(0, 80)
        });
      }
      return session;
    }

    // Fetch from database
    const dbSession = this.dbManager.getSessionById(sessionDbId);

    // Use currentUserPrompt if provided, otherwise fall back to database (first prompt)
    const userPrompt = currentUserPrompt || dbSession.user_prompt;

    if (!currentUserPrompt) {
      logger.debug('SESSION', 'No currentUserPrompt provided for new session, using database', {
        sessionDbId,
        promptNumber,
        dbPrompt: dbSession.user_prompt.substring(0, 80)
      });
    } else {
      logger.debug('SESSION', 'Initializing session with fresh userPrompt', {
        sessionDbId,
        promptNumber,
        userPrompt: currentUserPrompt.substring(0, 80)
      });
    }

    // Create active session
    session = {
      sessionDbId,
      claudeSessionId: dbSession.claude_session_id,
      sdkSessionId: null,
      project: dbSession.project,
      userPrompt,
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: promptNumber || this.dbManager.getSessionStore().getPromptNumberFromUserPrompts(dbSession.claude_session_id),
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      pendingProcessingIds: new Set(),
      earliestPendingTimestamp: null
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
   *
   * CRITICAL: Persists to database FIRST before adding to in-memory queue.
   * This ensures observations survive worker crashes.
   */
  queueObservation(sessionDbId: number, data: ObservationData): void {
    // Auto-initialize from database if needed (handles worker restarts)
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const beforeDepth = session.pendingMessages.length;

    // CRITICAL: Persist to database FIRST
    const message: PendingMessage = {
      type: 'observation',
      tool_name: data.tool_name,
      tool_input: data.tool_input,
      tool_response: data.tool_response,
      prompt_number: data.prompt_number,
      cwd: data.cwd
    };

    try {
      const messageId = this.getPendingStore().enqueue(sessionDbId, session.claudeSessionId, message);
      logger.debug('SESSION', `Observation persisted to DB`, {
        sessionId: sessionDbId,
        messageId,
        tool: data.tool_name
      });
    } catch (error) {
      logger.error('SESSION', 'Failed to persist observation to DB', {
        sessionId: sessionDbId,
        tool: data.tool_name
      }, error);
      throw error; // Don't continue if we can't persist
    }

    // Add to in-memory queue (for backward compatibility with existing iterator)
    session.pendingMessages.push(message);

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
   *
   * CRITICAL: Persists to database FIRST before adding to in-memory queue.
   * This ensures summarize requests survive worker crashes.
   */
  queueSummarize(sessionDbId: number, lastUserMessage: string, lastAssistantMessage?: string): void {
    // Auto-initialize from database if needed (handles worker restarts)
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const beforeDepth = session.pendingMessages.length;

    // CRITICAL: Persist to database FIRST
    const message: PendingMessage = {
      type: 'summarize',
      last_user_message: lastUserMessage,
      last_assistant_message: lastAssistantMessage
    };

    try {
      const messageId = this.getPendingStore().enqueue(sessionDbId, session.claudeSessionId, message);
      logger.debug('SESSION', `Summarize persisted to DB`, {
        sessionId: sessionDbId,
        messageId
      });
    } catch (error) {
      logger.error('SESSION', 'Failed to persist summarize to DB', {
        sessionId: sessionDbId
      }, error);
      throw error; // Don't continue if we can't persist
    }

    // Add to in-memory queue (for backward compatibility with existing iterator)
    session.pendingMessages.push(message);

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
   * Check if any session is actively processing (has pending messages OR active generator)
   * Used for activity indicator to prevent spinner from stopping while SDK is processing
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
   * Get message iterator for SDKAgent to consume (event-driven, no polling)
   * Auto-initializes session if not in memory but exists in database
   *
   * CRITICAL: Uses PendingMessageStore for crash-safe message persistence.
   * Messages are marked as 'processing' when yielded and must be marked 'processed'
   * by the SDK agent after successful completion.
   */
  async *getMessageIterator(sessionDbId: number): AsyncIterableIterator<PendingMessageWithId> {
    // Auto-initialize from database if needed (handles worker restarts)
    let session = this.sessions.get(sessionDbId);
    if (!session) {
      session = this.initializeSession(sessionDbId);
    }

    const emitter = this.sessionQueues.get(sessionDbId);
    if (!emitter) {
      throw new Error(`No emitter for session ${sessionDbId}`);
    }

    // Linger timeout: how long to wait for new messages before exiting
    // This keeps the agent alive between messages, reducing "No active agent" windows
    const LINGER_TIMEOUT_MS = 5000; // 5 seconds

    while (!session.abortController.signal.aborted) {
      // Check for pending messages in persistent store
      const persistentMessage = this.getPendingStore().peekPending(sessionDbId);

      if (!persistentMessage) {
        // Wait for new messages with timeout
        const gotMessage = await new Promise<boolean>(resolve => {
          let resolved = false;

          const messageHandler = () => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeoutId);
              resolve(true);
            }
          };

          const timeoutHandler = () => {
            if (!resolved) {
              resolved = true;
              emitter.off('message', messageHandler);
              resolve(false);
            }
          };

          const timeoutId = setTimeout(timeoutHandler, LINGER_TIMEOUT_MS);

          emitter.once('message', messageHandler);

          // Also listen for abort
          session.abortController.signal.addEventListener('abort', () => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeoutId);
              emitter.off('message', messageHandler);
              resolve(false);
            }
          }, { once: true });
        });

        // Re-check for messages after waking up (handles race condition)
        const recheckMessage = this.getPendingStore().peekPending(sessionDbId);
        if (recheckMessage) {
          // Got a message, continue processing
          continue;
        }

        if (!gotMessage) {
          // Timeout or abort - exit the loop
          logger.info('SESSION', `Generator exiting after linger timeout`, { sessionId: sessionDbId });
          return;
        }

        continue;
      }

      // Mark as processing BEFORE yielding (status: pending -> processing)
      this.getPendingStore().markProcessing(persistentMessage.id);

      // Track this message ID for completion marking
      session.pendingProcessingIds.add(persistentMessage.id);

      // Track earliest timestamp for accurate observation timestamps
      // This ensures backlog messages get their original timestamps, not current time
      if (session.earliestPendingTimestamp === null) {
        session.earliestPendingTimestamp = persistentMessage.created_at_epoch;
      } else {
        session.earliestPendingTimestamp = Math.min(session.earliestPendingTimestamp, persistentMessage.created_at_epoch);
      }

      // Convert to PendingMessageWithId and yield
      // Include original timestamp for accurate observation timestamps (survives stuck processing)
      const message: PendingMessageWithId = {
        _persistentId: persistentMessage.id,
        _originalTimestamp: persistentMessage.created_at_epoch,
        ...this.getPendingStore().toPendingMessage(persistentMessage)
      };

      // Also add to in-memory queue for backward compatibility (status tracking)
      session.pendingMessages.push(message);

      yield message;

      // Remove from in-memory queue after yielding
      session.pendingMessages.shift();

      // If we just yielded a summary, that's the end of this batch - stop the iterator
      if (message.type === 'summarize') {
        logger.info('SESSION', `Summary yielded - ending generator`, { sessionId: sessionDbId });
        return;
      }
    }
  }

  /**
   * Get the PendingMessageStore (for SDKAgent to mark messages as processed)
   */
  getPendingMessageStore(): PendingMessageStore {
    return this.getPendingStore();
  }
}
